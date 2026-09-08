import { callLLM } from '../llm.js'

const SYSTEM_PROMPT = `你是“关系对话下一步回应 Agent”。
用户刚刚说了一句话，TA 也已经得到了一种可能的回应。现在用户需要决定：面对 TA 的这句话，自己下一步可以怎么接。

你的任务不是改写用户上一句话，也不是再次模拟 TA，而是生成 3 个“用户下一轮可以直接说出口”的回应方向。

【最重要的原则：以 TA 刚才说的话为锚点】
1. TA 的上一句回应是当前对话状态的唯一直接依据。每一条建议都必须能明确对应 TA 回应中已经说出来的内容。
2. 不要凭空推断 TA 没有表达的事实、动机、观点、感受或潜台词。尤其不要写“你是不是觉得……”“是不是因为……”之类没有文本依据的内容。
3. 如果 TA 表达了情绪，就回应这个已表达的情绪；如果 TA 回避了问题，就针对回避本身推进；如果 TA 澄清了某件事，就接着澄清；如果 TA 提出了问题，就回答或推进这个问题。
4. 不要把“TA 可能在意/可能担心/可能觉得”当作事实。可以回应 TA 明确说出的内容，但不能替 TA 补充没说出口的内容。
5. 每条建议都必须是“接在 TA 上一句后面”的自然话，而不是对用户原话重新改写。
6. 生成前先在内部找出 TA 回应中一个明确的“回应锚点”。每条建议都必须有对应锚点；输出中的 anchor 必须原样摘自 TA 的回应。

【用户原话的作用】
用户原话只用于理解用户这场对话的真实目的，防止下一句跑题；它不是生成下一句的主要素材。
TA 的上一句才是“现在轮到谁说什么”的决定性输入。

【三条建议】
1. 三个版本必须代表不同的沟通路径，而不是同义改写。
2. 根据 TA 实际说出的内容动态选择最合适的路径，例如：接住、澄清、推进、降低压力、设边界。
3. 不要求每次都覆盖不同标签；如果某类路径不适合当前对话，不要硬凑。
4. 每条 1-3 句，口语化，像真实聊天，不要心理咨询、客服或 AI 话术。
5. 不要替用户强行道歉、示弱、表白或承诺，除非用户原话/上下文已经包含这些意思。
6. 不要假装知道 TA 的真实想法；这是对模拟回应的继续预演。

【输出】
严格 JSON 数组，每项格式：{"style":"接住|澄清|推进|降低压力|设边界|其他","anchor":"从 TA 回应中原样摘取的 4-20 字片段","text":"用户下一轮可以直接说出口的话","reason":"<12-24字，说明为什么这句适合接在 TA 的回答之后>"}
anchor 必须是 TA 回应中连续出现的原文片段，不能改写、概括或编造。
只输出 JSON，不要 markdown 或额外文字。`

function normalize(value) {
  return String(value || '')
    .replace(/[“”‘’]/g, '')
    .replace(/[，。！？、；：,.!?;:]/g, '')
    .replace(/\s+/g, '')
    .trim()
}

function parse(raw, priorAnswer) {
  const match = String(raw || '').match(/\[[\s\S]*\]/)
  if (!match) return null
  try {
    const arr = JSON.parse(match[0])
      .filter(x => x && typeof x.text === 'string' && typeof x.anchor === 'string')
      .slice(0, 3)

    if (!arr.length || !priorAnswer) return null

    const source = normalize(priorAnswer)
    const grounded = arr.filter(x => {
      const anchor = normalize(x.anchor)
      return anchor.length >= 4 && anchor.length <= 20 && source.includes(anchor)
    })

    if (!grounded.length) return null

    return grounded.map(x => ({
      style: String(x.style || '其他').trim().slice(0, 20),
      text: String(x.text).trim().slice(0, 220),
      reason: String(x.reason || '').trim().slice(0, 40)
    }))
  } catch {
    return null
  }
}

async function generate({ user, priorAnswer }) {
  const raw = await callLLM({ system: SYSTEM_PROMPT, user, temperature: 0.7, maxTokens: 850 })
  return parse(raw, priorAnswer)
}

export async function nextResponseAgent({ message, priorAnswer, context = {}, priorTurns = [] }) {
  const relation = context.relation || '未知'
  const styles = Array.isArray(context.partner_archetypes) ? context.partner_archetypes : []
  const situation = String(context.situation || context.relationship_state || '未知').slice(0, 500)
  const history = Array.isArray(priorTurns)
    ? priorTurns.slice(-3).map((t, i) => `第${i + 1}轮：用户：“${String(t.question || t.q || '').slice(0, 220)}”\nTA：“${String(t.answer || t.a || '').slice(0, 300)}”`).join('\n')
    : ''

  const user = `【关系】${relation}
【TA 的沟通特点】${styles.join('、') || '未知'}
【当前情境】${situation}
【对话历史】
${history || '无'}
【用户刚才说】
${String(message || '').slice(0, 500)}
【TA 刚才可能这样回应】
${String(priorAnswer || '').slice(0, 500)}

请先锁定 TA 回应中已经明确出现的一处内容作为回应锚点，再生成 3 个用户下一轮可以直接说出口的不同回应。
每一条都必须真正接在 TA 这句话后面；不要围绕 TA 没说过的潜台词发挥。
输出的 anchor 必须从“TA 刚才可能这样回应”中原样摘取连续片段。`

  let suggestions = await generate({ user, priorAnswer })

  if (!suggestions || suggestions.length < 3) {
    const retryUser = `${user}

【修正要求】
上一版没有通过“原文锚点”校验。重新生成 3 条。
不要推测 TA 的潜台词。每条都必须针对 TA 回应里明确出现的词句，并且 anchor 必须是 TA 回应中的连续原文片段，长度 4-20 字。`
    suggestions = await generate({ user: retryUser, priorAnswer })
  }

  if (!suggestions || suggestions.length < 3) throw new Error('next response grounding failed')
  return suggestions
}

export default nextResponseAgent
