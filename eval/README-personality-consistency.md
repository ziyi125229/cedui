# E1 · 人格一致性 Eval V1

验证「测对儿」四维度人格代号（**E/I** 表达欲、**F/S** 追逐节奏、**O/G** 心理空间、**C/A** 关系焦虑）是否
**真正影响 Agent 的心理推演与最终表达**，而不是仅仅被识别后没有进入后续生成。

> 命名提醒：`run-eval.mjs` 里已经有一个内部叫「E1 单调性」的检查项（心动浓度按关系状态排序）。
> 这里的「E1」是产品同学给这套新 eval 起的编号，跟 `run-eval.mjs` 里的 E1/E2 是两条独立的编号体系，
> 只是字面撞了一下，不是同一件事，特此说明避免混淆。

## 这套 eval 复用了什么、新增了什么

**没有修改任何生产代码**（`lib/`、`api/`、`index.html`、`eval.html` 等一律未改动）。只新增了 3 个文件：

| 文件 | 作用 |
|---|---|
| `eval/golden-personality-consistency-v1.json` | golden set：4 pair / 8 case，字段结构对齐需求 |
| `eval/run-personality-consistency-eval.mjs` | runner：本地 import 或打生产端点，落盘原始输出，不打分 |
| `eval/results-personality-consistency.json` | 一次真实运行后的输出（见下方「实际运行结果」） |

复用的现有结构：

- **被测对象**：`lib/orchestrator.js` 的 `askPartnerPipeline`（`Q-Agent → T-Agent → P-Agent`），这条 pipeline
  正是生产端点 `api/ask.js`（前端「问 TA 一句」功能）对外暴露的同一条链路。
  - `trace.inner_monologue`（T-Agent 输出）= 本次要验证的**心理推演**阶段
  - `answer`（P-Agent 输出）= **最终表达**阶段
  - 这与 `run-judge-eval.mjs` 评「TA 没说出口的心里话」是另一条链路（`diary-agent`）；本次选择
    `ask` 链路是因为它天然把「心理推演」和「最终表达」拆成了两个可分别观察的产出，最贴合题目里
    「心理推演与最终表达」的措辞。
- **人格模型**：完全沿用 `lib/data/dimensions.js` 的 `DIMENSION_LABELS` / `decodeDimensions`，
  没有新增任何维度或标签。`run-personality-consistency-eval.mjs` 运行时会重新 `import decodeDimensions`
  对每个 case 的 4 字母代号解码一次，和 golden set 里存的 `personality_profile` 做逐字比对，
  如果生产代码把某个维度的描述文案改了，脚本会在日志里报「漂移」提醒，而不是静默用旧文案跑评测。
- **Runner 模式选择的写法**：跟 `run-eval.mjs`（打生产端点）/ `run-eval-local.mjs`（本地 import + 读
  `.env.local`）的模式完全一致，本脚本把两种模式都实现了，自动探测切换（见下文)。
- **命名 / 落盘习惯**：`golden-*.json` / `run-*-eval.mjs` / `results-*.json` 三件套，跟仓库里
  `golden-diary.json` + `run-judge-eval.mjs` + `results-judge.json` 的命名习惯保持一致。

## 测试设计：为什么人格挂在「TA」身上

`askPartnerPipeline` 的人格输入落在 `context.partner_archetypes` 上——T-Agent prompt 里写的是
「对方描述你（TA）是: `${partner_archetypes}`」，也就是说 T-Agent 生成的心理独白，人格是挂在
**TA（被回答的那一方）**身上的，`question` 则是「对方（发起提问的用户）刚问你的一句话」。

因此本次 8 个 case 的设计是：

- `personality_profile` / `changed_dimension` 描述的都是 **TA** 的人格（被测方）；
- `user_input` 是「用户」发给 TA 的一句话，`scenario` / `time_context` / `user_goal` 描述的是
  触发这句话的情境；
- 我们观察的是：**同一句 `user_input`、同一个关系状态，只把 TA 的某一个人格维度字母换掉之后**，
  T-Agent 的心理推演（`inner_monologue`）和 P-Agent 的最终表达（`answer`）是否发生了与该维度方向
  一致的、合理的变化。

这是本次测试设计的一个关键选择，如果后续想反过来测「用户自己」的人格如何影响用户自己该发的消息，
需要另设计一套 case（把人格挂在 `self_archetypes` 上，并且需要额外一个「代用户写话」的生成环节，
目前 `ask.js` 链路并不提供这个环节，`self_archetypes` 目前只是文本背景，没有被单独验证过是否被
T-Agent 有效使用）——这点也顺带呼应了题目本身要测的问题（人格信息有没有真正进入生成），建议列入
下一版 bad case 分析的观察项。

## 为什么人格描述用「逐维度拼接」而不是 `index.html` 里的 16 型号手写文案

`index.html` 里 `TYPES` 的 16 条 nickname / portrait 是整体创作的，同一个字母在不同型号组合里的
措辞会因为整体文风漂移而不同（比如 `ESGC` 的 portrait 通篇在讲「人群里很能聊，私下却很少深交」，
读起来更像是在描述 G 而不是 E）。拿手写文案做「只改一个维度」的对照实验，会把「文案风格差异」和
「维度本身的差异」混在一起，污染对照实验。

所以 golden set 改用 `lib/data/dimensions.js` 里逐维度的 `label + desc`，按
`表达欲 / 追逐节奏 / 心理空间 / 关系焦虑` 固定顺序拼成 4 条描述传给 `partner_archetypes`。
这样同一个 pair 内两个 case，除了被测维度那一条文本，其余 3 条逐字相同——这仍然是产品现有的
四维度人格模型，只是换了一种「喂给 LLM 的文本组织方式」，是**为了让对照实验更干净**，不是另起一套
人格框架。

## 4 组 8 个 Case 一览

| pair_id | 维度 | 关系 | 场景 | case A | case B |
|---|---|---|---|---|---|
| PAIR-EI-01 | E→I 表达欲 | 稳定恋爱中 | 今天没见面，想表达思念 | `E-EI-A-E`（ESGC） | `E-EI-B-I`（ISGC） |
| PAIR-FS-01 | F→S 追逐节奏 | 正在暧昧 | 两天没聊天，想主动联系 | `E-FS-A-F`（IFGC） | `E-FS-B-S`（ISGC） |
| PAIR-OG-01 | O→G 心理空间 | 稳定恋爱中 | 感觉对方不开心，想询问 | `E-OG-A-O`（ISOC） | `E-OG-B-G`（ISGC） |
| PAIR-CA-01 | C→A 关系焦虑 | 稳定恋爱中 | 对方忙几小时没回复 | `E-CA-A-C`（ISGC） | `E-CA-B-A`（ISGA） |

`ISGC`（含蓄 + 慢炖 + 防御 + 安全）作为 3 个 pair 的公共基线，每个 pair 只翻转一个字母，
最大程度减少维度之间互相污染。每条 case 完整保存了题目要求的全部字段：`case_id` / `pair_id` /
`personality_profile` / `relationship_type` / `relationship_status` / `scenario` / `time_context` /
`user_goal` / `user_input` / `expected_behavior` / `changed_dimension` / `expected_difference`，
详见 `golden-personality-consistency-v1.json`。

## 打分结构

`golden-personality-consistency-v1.json` 的 `_meta.scoring_rubric` 里定义了：

- 每个 case：`personality_match`（0-3）、`relationship_fit`（0-3）、`strategy_quality`（0-3）、
  `expression_quality`（0-3）、`safety`（Pass/Fail）
- 每个 pair 额外：`personality_differentiation`（0-3，按题目给定的 0/1/2/3 定义）

`run-personality-consistency-eval.mjs` 只负责把这些字段初始化成 `null` 并落盘在
`results-personality-consistency.json` 里，**不会自己打分**——避免用同一个/类似的模型自证自己的输出，
也避免在没有实际跑通判分逻辑的情况下虚构分数。打分需要人工，或者仿照 `run-judge-eval.mjs` 的思路
另写一个 judge 脚本二次读取 `results-personality-consistency.json` 里的 `answer`（+`inner_monologue`，
仅 local 模式下有）来打分。

## 能否实际运行 / 实际运行结果

**本次沙箱环境没有 `LLM_API_KEY`，也没有 `vercel` CLI / 登录权限去 `vercel env pull`**，所以无法用
`run-eval-local.mjs` 那种本地直连模式跑出完整的 `trace.inner_monologue`。

但生产端点 `https://cedui.vercel.app/api/ask` 在沙箱里网络可达，且它本身就是
`askPartnerPipeline` 的生产入口，所以 `run-personality-consistency-eval.mjs` 实现了自动降级：

1. 优先探测本机 `LLM_API_KEY` / `LLM_MODEL`（含 `.env.local`）→ **local 模式**：直接
   `import { askPartnerPipeline } from '../lib/orchestrator.js'`，可以拿到完整的
   `answer` + `inner_monologue`。
2. 探测不到 → **remote 模式**：直接 `POST` 生产端点 `/api/ask`，只能拿到最终 `answer`；
   `inner_monologue` 字段会被显式标记为 `null` + 原因说明，**不会虚构**。
3. 如果连生产端点也连不上 → 写出 `status: "unavailable"` 的结果文件，只有 dataset 结构和
   全 `null` 的打分模板，同样不会虚构任何模型输出。

**本次实际发生的是第 2 种情况**：已经用 remote 模式跑通了全部 8 个 case × 2 次重复
（共 16 次真实调用生产端点），16/16 全部成功返回，原始 `answer` 已经落盘在
`results-personality-consistency.json`，可以直接拿去做 bad case 分析。**心理推演阶段
（`inner_monologue`）这次没有拿到**——生产端点 `api/ask.js` 目前不会把 T-Agent 的原始独白
返回给调用方，我们又不能修改生产代码去加这个字段，所以只能先看最终表达一侧。如果之后能拿到
`LLM_API_KEY`（比如 `vercel env pull .env.local --environment=production`），直接重跑同一个
命令即可自动切到 local 模式补上 `inner_monologue`：

```bash
node eval/run-personality-consistency-eval.mjs
# 或指定重复次数 / 生产端点：
REPS=3 EVAL_BASE=https://cedui.vercel.app node eval/run-personality-consistency-eval.mjs
```

## 已知局限（诚实列出，不是能力清单）

- **样本量很小**：每个 case 只重复 2 次（受生产限流 30/min 与评测成本限制），只能做定性 /
  half-quantitative 的 bad case 分析，不能得出「某维度在 X% 场景下失败」这类统计结论。
- **remote 模式看不到心理推演原文**：只能通过最终 `answer` 反推「心理推演有没有真的发生」，
  不能直接读到 T-Agent 的独白文本。这恰好也是题目最关心的风险点之一（人格信息有没有真正进入生成，
  而不是被识别后就丢了），建议尽快在有 `LLM_API_KEY` 的环境里补跑一次 local 模式，拿到
  `inner_monologue` 后重新做一轮分析。
- **人格只挂在 TA 一侧**：如上文「测试设计」一节所述，`self_archetypes`（用户自己的人格）在
  `ask.js` 链路里目前只是背景文本，没有被这套 eval 单独验证过是否真的影响生成。
- **`score`（契合指数）固定用默认值**：没有把契合分作为变量，所有 case 都用 T-Agent 的默认值
  （`context.score` 不传，走 prompt 里 `|| 70` 的默认），避免引入额外的混淆变量，但也意味着没有
  测试契合分对人格表达的交互影响。
- **打分全部留空**：`personality_match` / `relationship_fit` / `strategy_quality` /
  `expression_quality` / `safety` / `personality_differentiation` 都是 `null`，需要下一步人工或
  judge 脚本二次处理。

## 下一步（bad case 分析）

打开 `results-personality-consistency.json`，按 `pair_id` 把两个 case 的 `answer` 放在一起对比：

- 如果同一个 pair 里两个 `answer` 除了措辞几乎在说同一件事、用同一种策略，就是
  `personality_differentiation` 该打低分（0/1）的候选 bad case；
- 重点看 `PAIR-CA-01`（C/A 关系焦虑）：检查 `answer` 里有没有把「你是不是不在乎我了」这类主观猜测
  当成确定陈述说出来（而不是用「有点」「可能」之类的不确定语气），这类应该记 `safety: Fail`；
- `PAIR-EI-01`（表达欲）两次真实调用里，两个版本的差异肉眼看偏小（都用了「......」开头、都简短），
  值得作为第一个 bad case 深入看一下——是不是 `partner_archetypes` 这条信号在 T-Agent prompt 里
  的权重不够，被「关系状态」「问题」这些更强的信号盖过去了。
