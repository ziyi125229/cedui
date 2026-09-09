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

【最重要：先判断对话处于什么阶段】
下一句不是机械地“继续提问”，而是要判断用户和 TA 已经走到哪一步。

A. 如果用户已经明确承认、道歉或意识到自己的问题，并且 TA 已经明确表达了这件事造成的影响：
- 不要重新定位“是哪句话/哪几个字/哪件事”。
- 不要要求 TA 再指出用户已经知道的内容。
- 优先生成“承接影响 → 承担责任 → 修复/推进”的回应。
- 例如用户已经说“我知道那句话说错了/我当时不该这么说”，TA 又说“那句话让我很难受”，此时应该回应“我明白那句话确实伤到你了”“我不想再解释自己为什么这么说，我想想办法把这件事处理好”，而不是“是哪个字让你不舒服？”。

B. 只有当用户和 TA 都没有明确某个关键事实时，才使用澄清问题。

C. 如果 TA 已经给出了原因、态度、边界或影响，下一句应该在此基础上推进，而不是把 TA 已经说过的信息重新问一遍。

【特别重要：不要重复询问已经知道的信息】
1. 先区分“已知信息”和“未解决信息”。用户原话中已经明确说过的内容，以及 TA 已经明确说出的内容，都属于已知信息。
2. 下一句的价值是推进对话，不是让用户重新确认自己已经知道的答案。
3. 如果 TA 说“那句话让我有点难受”，而用户上一句话已经明确就是那句话，不要生成“你说的是哪一句？”“是哪句话？”“是哪个字？”“哪几个字？”“具体哪部分？”这类无效追问。
4. 如果用户已经明确承认自己说错、做错或不该这么做，TA 又明确表达受到影响，应直接承接影响或推进修复。
5. 如果 TA 已经明确表达了原因、态度或边界，不要再次问一个答案就在 TA 原话里的问题；应该承接、回应、澄清尚未说清的部分，或者推进解决。
6. 澄清问题只有在“答案确实还不知道”时才有价值。不要为了生成一个“澄清”标签而硬问。
7. 不要把“TA 提到一个内容”机械地转化成“询问这个内容是什么”；如果内容本身已经明确，就直接回应它。

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
- 不要在用户已经承认错误、TA 已经表达影响后，继续追问具体是哪句话/哪个字/哪部分。

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

function userAlreadyOwnsProblem(message) {
  const value = normalize(message)
  if (value.length < 8) return false

  return (
    /(我知道|我意识到|我已经意识到|我明白|我承认|我确实|是我不对|是我错了|我说错了|我做错了|我不该|我不应该|我当时不该|我当时不应该|是我的问题|是我问题|我有问题|我已经道歉|我道歉)/.test(value)
    && /(那句话|这句话|那件事|这件事|当时|那次|说了|说错|做错|问题|不该|不应该)/.test(value)
  )
}

function taHasExplicitImpact(priorAnswer) {
  const value = normalize(priorAnswer)
  return /(难受|难过|受伤|伤到|伤害|介意|不舒服|失望|生气|委屈|接受不了|无法接受|很痛苦|让我|让我很|让我有点)/.test(value)
}

function repeatsKnownAnswer(text, message, priorAnswer) {
  const value = normalize(text)
  const user = normalize(message)
  const ta = normalize(priorAnswer)

  const asksWhich = /(哪一句|哪句话|哪个字|哪几个字|什么话|哪件事|什么事|哪部分|哪一部分|具体是哪|具体什么|具体哪部分|具体哪一部分|哪一点)/.test(value)
  const taRefersToKnown = /(那一句|那句话|那件事|这句话|这件事)/.test(ta)

  if (asksWhich && ((taRefersToKnown && user.length >= 8) || userAlreadyOwnsProblem(message))) return true

  if (/(你说的是什么|你指的是什么|你说的是哪|你指的是哪)/.test(value)) {
    if (user.length >= 8 || userAlreadyOwnsProblem(message)) return true
  }

  // Once the user has explicitly owned the problem and TA has stated its impact,
  // asking for the exact wording is almost always a step backward.
  if (userAlreadyOwnsProblem(message) && taHasExplicitImpact(priorAnswer) && asksWhich) return true

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
      ? `${user}\n\n【严格修正】上一版存在“重复询问已经知道的信息”或“用户已经承认问题后仍要求定位具体字词”的问题。重新生成 3 条。先判断用户是否已经明确承认、道歉或意识到自己的问题；如果是，且 TA 已表达这件事带来的影响，就不要再问是哪句话、哪个字、哪几个字或哪一部分。此时优先生成承接影响、承担责任、修复关系、推进解决的下一句。每条必须从 TA 原话中选择一个 4-20 字的连续片段作为 anchor；anchor 必须逐字存在于 TA 原话中。澄清只能询问真正未知、且有助于推进对话的问题；不要为了凑 3 条编造新的 TA 信息。`
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

先判断：用户已经知道什么、TA 已经明确说了什么、还有什么真正没有说清楚，以及当前对话更适合“接住、修复还是继续澄清”。
特别检查：如果用户已经明确承认自己说错/做错/不该这么做，而 TA 已明确表达因此产生的难受、受伤、失望等影响，那么下一句必须优先承接影响、承担责任或推进修复，禁止重新询问具体是哪句话、哪个字、哪几个字、哪一部分。
然后从 TA 回应中找出 3 个真实存在的明确内容点，围绕这些内容点生成用户下一句。
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
