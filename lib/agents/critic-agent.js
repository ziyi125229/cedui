// Critic Agent · 对 TA 预演结果做结构化质量检查
import { callLLM } from '../llm.js'

const SYSTEM_PROMPT = `你是「关系预演 Critic Agent」。
你不负责生成回复，只负责判断一个候选 TA 回复是否符合当前预演任务。

请从 5 个维度各打 1-5 分：
1. persona_consistency：是否符合 TA 的沟通特点
2. context_consistency：是否符合当前情境和此前对话
3. relationship_consistency：是否符合双方关系
4. plausibility：真人在此刻说出这句话是否自然、合理
5. naturalness：是否像真实聊天，而不是 AI 总结/咨询话术

【通过标准】
- 五项均 >= 3 才 passed=true
- 如果回复明显把 TA 写得过度温柔、过度理性、过度配合，persona_consistency 应降分
- 如果忽略上一轮已经发生的冲突或态度，context_consistency 应降分
- 不要因为回复“不讨喜”就判低分；真实的防御、回避、反问、不满都可以是合理结果

输出严格 JSON：
{
  "persona_consistency": 1,
  "context_consistency": 1,
  "relationship_consistency": 1,
  "plausibility": 1,
  "naturalness": 1,
  "passed": true,
  "failure_reason": "<如果不通过，指出最关键的问题；通过则为空>"
}
只输出 JSON，不要 markdown 或额外解释。`

function parse(raw) {
  const match = String(raw || '').match(/\{[\s\S]*\}/)
  if (!match) return { passed: true, _parseOk: false }
  try {
    const p = JSON.parse(match[0])
    const keys = ['persona_consistency','context_consistency','relationship_consistency','plausibility','naturalness']
    const scores = Object.fromEntries(keys.map(k => [k, Math.max(1, Math.min(5, Number(p[k]) || 1))]))
    const passed = keys.every(k => scores[k] >= 3)
    return { ...scores, passed, failure_reason: String(p.failure_reason || '').slice(0, 120), _parseOk: true }
  } catch {
    return { passed: true, _parseOk: false }
  }
}

export async function criticAgent({ question, answer, context = {}, strategy = {} }) {
  const styles = Array.isArray(context.partner_archetypes) ? context.partner_archetypes : []
  const relation = context.relation || '关系不明确'
  const situation = context.situation || context.relationship_state || '暂无额外情境'
  const prior = context.prior_block || '无此前对话记录'
  const user = `【关系】${relation}
【TA的沟通特点】${styles.join('、') || '暂无'}
【当前情境】${situation}
【此前对话】
${prior}
【本次策略】${strategy.primary_strategy || 'direct'}${strategy.secondary_strategy ? ` + ${strategy.secondary_strategy}` : ''}
【用户原话】${question}
【候选TA回复】
${answer}

请进行质量检查。`
  const raw = await callLLM({ system: SYSTEM_PROMPT, user, temperature: 0.1, maxTokens: 260 })
  return parse(raw)
}
