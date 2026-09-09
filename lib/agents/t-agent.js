// T-Agent · 模拟 TA 在当前关系与情境下的第一反应
import { callLLM } from '../llm.js'

const SYSTEM_PROMPT = `你是「TA 模拟 Agent」。
你的任务不是读心，也不是判断 TA 的真实心理，而是根据用户提供的关系、沟通特点、当前情境、沟通策略和用户刚说的话，模拟一种“TA 可能的第一反应”。

【重要边界】
- 你不知道真实的 TA 在想什么，必须把结果当作一种可能性，而非事实。
- 不要输出“TA其实……”之类的确定性判断。
- 先在内部形成反应，再输出简短的第一人称内心反应，供另一个 Agent 转成自然对话。

【角色约束】
- “我”代表 TA，“你”代表用户。
- 必须优先遵守【沟通特点】、【关系/情境】和【预演策略】，不要凭空套恋爱模板。
- 友情关系不得写成恋爱口吻。
- 允许犹豫、误解、防御、嘴硬、心软、拒绝等不讨喜反应。
- 如果用户的话本身有攻击性，不要强行给出温柔回复。

【连续性】
如果存在 PREVIOUSLY TA SAID，要把它当作最近的对话上下文。不要与之前明确表达过的态度无故冲突；如果当前这句话改变了局势，可以解释这种变化。

【输出】
只输出 2-4 句第一人称内心反应，不分析、不建议、不总结，不写元话术。`

export async function tAgent({ question, intent, emotion, focus, context = {}, strategy = {} }) {
  const relation = context.relation || '关系不明确'
  const category = context.relation_category === 'friendship' ? '友情' : '恋爱/亲密关系'
  const styles = Array.isArray(context.partner_archetypes) ? context.partner_archetypes : []
  const situation = context.situation || context.relationship_state || '暂无额外情境'
  const prior = context.prior_block || '无此前对话记录'
  const strategyText = [strategy.primary_strategy, strategy.secondary_strategy].filter(Boolean).join(' + ') || 'direct'
  const userMsg = `【关系大类】${category}
【具体关系】${relation}
【TA 的沟通特点】${styles.join('、') || '暂无，保持中性，不要过度推断'}
【当前发生了什么】${situation}
【此前对话】
${prior}
【本次预演策略】${strategyText}
【策略原因】${strategy.reason || '无'}

【用户刚说】
“${question}”

【Q-Agent 理解】
意图：${intent}
情绪：${emotion}
焦点：${focus}

请按本次策略模拟 TA 此刻可能出现的第一反应。`

  return await callLLM({ system: SYSTEM_PROMPT, user: userMsg, temperature: 0.8, maxTokens: 260 })
}
