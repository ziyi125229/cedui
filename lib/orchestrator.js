// Orchestrator · Q-Agent → T-Agent → P-Agent
import { qAgent } from './agents/q-agent.js'
import { tAgent } from './agents/t-agent.js'
import { pAgent } from './agents/p-agent.js'

const DEBUG = process.env.DEBUG_AGENTS === 'true'
const log = (label, payload) => { if(DEBUG) console.log(`[${label}]`, typeof payload === 'string' ? payload : JSON.stringify(payload)) }

function buildPriorBlock(priorTurns){
  if(!Array.isArray(priorTurns)||!priorTurns.length)return ''
  const lines=priorTurns.slice(-3).map(t=>{
    const q=typeof t?.q==='string'?t.q.trim().slice(0,200):''
    const a=typeof t?.a==='string'?t.a.trim().slice(0,240):''
    return a?`· 当你听到“${q}”时，你曾回应：“${a}”`:''
  }).filter(Boolean)
  return lines.length?`PREVIOUSLY TA SAID:\n${lines.join('\n')}`:''
}

export async function askPartnerPipeline(question, context = {}, priorTurns = []) {
  const t0=Date.now();log('Q input',question)
  const parsed=await qAgent(question);const t1=Date.now();log('Q output',parsed)
  const priorBlock=buildPriorBlock(priorTurns)
  const tContext=priorBlock?{...context,prior_block:priorBlock}:context
  const innerMonologue=await tAgent({question,intent:parsed.intent,emotion:parsed.emotion,focus:parsed.focus,context:tContext})
  const t2=Date.now();log('T output',innerMonologue)
  const finalAnswer=await pAgent({innerMonologue,question,context:tContext})
  const t3=Date.now();log('P output',finalAnswer)
  return {answer:finalAnswer,trace:{parsed,inner_monologue:innerMonologue,prior_turns_used:priorBlock?priorTurns.slice(-3).length:0,timing:{q_agent_ms:t1-t0,t_agent_ms:t2-t1,p_agent_ms:t3-t2,total_ms:t3-t0}}}
}
