// Orchestrator · Q → Strategy → T → P → Critic，必要时重试
import { qAgent } from './agents/q-agent.js'
import { strategyAgent } from './agents/strategy-agent.js'
import { tAgent } from './agents/t-agent.js'
import { pAgent } from './agents/p-agent.js'
import { criticAgent } from './agents/critic-agent.js'

const DEBUG = process.env.DEBUG_AGENTS === 'true'
const log = (label, payload) => { if (DEBUG) console.log(`[${label}]`, typeof payload === 'string' ? payload : JSON.stringify(payload)) }

function buildPriorBlock(priorTurns) {
  if (!Array.isArray(priorTurns) || !priorTurns.length) return ''
  const lines = priorTurns.slice(-3).map(t => {
    const q = typeof t?.q === 'string' ? t.q.trim().slice(0, 200) : ''
    const a = typeof t?.a === 'string' ? t.a.trim().slice(0, 240) : ''
    return a ? `· 当你听到“${q}”时，你曾回应：“${a}”` : ''
  }).filter(Boolean)
  return lines.length ? `PREVIOUSLY TA SAID:\n${lines.join('\n')}` : ''
}

export async function askPartnerPipeline(question, context = {}, priorTurns = []) {
  const t0 = Date.now()
  log('Q input', question)

  const parsed = await qAgent(question)
  const t1 = Date.now()
  log('Q output', parsed)

  const priorBlock = buildPriorBlock(priorTurns)
  const tContext = priorBlock ? { ...context, prior_block: priorBlock } : context

  const strategy = await strategyAgent({ question, intent: parsed.intent, emotion: parsed.emotion, focus: parsed.focus, context: tContext })
  const t2 = Date.now()
  log('Strategy output', strategy)

  const innerMonologue = await tAgent({ question, intent: parsed.intent, emotion: parsed.emotion, focus: parsed.focus, context: tContext, strategy })
  const t3 = Date.now()
  log('T output', innerMonologue)

  let finalAnswer = await pAgent({ innerMonologue, question, context: tContext, strategy })
  let critic = await criticAgent({ question, answer: finalAnswer, context: tContext, strategy })
  const initialAnswer = finalAnswer
  let retryCount = 0

  // 最多一次自纠错：避免把一次预演变成不可控的多次 LLM 调用。
  if (critic._parseOk && !critic.passed) {
    retryCount = 1
    finalAnswer = await pAgent({ innerMonologue, question, context: tContext, strategy, criticFeedback: critic.failure_reason })
    critic = await criticAgent({ question, answer: finalAnswer, context: tContext, strategy })
  }

  const t4 = Date.now()
  log('P final', finalAnswer)
  log('Critic output', critic)

  return {
    answer: finalAnswer,
    trace: {
      parsed,
      strategy,
      critic,
      retry_count: retryCount,
      prior_turns_used: priorBlock ? priorTurns.slice(-3).length : 0,
      changed_after_critic: retryCount > 0 && finalAnswer !== initialAnswer,
      timing: { q_agent_ms: t1 - t0, strategy_agent_ms: t2 - t1, t_agent_ms: t3 - t2, p_critic_ms: t4 - t3, total_ms: t4 - t0 }
    }
  }
}
