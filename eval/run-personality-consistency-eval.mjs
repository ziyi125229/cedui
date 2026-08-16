// E1 · 人格一致性 Eval V1 · runner
//
// 目标：验证「测对儿」四维度人格（E/I 表达欲、F/S 追逐节奏、O/G 心理空间、C/A 关系焦虑）
// 是否真正影响 Agent 的心理推演（T-Agent 的 inner_monologue）与最终表达（P-Agent 的 answer），
// 而不是仅仅被识别后没有进入后续生成。
//
// 被测对象：lib/orchestrator.js 的 askPartnerPipeline（Q → T → P），与生产端点 api/ask.js
// 对外暴露的是同一条 pipeline。本脚本不修改 lib/、api/ 下任何生产代码。
//
// 两种运行模式（自动探测，优先级从上到下）：
//   1) local  — 本机能读到 .env.local 或环境变量里的 LLM_API_KEY / LLM_MODEL 时，
//               直接 import askPartnerPipeline 本地跑，可以拿到完整的
//               trace.inner_monologue（心理推演）+ answer（最终表达）。
//               用法：NODE_USE_ENV_PROXY=1 node eval/run-personality-consistency-eval.mjs
//   2) remote — 本机没有 LLM key 时，退化为直接打生产端点 /api/ask（跟 run-eval.mjs
//               打 /api/scan 的方式一致）。api/ask.js 当前只回传最终 answer，
//               不回传 T-Agent 的原始 inner_monologue，所以 remote 模式下
//               inner_monologue 字段会被显式标记为 null + 原因，不会被虚构。
//   3) 如果两种模式都跑不通（比如完全没有网络），脚本会写出一个状态为
//      unavailable 的结果文件，明确说明没有跑成功，不会编造任何模型输出。
//
// 无论哪种模式，本脚本只负责「跑 + 落盘原始输出」，不打分。scoring 字段全部
// 初始化为 null，留给人工或后续一版 LLM-judge 脚本去填，避免虚构评分结果。
//
// 用法：
//   node eval/run-personality-consistency-eval.mjs
//   REPS=3 EVAL_BASE=https://cedui.vercel.app node eval/run-personality-consistency-eval.mjs

import { readFileSync, writeFileSync } from 'node:fs'

const REPS = Number(process.env.REPS || 2)
const GAP_MS = Number(process.env.GAP_MS || 3000) // 避开 api/ask.js 30/min 限流
const DEFAULT_BASE = 'https://cedui.vercel.app'
const BASE = process.env.EVAL_BASE || DEFAULT_BASE

const sleep = ms => new Promise(r => setTimeout(r, ms))

const DATASET_URL = new URL('./golden-personality-consistency-v1.json', import.meta.url)
const RESULTS_URL = new URL('./results-personality-consistency.json', import.meta.url)

function loadDotEnvLocal() {
  try {
    const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    for (const line of env.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (!m) continue
      let v = m[2].trim().replace(/^["']|["']$/g, '')
      if (!(m[1] in process.env)) process.env[m[1]] = v
    }
    return true
  } catch {
    return false
  }
}

async function detectMode() {
  const foundDotEnv = loadDotEnvLocal()
  if (process.env.LLM_API_KEY && process.env.LLM_MODEL) {
    return { mode: 'local', reason: foundDotEnv ? '.env.local 提供了 LLM_API_KEY/LLM_MODEL' : '环境变量里已有 LLM_API_KEY/LLM_MODEL' }
  }
  // 探测生产端点是否可达（不消耗真实 LLM 调用，只是连通性检查）
  try {
    const res = await fetch(`${BASE}/api/ask`, { method: 'OPTIONS' })
    if (res.status < 500) return { mode: 'remote', reason: `本机无 LLM_API_KEY，退化为直接调用生产端点 ${BASE}/api/ask` }
  } catch (e) {
    return { mode: 'unavailable', reason: `本机无 LLM_API_KEY，且无法连通生产端点 ${BASE}/api/ask（${e.message || e}）` }
  }
  return { mode: 'unavailable', reason: `本机无 LLM_API_KEY，生产端点 ${BASE}/api/ask 探测失败` }
}

// 校验 dataset 里手工同步的 personality_profile 是否仍与 lib/data/dimensions.js 的
// decodeDimensions 一致，避免 golden set 随生产代码演进悄悄漂移。只读 import，不修改。
async function verifyPersonalityProfiles(cases) {
  const { decodeDimensions } = await import('../lib/data/dimensions.js')
  const mismatches = []
  for (const c of cases) {
    const live = decodeDimensions(c.personality_code)
    if (!live) { mismatches.push({ case_id: c.case_id, reason: 'decodeDimensions 返回 null（code 格式不对？）' }); continue }
    const order = ['expressive', 'pace', 'space', 'anxiety']
    for (const key of order) {
      const liveDesc = live[key] && live[key].desc
      const storedDesc = c.personality_profile[key] && c.personality_profile[key].desc
      if (liveDesc !== storedDesc) {
        mismatches.push({ case_id: c.case_id, dim: key, stored: storedDesc, live: liveDesc })
      }
    }
  }
  return mismatches
}

async function callLocal(askPartnerPipeline, c) {
  const context = {
    relation: c.relationship_status,
    relation_category: 'romance',
    self_archetypes: [],
    partner_archetypes: buildPartnerArchetypes(c.personality_profile)
  }
  const t0 = Date.now()
  const result = await askPartnerPipeline(c.user_input, context, [])
  return {
    ok: true,
    answer: result.answer,
    inner_monologue: result.trace.inner_monologue,
    parsed: result.trace.parsed,
    timing: result.trace.timing,
    ms: Date.now() - t0
  }
}

async function callRemote(c) {
  const context = {
    relation: c.relationship_status,
    relation_category: 'romance',
    self_archetypes: [],
    partner_archetypes: buildPartnerArchetypes(c.personality_profile)
  }
  const t0 = Date.now()
  try {
    const res = await fetch(`${BASE}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: c.user_input, context })
    })
    const ms = Date.now() - t0
    if (res.status === 429) return { ok: false, status: 429, error: '限流(429)', ms }
    if (!res.ok) return { ok: false, status: res.status, error: await res.text(), ms }
    const data = await res.json()
    if (!data.ok) return { ok: false, status: res.status, error: data.error || 'ok:false', ms }
    return {
      ok: true,
      answer: data.answer,
      // remote 模式下生产端点不回传 T-Agent 的原始心理独白，明确标 null，不虚构
      inner_monologue: null,
      inner_monologue_unavailable_reason: 'api/ask.js 只回传最终 answer，不回传 trace.inner_monologue；需要 local 模式（本机配置 LLM_API_KEY）才能拿到心理推演原文',
      ms
    }
  } catch (e) {
    return { ok: false, status: 0, error: String(e.message || e), ms: Date.now() - t0 }
  }
}

function buildPartnerArchetypes(profile) {
  const order = ['expressive', 'pace', 'space', 'anxiety']
  return order.map(k => `${profile[k].label}：${profile[k].desc}`)
}

function emptyCaseScoring() {
  return {
    personality_match: null,
    relationship_fit: null,
    strategy_quality: null,
    expression_quality: null,
    safety: null,
    scored_by: null,
    notes: ''
  }
}

function emptyPairScoring() {
  return {
    personality_differentiation: null,
    scored_by: null,
    notes: ''
  }
}

async function main() {
  const dataset = JSON.parse(readFileSync(DATASET_URL, 'utf8'))
  const { mode, reason } = await detectMode()
  console.log(`[personality-eval] mode=${mode}  (${reason})`)
  console.log(`[personality-eval] cases=${dataset.cases.length}  pairs=${dataset.pairs.length}  reps=${REPS}`)

  const mismatches = await verifyPersonalityProfiles(dataset.cases).catch(e => {
    console.warn(`[warn] 无法校验 personality_profile 与 lib/data/dimensions.js 是否一致: ${e.message || e}`)
    return []
  })
  if (mismatches.length) {
    console.warn(`[warn] golden set 里的 personality_profile 与当前 lib/data/dimensions.js 不一致（可能是生产代码改了描述文案），共 ${mismatches.length} 处：`)
    for (const m of mismatches) console.warn(`  - ${m.case_id} ${m.dim || ''}: stored="${m.stored}" live="${m.live}"`)
  } else {
    console.log('[personality-eval] personality_profile 与 lib/data/dimensions.js 一致，未检测到漂移')
  }

  const resultCases = []
  let askPartnerPipeline = null
  if (mode === 'local') {
    ;({ askPartnerPipeline } = await import('../lib/orchestrator.js'))
  }

  if (mode === 'unavailable') {
    const summary = {
      generatedAt: new Date().toISOString(),
      status: 'unavailable',
      reason,
      note: '本次环境既没有本地 LLM_API_KEY，也无法连通生产端点，因此没有实际调用任何模型。以下只有 dataset 结构与打分模板，不包含任何模型输出，也没有虚构任何结果。',
      dataset_meta: dataset._meta,
      pairs: dataset.pairs.map(p => ({ ...p, scoring: emptyPairScoring() })),
      cases: dataset.cases.map(c => ({ ...c, runs: [], scoring: emptyCaseScoring() }))
    }
    writeFileSync(RESULTS_URL, JSON.stringify(summary, null, 2))
    console.log(`\n[personality-eval] 无法实际运行模型，已写入占位结果（不含任何虚构输出）：${RESULTS_URL.pathname}`)
    return
  }

  let n = 0
  const total = dataset.cases.length * REPS
  for (const c of dataset.cases) {
    const runs = []
    for (let rep = 0; rep < REPS; rep++) {
      n++
      const r = mode === 'local' ? await callLocal(askPartnerPipeline, c) : await callRemote(c)
      runs.push({ rep, timestamp: new Date().toISOString(), ...r })
      if (r.ok) {
        console.log(`[${n}/${total}] ${c.case_id.padEnd(12)} rep${rep}  ${r.ms}ms  answer: ${String(r.answer || '').slice(0, 60)}`)
      } else {
        console.log(`[${n}/${total}] ${c.case_id.padEnd(12)} rep${rep}  FAIL ${r.status ?? ''} ${r.error || ''}`)
      }
      if (n < total) await sleep(GAP_MS)
    }
    resultCases.push({ ...c, runs, scoring: emptyCaseScoring() })
  }

  const okCount = resultCases.reduce((acc, c) => acc + c.runs.filter(r => r.ok).length, 0)
  const totalRuns = resultCases.reduce((acc, c) => acc + c.runs.length, 0)

  const summary = {
    generatedAt: new Date().toISOString(),
    status: 'ran',
    mode,
    base: mode === 'remote' ? BASE : null,
    reason,
    config: { reps: REPS, gapMs: GAP_MS },
    reliability: { okCount, total: totalRuns, rate: totalRuns ? okCount / totalRuns : null },
    personality_profile_drift_check: mismatches,
    disclaimers: [
      '本文件中的 answer / inner_monologue 均为脚本运行时真实调用得到的原始输出，未经人工编辑或润色，未虚构任何模型结果。',
      mode === 'remote'
        ? '本次为 remote 模式：调用的是生产端点 /api/ask，只能拿到最终 answer；inner_monologue（T-Agent 心理独白原文）字段为 null，因为生产端点当前不回传它，不是模型没有产出，也不是被我们省略——见每条 run 的 inner_monologue_unavailable_reason。要拿到完整心理推演原文，需要在配置了 LLM_API_KEY / LLM_MODEL 的机器上以 local 模式重跑本脚本。'
        : '本次为 local 模式：直接 import lib/orchestrator.js 的 askPartnerPipeline，inner_monologue 是 T-Agent 的真实原始输出。',
      '本次每个 case 只重复了 ' + REPS + ' 次（受 api/ask.js 生产限流与评测成本限制），不构成统计意义上的大样本，只能做定性/half-quantitative 的 bad case 分析，不能得出「某维度 X% 情况下失败」这类精确统计结论。',
      'scoring 字段（personality_match / relationship_fit / strategy_quality / expression_quality / safety / personality_differentiation）全部为 null，需要人工或另一个 LLM-judge 脚本二次读取本文件的 answer / inner_monologue 后填入，本脚本不会自己打分，避免自证结果。'
    ],
    dataset_meta: dataset._meta,
    pairs: dataset.pairs.map(p => ({ ...p, scoring: emptyPairScoring() })),
    cases: resultCases
  }

  writeFileSync(RESULTS_URL, JSON.stringify(summary, null, 2))

  console.log('\n===== E1 人格一致性 Eval V1 · 运行摘要 =====')
  console.log(`mode: ${mode}${mode === 'remote' ? ' (' + BASE + ')' : ''}`)
  console.log(`可用率: ${okCount}/${totalRuns}`)
  console.log(`personality_profile 漂移检查: ${mismatches.length ? mismatches.length + ' 处不一致，见上方日志' : '一致'}`)
  console.log(`已写入原始输出（scoring 待填）: ${RESULTS_URL.pathname}`)
  console.log('下一步：对 results-personality-consistency.json 里每个 case 的 answer(+inner_monologue) 做人工/judge 打分，再按 pair 比较 personality_differentiation，据此做 Bad Case 分析。')
}

main().catch(e => { console.error(e); process.exit(1) })
