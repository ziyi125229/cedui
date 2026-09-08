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

const SYSTEM_PROMPT = `你是“关系表达策略改写 Agent”。
用户已经写了一句话，准备对一个重要的人说，但担心对方产生防御、误解或受伤。
你的任务不是单纯润色，而是根据“对方刚才的可能反应”和本次沟通策略，提供 3 种真正不同的表达路径。

【核心原则】
1. 保留用户真正想表达的核心意思，不擅自增加承诺、事实或用户没有表达的立场。
2. 优先解决上一轮 TA 回应暴露出的沟通阻力；如果 TA 在意等待、被忽视、边界或情绪，就针对这个阻力调整表达顺序。
3. 三种版本必须是“策略不同”，不是只换几个同义词：可以改变信息顺序、回应重点和防御程度，但不能改变核心事实。
4. 结合关系类型、TA 的沟通特点、当前情境和本次策略。
5. 不要把用户改写成心理咨询师，不要强迫道歉，不要过度温柔，不要使用“我理解你的感受”“我想和你沟通一下”这类 AI/咨询话术。
6. 只写用户可以直接发给 TA 的话，1-3 句，口语化，像真实聊天。

【三个策略】
- 自然直接：尽量保留用户原来的说话方式，只让核心意思更清楚。
- 回应阻力：优先回应上一轮 TA 最在意的点，再表达自己的原因；如果没有明确阻力，就回应当前情境里最可能的误解。
- 降低防御：承认自己表达里最容易让 TA 误解的部分，但不无条件认错、不改变事实，让对方更容易继续对话。

【输出】
严格 JSON 数组，每项格式：{"style":"自然直接|回应阻力|降低防御","text":"...","reason":"<12-24字，说明这个版本解决了什么沟通阻力>"}
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

    // 若前端没有携带上一轮 Strategy，则在改写阶段补一次策略判断，保证接口单独调用也具备策略能力。
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
【此前 TA 的可能回应】
${priorBlock}
【本次沟通策略】${strategy.primary_strategy || 'direct'}${strategy.secondary_strategy ? ` + ${strategy.secondary_strategy}` : ''}
【策略原因】${strategy.reason || ''}
【用户原话】${message}

请不要只做同义改写。先判断上一轮 TA 的回应暴露了什么沟通阻力，再按三个策略分别写出可以直接说出口的版本。`

    const raw = await callLLM({ system: SYSTEM_PROMPT, user, temperature: 0.65, maxTokens: 700 })
    const suggestions = parse(raw)
    if (!suggestions) throw new Error('rewrite parse failed')
    return res.status(200).json({ ok: true, suggestions, strategy: { primary_strategy: strategy.primary_strategy, secondary_strategy: strategy.secondary_strategy, reason: strategy.reason } })
  } catch (e) {
    return res.status(500).json({ ok: false, error: (e && e.message) || 'rewrite failed' })
  }
}
