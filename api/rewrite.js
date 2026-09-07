import { callLLM } from '../lib/llm.js'

const hits = new Map()
function limited(ip){
  const now = Date.now(), w = 60000, max = 20
  const e = hits.get(ip) || { n: 0, ts: now }
  if (now - e.ts > w) { e.n = 0; e.ts = now }
  e.n++; hits.set(ip, e)
  return e.n > max
}

const SYSTEM_PROMPT = `你是“关系表达改写 Agent”。
用户已经写了一句话，准备对一个重要的人说，但担心对方产生防御、误解或受伤。
你的任务不是替用户改变立场，也不是替用户道歉，而是在保留原意的前提下，提供 3 种更容易被对方听进去的表达方式。

要求：
1. 保留用户真正想表达的核心意思，不擅自增加承诺、道歉或事实。
2. 结合关系类型、TA 的沟通特点和当前情境，减少可能引发误解的表达。
3. 三种版本要有明显差异：自然直接、温和解释、先回应对方感受。
4. 每个版本只写用户可以直接发给 TA 的话，1-3 句，口语化，不要像咨询师或 AI。
5. 只输出严格 JSON 数组，每项格式：{"style":"自然直接|温和解释|先回应感受","text":"..."}。
不要输出任何解释、markdown 或额外文字。`

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
    const user = `关系：${context.relation || '未知'}\nTA 的沟通特点：${Array.isArray(context.partner_archetypes) ? context.partner_archetypes.join('、') : '未知'}\n当前情境：${String(context.situation || '未知').slice(0, 500)}\n原话：${message}`
    const raw = await callLLM({ system: SYSTEM_PROMPT, user, temperature: 0.7, maxTokens: 500 })
    const match = raw.match(/\[[\s\S]*\]/)
    if (!match) throw new Error('rewrite parse failed')
    const suggestions = JSON.parse(match[0]).filter(x => x && typeof x.text === 'string').slice(0, 3)
    if (!suggestions.length) throw new Error('rewrite empty')
    return res.status(200).json({ ok: true, suggestions })
  } catch (e) {
    return res.status(500).json({ ok: false, error: (e && e.message) || 'rewrite failed' })
  }
}
