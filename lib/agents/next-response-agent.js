import { callLLM } from '../llm.js'

const SYSTEM_PROMPT = `你是“关系对话下一步回应 Agent”。
用户刚刚说了一句话，TA 也已经得到了一种可能的回应。现在用户需要决定：面对 TA 的这句话，自己下一步可以怎么接。

你的任务不是改写用户上一句话，也不是再次模拟 TA，而是生成 3 个“用户下一轮可以直接说出口”的回应。

【核心规则：只回应 TA 明确说出来的内容】
1. TA 的上一句是当前对话状态。你只能回应 TA 在这句话里明确出现的事实、观点、态度、问题或情绪。
2. 禁止推测 TA 没说出口的心理、动机、感受或经历。不要把“可能觉得/可能在意/可能担心”当事实。
3. 每条回应都必须能指出“TA 刚才具体说了哪句话，所以我这样接”。
4. 不要因为用户原话里出现过某个事实，就假设 TA 在上一轮也承认了这个事实。
5. 不要新增 TA 没说过的内容，例如“你是不是生气了”“你应该很难受”“你其实是在等我”“你说没事”等。
6. 可以回答 TA 明确提出的问题，也可以针对 TA 明确表达的观点继续追问、澄清、推进或回应。
7. 如果 TA 的回应很短，只表达“不是针对你”之类的内容，就围绕这句话继续，不要扩写成 TA 没说的情绪故事。

【用户原话的作用】
只用于理解用户想解决什么问题，避免下一句跑题；不能把用户原话里的信息重新塞进 TA 的嘴里。

【三个方向】
- 接住：直接接住 TA 明确表达的内容。
- 澄清：针对 TA 明确说出的某个点继续问清楚。
- 推进：在 TA 已明确表达的基础上，把对话往解决问题/表达诉求推进。
- 降低压力：在不改变核心目的的情况下，让下一句更自然。
- 设边界：如果 TA 明确表达了不接受、拒绝或边界，可以回应这个边界。
不要求每次覆盖不同方向，宁可少一个，也不要编造。

【禁止】
- 不要写成“我猜你其实……”
- 不要写成“你是不是因为……”
- 不要写成“我知道你现在……”
- 不要替 TA 总结没有说出的感受。
- 不要为了凑 3 条而创造 TA 没说过的前提。

【输出】
严格 JSON 数组，每项格式：{"style":"接住|澄清|推进|降低压力|设边界","anchor":"从 TA 回应中原样摘取的 4-20 字片段","text":"用户下一轮可以直接说出口的话","reason":"<12-24字，说明这句话回应了 TA 的哪一点>"}
anchor 必须是 TA 回应中连续出现的原文片段，不能改写、概括或编造。
只输出 JSON，不要 markdown 或额外文字。`

function normalize(value) {
  return String(value || '')
    .replace(/[“”‘’]/g, '')
    .replace(/[，。！？、；：,.!?;:]/g, '')
    .replace(/\s+/g, '')
    .trim()
}

function meaningfulTokens(text) {
  const s = normalize(text)
  const tokens = new Set()
  // Keep 2-6 character chunks. This is intentionally simple: it gives the
  // deterministic guard some lexical evidence without pretending to do NLP.
  for (let n = 2; n <= 6; n++) {
    for (let i = 0; i + n <= s.length; i++) tokens.add(s.slice(i, i + n))
  }
  return [...tokens]
}

function parse(raw, priorAnswer) {
  const match = String(raw || '').match(/\[[\s\S]*\]/)
  if (!match) return null
  try {
    const arr = JSON.parse(match[0])
      .filter(x => x && typeof x.text === 'string' && typeof x.anchor === 'string')
      .slice(0, 5)
    if (!arr.length || !priorAnswer) return null

    const source = normalize(priorAnswer)
    const grounded = arr.filter(x => {
      const anchor = normalize(x.anchor)
      const text = normalize(x.text)
      if (anchor.length < 4 || anchor.length > 20 || !source.includes(anchor)) return false

      // The response must show lexical evidence that it is actually reacting
      // to the chosen anchor. Purely unrelated advice is rejected.
      const anchorTokens = meaningfulTokens(anchor).filter(t => t.length >= 3)
      const overlap = anchorTokens.filter(t => text.includes(t))
      if (!overlap.length) return false

      // Reject common hallucinated mind-reading patterns.
      if (/(你是不是|你应该是|你其实是|我猜你|我知道你现在|你肯定|你一定)/.test(text)) return false
      return true
    })

    // Deduplicate by text so three slots cannot become near-identical.
    const seen = new Set()
    const unique = grounded.filter(x => {
      const key = normalize(x.text)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    if (!unique.length) return null
    return unique.map(x => ({
      style: String(x.style || '接住').trim().slice(0, 20),
      anchor: String(x.anchor).trim().slice(0, 30),
      text: String(x.text).trim().slice(0, 220),
      reason: String(x.reason || '').trim().slice(0, 40)
    })).slice(0, 3)
  } catch {
    return null
  }
}

async function generate({ user, priorAnswer, repair = false }) {
  const raw = await callLLM({
    system: SYSTEM_PROMPT,
    user: repair
      ? `${user}\n\n【严格修正】上一版存在“凭空补充 TA 没说的内容”的问题。重新生成 3 条。每条必须回应 TA 原话中一个明确出现的连续片段，并且下一句中要实际回应这个片段。不要推测 TA 的潜台词。`
      : user,
    temperature: repair ? 0.35 : 0.55,
    maxTokens: 900
  })
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

先从 TA 回应中找出 3 个真实存在的明确内容点，然后分别围绕这些内容点生成用户下一句。
每条必须有一个 anchor，anchor 必须是 TA 回应中的连续原文；下一句必须真的回应这个 anchor，而不是借 anchor 猜 TA 的潜台词。
如果 TA 回应没有足够多的不同内容点，可以让不同建议围绕同一明确内容点采取不同沟通动作，但不能补造新的 TA 信息。`

  let suggestions = await generate({ user, priorAnswer })
  if (!suggestions || suggestions.length < 3) {
    suggestions = await generate({ user, priorAnswer, repair: true })
  }
  if (!suggestions || suggestions.length < 3) throw new Error('next response grounding failed')
  return suggestions
}

export default nextResponseAgent
