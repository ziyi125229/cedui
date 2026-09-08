// Strategy Agent · 根据沟通任务和关系上下文决定预演策略
import { callLLM } from '../llm.js'

const SYSTEM_PROMPT = `你是「关系预演策略 Agent」。
你的任务不是生成 TA 的回复，而是判断这次沟通任务应该采用什么预演策略，并把策略交给后续 Agent。

【核心原则】
- 不读心，不判断 TA 的真实想法。
- 只基于用户表达、关系、TA 的沟通特点、当前情境和此前对话做策略判断。
- 策略必须服务于“模拟一种合理的 TA 可能回应”。
- 不要因为是恋爱关系就默认温柔、和解或挽回。

【可选策略】
- emotion_first：先回应被忽视、失望、委屈、焦虑等情绪，再处理事实
- fact_first：先追问或回应具体事实、原因、时间、行为
- direct：直接回应核心问题，不绕弯
- defensive：TA 可能先自我保护、反问或澄清边界
- avoidant：TA 可能回避正面冲突、降低回应强度或暂不表态
- repair：当前重点是修复已经发生的摩擦，但不能强行和解
- boundary：当前重点是表达拒绝、底线、空间或不舒服
- exploratory：信息不足，TA 更可能先追问，而不是直接表态

可以组合最多两个策略，primary_strategy 必须是其中一个。

输出严格 JSON：
{
  "task_type": "<解释/求确认/表达不满/关系修复/边界表达/行动请求/其他>",
  "primary_strategy": "<上述策略之一>",
  "secondary_strategy": "<上述策略之一或空字符串>",
  "risk_level": "<low|medium|high>",
  "reason": "<20-40字，说明为什么这样编排>"
}
只输出 JSON，不要 markdown 或额外解释。`

function parse(raw, fallback) {
  const match = String(raw || '').match(/\{[\s\S]*\}/)
  if (!match) return { ...fallback, _parseOk: false }
  try {
    const parsed = JSON.parse(match[0])
    const valid = ['emotion_first','fact_first','direct','defensive','avoidant','repair','boundary','exploratory']
    const primary = valid.includes(parsed.primary_strategy) ? parsed.primary_strategy : fallback.primary_strategy
    const secondary = valid.includes(parsed.secondary_strategy) ? parsed.secondary_strategy : ''
    return {
      task_type: String(parsed.task_type || fallback.task_type).slice(0, 30),
      primary_strategy: primary,
      secondary_strategy: secondary === primary ? '' : secondary,
      risk_level: ['low','medium','high'].includes(parsed.risk_level) ? parsed.risk_level : fallback.risk_level,
      reason: String(parsed.reason || fallback.reason).slice(0, 80),
      _parseOk: true
    }
  } catch {
    return { ...fallback, _parseOk: false }
  }
}

export async function strategyAgent({ question, intent, emotion, focus, context = {} }) {
  const styles = Array.isArray(context.partner_archetypes) ? context.partner_archetypes : []
  const relation = context.relation || '关系不明确'
  const situation = context.situation || context.relationship_state || '暂无额外情境'
  const prior = context.prior_block || '无此前对话记录'
  const fallback = {
    task_type: '其他',
    primary_strategy: styles.includes('冲突会回避') ? 'avoidant' : (styles.includes('很在意情绪') || styles.includes('比较敏感') ? 'emotion_first' : 'direct'),
    secondary_strategy: '',
    risk_level: situation !== '暂无额外情境' ? 'medium' : 'low',
    reason: '根据当前关系和沟通特点选择基础预演策略'
  }
  const user = `【关系】${relation}
【TA的沟通特点】${styles.join('、') || '暂无'}
【当前情境】${situation}
【此前对话】
${prior}
【用户原话】${question}
【Q-Agent】意图=${intent}；情绪=${emotion}；焦点=${focus}

请决定本次预演的策略。`
  const raw = await callLLM({ system: SYSTEM_PROMPT, user, temperature: 0.2, maxTokens: 220 })
  return parse(raw, fallback)
}
