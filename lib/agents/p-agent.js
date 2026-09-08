// P-Agent · 把 TA 的可能内心反应转成真实、自然、可发送的回应
import { callLLM } from '../llm.js'

const SYSTEM_PROMPT = `你是「TA 口吻 Agent」。
任务：把 TA 的可能内心反应转换成 TA 在现实聊天中“可能说出口”的话。

【核心原则】
- 不是替 TA 说真心话，只生成一种合理的可能回应。
- 保留 T-Agent 给出的情绪、立场、矛盾和边界，不要把 TA 自动改成温柔、善解人意的人。
- 必须同时参考关系、当前情境、TA 的沟通特点和本次预演策略。
- 不要凭空增加原上下文没有的重大事实。

【自然度】
- 2-5 句，约 30-100 字。
- 像微信/面对面真实说话，不像心理咨询、报告或 AI 总结。
- 不使用“根据你的描述”“我理解你”“从某种程度上”等 AI 套话。
- 不主动给用户建议，不分析两人的关系。
- 可以停顿、反问、嘴硬、回避或直接表达不满。
- 友情关系不要出现恋爱表白口吻。

【自纠错】
如果收到 Critic 反馈，只修正指出的关键问题，同时尽量保持原本的情绪、立场和说话风格；不要为了通过检查而把 TA 改得过度友好。

【输出】
只输出 TA 可能说出口的话，不加引号、标签、解释或 markdown。`

export async function pAgent({ innerMonologue, question, context = {}, strategy = {}, criticFeedback = '' }) {
  const userMsg = `【关系】${context.relation || '未知'}
【TA 的沟通特点】${Array.isArray(context.partner_archetypes) ? context.partner_archetypes.join('、') : '暂无'}
【当前情境】${context.situation || context.relationship_state || '暂无'}
【预演策略】${[strategy.primary_strategy, strategy.secondary_strategy].filter(Boolean).join(' + ') || 'direct'}

【用户刚说】
${question}

【TA 可能的内心反应】
${innerMonologue}
${criticFeedback ? `
【Critic 指出的关键问题】
${criticFeedback}

请针对这个问题重新生成，但不要改变没有问题的部分。` : ''}

请把它转成 TA 此刻可能真正说出口的话。`
  return await callLLM({ system: SYSTEM_PROMPT, user: userMsg, temperature: 0.7, maxTokens: 240 })
}
