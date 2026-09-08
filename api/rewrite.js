import { callLLM } from '../lib/llm.js'
import { strategyAgent } from '../lib/agents/strategy-agent.js'

const hits = new Map()
function limited(ip){
  const now = Date.now(), w = 60000, max = 20
  const e = hits.get(ip) || { n: 0, ts: now }
  if (now - e.ts > w) { e.n = 0; e.ts = now }
  e.n++; hits.set(ip, e)
  return e.n > max
}

const SYSTEM_PROMPT = `你是“关系表达改写 Agent”。
用户已经写好一句准备对 TA 说的话，现在只想在发出去之前，把这句话换一种更合适的说法。

你的任务只有一个：改写【用户原话】。

【最重要的产品边界】
这不是“接着回应”功能。
你绝对不能回答 TA，也不能根据 TA 说过的话写下一句。
本次任务中，TA 的任何上一轮回答都不作为输入，也不需要考虑。
你只能根据“用户原话 + TA 的关系/沟通特点 + 当前情境”重新表达用户原本想说的话。

【严格要求】
1. 输出必须仍然是用户准备发给 TA 的原话，而不是对 TA 某句话的回应。
2. 三个版本都必须保留用户原话的核心意图、事实和诉求。
3. 不得新增用户没有提供的事实、经历、承诺、道歉、表白或新的立场。
4. 不得凭空增加“我知道你……”“你说没事……”“既然你……”“你刚才……”“我理解你……”等对方已经做过某件事的内容。
5. 不得写成“解释上一轮”“接住对方情绪”“回应对方观点”的下一句。
6. 不得把用户原话改成完全不同的新诉求。
7. 每个版本必须和原话有实质表达差异，但核心意思不变。
8. 必须像真实聊天，1-3句，口语化；不要心理咨询、客服或 AI 话术。

【三个改写方向】
- 自然直接：保留原话意思和直接感，让表达更自然、清楚。
- 回应阻力：不是回应 TA，而是根据关系和 TA 的沟通特点，提前把原话中可能让 TA 误解或防御的地方说得更清楚；仍然只能围绕原话已有信息。
- 降低防御：保留原本真实诉求，只降低指责、逼问或突兀感；不能取消用户真正想表达的内容。

【非常重要的反例】
原话：“我昨天说话有点过了，没过脑子。”
错误：“你说没事，但我还是想解释一下……”
原因：这已经在回应 TA 的话，不是改写原话。

原话：“你至于因为这点事跟我冷战这么久吗？”
正确方向：“我就是觉得这点事不值得我们冷战这么久，咱们把话说开吧。”
错误方向：“我知道你等我先找你好几天了，那天我说话确实不对……”
原因：加入了原话没有提供的上一轮事实/回应。

【自检】
生成每条后逐条检查：
- 只看“用户原话”，这句话是否仍然成立？
- 如果没有任何 TA 的回答，这句话能否直接发送给 TA？必须可以。
- 这句话是否只是重新表达原意？如果它在回答、承接或解释 TA 的某句话，必须删除并重写。
- 是否出现了原话没有提供的新事实？如果有，删除。

【输出】
严格 JSON 数组，每项格式：{"style":"自然直接|回应阻力|降低防御","text":"...","reason":"<12-24字，说明这个版本如何调整原话>"}
只输出 JSON，不要 markdown 或额外文字。`

function parse(raw, original) {
  const match = String(raw || '').match(/\[[\s\S]*\]/)
  if (!match) return null
  try {
    const arr = JSON.parse(match[0]).filter(x => x && typeof x.text === 'string').slice(0, 5)
    if (!arr.length) return null
    const allowed = new Set(['自然直接','回应阻力','降低防御'])
    const forbiddenPatterns = [
      /你刚才|你刚刚|刚才你|刚刚你/,
      /你说没事|你说没关系|你说不用|你说没事的/,
      /我知道你(等|觉得|以为|不想|生气|难过|在意)/,
      /既然你(觉得|说|都|已经)/,
      /我理解你(觉得|的)/,
      /你之前说|你之前提|你刚才提/,
      /既然这样|那你说|所以你(觉得|才|还是)/
    ]
    const originalCompact = String(original || '').replace(/\s+/g,'')
    const clean = arr.map(x => ({
      style: allowed.has(x.style) ? x.style : '自然直接',
      text: String(x.text).trim().slice(0, 220),
      reason: String(x.reason || '').trim().slice(0, 40)
    })).filter(x => {
      if (!x.text || forbiddenPatterns.some(re => re.test(x.text))) return false
      // 防止模型直接返回原话；允许短语重合，但不能整句完全复制。
      const compact = x.text.replace(/\s+/g,'')
      return compact !== originalCompact
    })
    if (!clean.length) return null
    return clean.slice(0, 3)
  } catch { return null }
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' })
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0] || 'anon'
  if (limited(ip)) return res.status(429).json({ ok: false, error: '请求太频繁,稍后再试' })
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
    const message = String(body.message || '').trim().slice(0, 500)
    if (!message) return res.status(400).json({ ok: false, error: 'missing message' })
    const context = body.context || {}

    const styles = Array.isArray(context.partner_archetypes) ? context.partner_archetypes : []
    const relation = context.relation || '未知'
    const situation = String(context.situation || context.relationship_state || '未知').slice(0, 500)

    // Rewrite is intentionally independent from TA's simulated answer.
    // The prior answer belongs to the separate “next response” flow and is ignored here.
    const strategy = await strategyAgent({
      question: message,
      intent: '只改写用户原话，不改变核心意思',
      emotion: '沟通不确定',
      focus: 'expression',
      context: { ...context, prior_block: '本次改写不读取 TA 的上一轮回答' }
    })

    const user = `【关系】${relation}
【TA 的沟通特点】${styles.join('、') || '未知'}
【当前情境】${situation}
【本次沟通策略】${strategy.primary_strategy || 'direct'}${strategy.secondary_strategy ? ` + ${strategy.secondary_strategy}` : ''}
【策略原因】${strategy.reason || ''}
【用户原话】
${message}

请只改写“用户原话”。
不要读取、回应或补充任何 TA 的上一轮回答，因为本次功能的目标只是“换一种说法”。
输出的每一句都必须能脱离任何 TA 的回答，直接作为用户发给 TA 的话。`

    const raw = await callLLM({ system: SYSTEM_PROMPT, user, temperature: 0.55, maxTokens: 700 })
    const suggestions = parse(raw, message)
    if (!suggestions) throw new Error('rewrite parse failed')
    return res.status(200).json({ ok: true, suggestions, strategy: { primary_strategy: strategy.primary_strategy, secondary_strategy: strategy.secondary_strategy, reason: strategy.reason } })
  } catch (e) {
    return res.status(500).json({ ok: false, error: (e && e.message) || 'rewrite failed' })
  }
}
