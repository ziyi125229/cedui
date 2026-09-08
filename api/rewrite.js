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
用户已经写好一句准备对 TA 说的话，现在想在“发出去之前”看看这句话还能怎么表达。

你的任务只有一个：改写【用户原话】。
你可以参考 TA 刚才的可能回应，判断原话可能会触发什么沟通阻力，然后提前调整用户原话的表达方式。

【最重要的边界】
1. 输出必须仍然是“用户现在准备说的这一句话/这几句话”，绝不能变成对 TA 刚才回答的下一句回应。
2. 不得假设 TA 已经说过用户原话里没有的信息。禁止出现“你刚才说……”“我知道你……”“既然你觉得……”等把上一轮 TA 回应当成新事实的表达。
3. TA 的上一轮回应只能作为“改写依据”，不能成为改写内容本身。
4. 三个版本都必须表达与原话相同的核心意图/诉求。可以调整语气、信息顺序、解释方式和压力程度，但不能改变用户真正想问什么、想表达什么。
5. 不得新增用户没有提供的事实、经历、承诺或立场；不得替用户强行道歉、示弱、表白。
6. 每个版本必须与原话有实质表达差异；不能原样复制。
7. 不要使用心理咨询、客服或 AI 话术。必须像真实聊天，1-3 句，口语化。

【三个改写方向】
- 自然直接：保留原话的直接感，但让意思更清楚、更像真人表达。
- 回应阻力：根据 TA 刚才的可能回应，提前在“用户原话”里补足最容易引发误解/防御的部分；注意，这是提前处理阻力，不是在回答 TA。
- 降低防御：保留原本的核心问题或诉求，减少指责、逼问或突兀感，让 TA 更容易听进去，但不能把问题变成“随口一说”或取消真实诉求。

【自检】
生成每条后检查：
- 如果删掉 TA 刚才的回应，这句话是否仍然可以独立作为用户下一次发出的原话？必须可以。
- 这句话是在“重新表达用户原意”，还是在“回应 TA”？如果是在回应 TA，必须重写。

【输出】
严格 JSON 数组，每项格式：{"style":"自然直接|回应阻力|降低防御","text":"...","reason":"<12-24字，说明这个版本如何调整原话>"}
只输出 JSON，不要 markdown 或额外文字。`

function parse(raw) {
  const match = String(raw || '').match(/\[[\s\S]*\]/)
  if (!match) return null
  try {
    const arr = JSON.parse(match[0]).filter(x => x && typeof x.text === 'string').slice(0, 3)
    if (!arr.length) return null
    const allowed = new Set(['自然直接','回应阻力','降低防御'])
    return arr.map(x => ({
      style: allowed.has(x.style) ? x.style : '自然直接',
      text: String(x.text).trim().slice(0, 220),
      reason: String(x.reason || '').trim().slice(0, 40)
    }))
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
    const priorAnswer = String(body.priorAnswer || '').trim().slice(0, 500)
    const strategyFromClient = body.strategy && typeof body.strategy === 'object' ? body.strategy : null

    const styles = Array.isArray(context.partner_archetypes) ? context.partner_archetypes : []
    const relation = context.relation || '未知'
    const situation = String(context.situation || context.relationship_state || '未知').slice(0, 500)
    const priorBlock = priorAnswer ? `PREVIOUSLY TA SAID:\n· TA 刚才可能会这样回应：“${priorAnswer}”` : '无上一轮 TA 回应'

    const strategy = strategyFromClient || await strategyAgent({
      question: message,
      intent: '优化这句话，让 TA 更容易听进去',
      emotion: '沟通不确定',
      focus: 'action',
      context: { ...context, prior_block: priorBlock }
    })

    const user = `【关系】${relation}
【TA 的沟通特点】${styles.join('、') || '未知'}
【当前情境】${situation}
【此前 TA 的可能回应（仅用于判断沟通阻力，禁止直接回应它）】
${priorBlock}
【本次沟通策略】${strategy.primary_strategy || 'direct'}${strategy.secondary_strategy ? ` + ${strategy.secondary_strategy}` : ''}
【策略原因】${strategy.reason || ''}
【用户原话】
${message}

请只改写“用户原话”。输出的每一句都必须能在没有 TA 上一轮回答的情况下，直接作为用户准备发给 TA 的话。
特别注意：不要回答 TA，不要承接 TA 的新信息，不要写“你刚才……”“我知道你……”。`

    const raw = await callLLM({ system: SYSTEM_PROMPT, user, temperature: 0.65, maxTokens: 700 })
    const suggestions = parse(raw)
    if (!suggestions) throw new Error('rewrite parse failed')
    return res.status(200).json({ ok: true, suggestions, strategy: { primary_strategy: strategy.primary_strategy, secondary_strategy: strategy.secondary_strategy, reason: strategy.reason } })
  } catch (e) {
    return res.status(500).json({ ok: false, error: (e && e.message) || 'rewrite failed' })
  }
}
