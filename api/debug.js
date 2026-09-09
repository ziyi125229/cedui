import { callLLM } from '../lib/llm.js'

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' })

  const apiKey = process.env.LLM_API_KEY
  const baseUrl = (process.env.LLM_BASE_URL || 'https://sz.uyilink.com').replace(/\/+$/, '')
  const model = process.env.LLM_MODEL || ''

  const result = {
    ok: false,
    env: {
      apiKeyPresent: Boolean(apiKey),
      baseUrl,
      model: model || null
    }
  }

  if (!apiKey) {
    result.error = 'LLM_API_KEY not set in env'
    return res.status(500).json(result)
  }
  if (!model) {
    result.error = 'LLM_MODEL not set in env'
    return res.status(500).json(result)
  }

  try {
    const answer = await callLLM({
      system: '只回复 OK，不要输出其他内容。',
      user: '健康检查',
      temperature: 0,
      maxTokens: 5
    })
    result.ok = true
    result.answer = answer
    return res.status(200).json(result)
  } catch (e) {
    result.error = String(e?.message || e).slice(0, 500)
    return res.status(502).json(result)
  }
}
