import { callLLM } from '../llm.js'

const SYSTEM_PROMPT = `你是“关系对话下一步回应 Agent”。
用户刚刚说了一句话，TA 也已经得到了一种可能的回应。现在用户需要决定：面对 TA 的这句话，自己下一步可以怎么接。

你的任务不是改写用户上一句话，也不是再次模拟 TA，而是生成 3 个“用户下一轮可以直接说出口”的回应方向。

【核心原则】
1. 必须针对 TA 刚才的可能回应作出回应；不能把用户原话简单换几个词。
2. 保留用户在这场对话中的真实目的，不擅自增加事实、承诺、经历或立场。
3. 三个版本必须代表不同的沟通路径，而不是同义改写。
4. 根据关系、TA 的沟通特点、当前情境，以及 TA 刚才暴露出的顾虑/情绪/边界来决定策略。
5. 不要替用户强行道歉、示弱、表白或做出承诺，除非原本的上下文已经包含这些意思。
6. 不要使用心理咨询、客服或 AI 话术。必须像真实聊天，1-3 句，口语化。
7. 不要假装知道 TA 的真实想法；“TA 刚才的回应”只是模拟结果。

【常见回应路径，仅供参考】
- 接住：先回应 TA 刚才表达的情绪、顾虑或边界，再继续自己的意思。
- 澄清：针对 TA 可能误解的地方，把自己的真实意思说清楚。
- 推进：顺着 TA 的回答继续问一个自然的问题，把对话往下一步推进。
- 降低压力：在保留核心问题/诉求的前提下，降低 TA 立即回答的压力。
- 设边界：当 TA 回避、模糊或越界时，明确自己的立场。
不要机械地每次输出固定三类，应该根据当前对话选择最合适的三条路径。

【输出】
严格 JSON 数组，每项格式：{"style":"接住|澄清|推进|降低压力|设边界|其他","text":"...","reason":"<12-24字，说明为什么这句适合接在 TA 的回答之后>"}
只输出 JSON，不要 markdown 或额外文字。`

function parse(raw) {
  const match = String(raw || '').match(/\[[\s\S]*\]/)
  if (!match) return null
  try {
    const arr = JSON.parse(match[0]).filter(x => x && typeof x.text === 'string').slice(0, 3)
    if (!arr.length) return null
    return arr.map(x => ({
      style: String(x.style || '其他').trim().slice(0, 20),
      text: String(x.text).trim().slice(0, 220),
      reason: String(x.reason || '').trim().slice(0, 40)
    }))
  } catch { return null }
}

export async function nextResponseAgent({ message, priorAnswer, context = {}, priorTurns = [] }) {
  const relation = context.relation || '未知'
  const styles = Array.isArray(context.partner_archetypes) ? context.partner_archetypes : []
  const situation = String(context.situation || context.relationship_state || '未知').slice(0, 500)
  const history = Array.isArray(priorTurns) ? priorTurns.slice(-3).map((t, i) => `第${i + 1}轮：用户：“${String(t.question || t.q || '').slice(0, 220)}”\nTA：“${String(t.answer || t.a || '').slice(0, 300)}”`).join('\n') : ''
  const user = `【关系】${relation}
【TA 的沟通特点】${styles.join('、') || '未知'}
【当前情境】${situation}
【对话历史】
${history || '无'}
【用户刚才说】
${String(message || '').slice(0, 500)}
【TA 刚才可能这样回应】
${String(priorAnswer || '').slice(0, 500)}

请基于 TA 的这句回应，生成用户下一轮可以直接说出口的 3 种不同回应路径。重点是“接着聊”，不是“重写上一句话”。`

  const raw = await callLLM({ system: SYSTEM_PROMPT, user, temperature: 0.7, maxTokens: 700 })
  const suggestions = parse(raw)
  if (!suggestions) throw new Error('next response parse failed')
  return suggestions
}

export default nextResponseAgent
