import nextResponseAgent from '../lib/agents/next-response-agent.js'

const hits = new Map()
function limited(ip){
  const now = Date.now(), w = 60000, max = 20
  const e = hits.get(ip) || { n: 0, ts: now }
  if (now - e.ts > w) { e.n = 0; e.ts = now }
  e.n++; hits.set(ip, e)
  return e.n > max
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'POST only' })
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0] || 'anon'
  if (limited(ip)) return res.status(429).json({ ok:false, error:'请求太频繁,稍后再试' })
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
    const message = String(body.message || '').trim().slice(0, 500)
    const priorAnswer = String(body.priorAnswer || '').trim().slice(0, 500)
    if (!message || !priorAnswer) return res.status(400).json({ ok:false, error:'missing message or priorAnswer' })
    const context = body.context || {}
    const priorTurns = Array.isArray(body.priorTurns) ? body.priorTurns.slice(-3) : []
    const suggestions = await nextResponseAgent({ message, priorAnswer, context, priorTurns })
    return res.status(200).json({ ok:true, suggestions })
  } catch (e) {
    return res.status(500).json({ ok:false, error:(e && e.message) || 'next response failed' })
  }
}
