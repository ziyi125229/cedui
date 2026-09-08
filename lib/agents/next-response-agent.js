import { callLLM } from '../llm.js'

const SYSTEM_PROMPT = `你是“关系对话下一步回应 Agent”。
用户刚刚说了一句话，TA 也已经得到了一种可能的回应。现在用户需要决定：面对 TA 的这句话，自己下一步可以怎么接。

你的任务不是改写用户上一句话，也不是再次模拟 TA，而是生成 3 个“用户下一轮可以直接说出口”的回应。

【核心规则：承接真实对话状态】
1. TA 的上一句是当前对话状态。你只能回应 TA 在这句话里明确出现的事实、观点、态度、问题或情绪。
2. 禁止推测 TA 没说出口的心理、动机、感受或经历。不要把“可能觉得/可能在意/可能担心”当事实。
3. 每条回应都必须能指出“TA 刚才具体说了哪句话，所以我这样接”。
4. 不要因为用户原话里出现过某个事实，就假设 TA 在上一轮也承认了这个事实。
5. 不要新增 TA 没说过的内容，例如“你是不是生气了”“你应该很难受”“你其实是在等我”“你说没事”等。
6. 可以回答 TA 明确提出的问题，也可以针对 TA 明确表达的观点继续追问、澄清、推进或回应。
7. 如果 TA 的回应很短，只表达“不是针对你”之类的内容，就围绕这句话继续，不要扩写成 TA 没说的情绪故事。

【特别重要：不要重复询问已经知道的信息】
1. 先区分“已知信息”和“未解决信息”。用户原话中已经明确说过的内容，以及 TA 已经明确说出的内容，都属于已知信息。
2. 下一句的价值是推进对话，不是让用户重新确认自己已经知道的答案。
3. 如果 TA 说“那句话让我有点难受”，而用户上一句话已经明确就是那句话，不要生成“你说的是哪一句？”“是哪句话？”这类无效追问。
4. 如果 TA 已经明确表达了原因、态度或边界，不要再次问一个答案就在 TA 原话里的问题；应该承接、回应、澄清尚未说清的部分，或者推进解决。
5. 澄清问题只有在“答案确实还不知道”时才有价值。不要为了生成一个“澄清”标签而硬问。
6. 不要把“TA 提到一个内容”机械地转化成“询问这个内容是什么”；如果内容本身已经明确，就直接回应它。

【用户原话的作用】
用于理解用户想解决什么问题，以及判断哪些信息用户已经知道，避免下一句重复询问；不能把用户原话里的信息重新塞进 TA 的嘴里。

【三个方向】
- 接住：直接接住 TA 明确表达的内容。
- 澄清：只针对真正尚未明确、且对推进对话有价值的问题继续问清楚。
- 推进：在 TA 已明确表达的基础上，把对话往解决问题/表达诉求推进。
- 降低压力：在不改变核心目的的情况下，让下一句更自然。
- 设边界：如果 TA 明确表达了不接受、拒绝或边界，可以回应这个边界。
不要求每次覆盖不同方向，宁可少一个，也不要编造或制造无效问题。

【禁止】
- 不要写成“我猜你其实……”
- 不要写成“你是不是因为……”
- 不要写成“我知道你现在……”
- 不要替 TA 总结没有说出的感受。
- 不要为了凑 3 条而创造 TA 没说过的前提。
- 不要询问用户自己刚刚已经说过、或者 TA 刚刚已经明确说过的答案。

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
  for (let n = 2; n <= 6; n++) {
    for (let i = 0; i + n <= s.length; i++) tokens.add(s.slice(i, i + n))
  }
  return [...tokens]
}

function repeatsKnownAnswer(text, message, priorAnswer) {
  const value = normalize(text)
  const user = normalize(message)
  const ta = normalize(priorAnswer)

  // If TA refers to “that sentence/that thing” and the user just supplied
  // the concrete sentence, asking which one is redundant.
  const asksWhich = /(哪一句|哪句话|什么话|哪件事|什么事|具体是哪|具体什么)/.test(value)
  const taRefersToKnown = /(那一句|那句话|那件事|这句话|这件事)/.test(ta)
  if (asksWhich && taRefersToKnown && user.length >= 8) return true

  // Do not ask for information that is literally present in the user's
  // immediately preceding message.
  if (/(你说的是什么|你指的是什么|你说的是哪|你指的是哪)/.test(value)) {
    const meaningful = meaningfulTokens(user).filter(t => t.length >= 3)
    if (meaningful.some(t => value.includes(t))) return true
  }
  return false
}

function parse(raw, priorAnswer, message) {
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

      const anchorTokens = meaningfulTokens(anchor).filter(t => t.length >= 3)
      const overlap = anchorTokens.filter(t => text.includes(t))
      if (!overlap.length) return false

      if (/(你是不是|你应该是|你其实是|我猜你|我知道你现在|你肯定|你一定)/.test(text)) return false
      if (repeatsKnownAnswer(text, message, priorAnswer)) return false
      return true
    })

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

async function generate({ user, priorAnswer, message, repair = false }) {
  const raw = await callLLM({
    system: SYSTEM_PROMPT,
    user: repair
      ? `${user}\n\n【严格修正】上一版存在“重复询问已经知道的信息”或“凭空补充 TA 没说的内容”的问题。重新生成 3 条。澄清只能询问真正未知、且有助于推进对话的问题；如果答案已经在用户原话或 TA 原话里明确出现，就直接承接，不要再问。每条必须回应 TA 原话中一个明确出现的连续片段。`
      : user,
    temperature: repair ? 0.35 : 0.55,
    maxTokens: 900
  })
  return parse(raw, priorAnswer, message)
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

先判断：用户已经知道什么、TA 已经明确说了什么、还有什么真正没有说清楚。
然后从 TA 回应中找出 3 个真实存在的明确内容点，分别围绕这些内容点生成用户下一句。
每条必须有一个 anchor，anchor 必须是 TA 回应中的连续原文；下一句必须真的回应这个 anchor，而不是借 anchor 猜 TA 的潜台词。
如果某个澄清问题的答案已经能从用户刚才说的话或 TA 刚才的回答中确定，就不要再问。
如果 TA 回应没有足够多的不同内容点，可以让不同建议围绕同一明确内容点采取不同沟通动作，但不能补造新的 TA 信息。`

  let suggestions = await generate({ user, priorAnswer, message })
  if (!suggestions || suggestions.length < 3) {
    suggestions = await generate({ user, priorAnswer, message, repair: true })
  }
  if (!suggestions || suggestions.length < 3) throw new Error('next response grounding failed')
  return suggestions
}

export default nextResponseAgent
