# 统一模型 registry —— 单一真源, 两栈共读

> 设计 SDD。**已过两轮 /omd-grill** —— 初版 (07-21) 假设"泛化 pi 扩展"统一两栈; 二次 (07-22) **实证证伪该机制**
> (pi.registerProvider 对 agent-leaf 架构性无效, 见 ## 机制证伪) → 单一真源翻转为 **`~/.pi/agent/models.json`**
> (pi 原生自定 provider 存储, 两栈共读)。D-* 见 ## 决策, O1–O7 见文末决策记录。
> 触发起因: Nick「配个模型怎么这么费劲… 又是映射又是 pi-transport… 不能有个 mcp 的 model registry 吗」
> + mimo/ultraspeed agent-leaf 跑不通的根因排查 (根因 = pi 扩展死路 + 静默吞错)。

## 目标 (Destination)

模型配置收敛到**单一真源**:一份配置(provider + per-model 属性)→ **两套调用栈都从它派生**。加一家 API /
一个模型 = 改一处、经 MCP 工具登记, 不碰代码、不在 N 个地方各写一遍。thinking / maxTokens 有合理默认。
删掉 `mimo-provider.ts` 那类"补 pi-ai 目录缺口"的一次性补丁 —— 它们是分裂的症状。

判据: 在 MCP 里 `omd_register_provider` 登一家新 openai-compat 端点 + 一个模型 → **conductor(callModel 路径)
和 agent-leaf(pi 会话路径)都立即能用**, 且解析出一致的 {reasoning, maxTokens, thinking, cost}, 无需改任何 .ts。

## 背景: 当前的分裂 (grounded, 本 session 实证)

**两套模型调用栈 + 两套目录:**
1. **xihe 自有** — `src/model/providers.ts`(env→provider 注册)+ `index.ts` `resolveModel`(自有 registry 优先,
   miss 探 pi-ai 目录)+ `pi-transport.ts`(pi-ai 目录后备)。服务 `callModel`: conductor / inproc leaf / verifier / dream / judge。
2. **pi-ai 依赖** — `@earendil-works/pi-ai/compat` `getModel` + `createAgentSession`。服务 **agent-leaf**([agent-leaf.ts:190](../../src/harness/agent-leaf.ts))。

**配置散在四处:** `.env`(key)· `.omd/config.json`(角色→模型, 经 `omd_set_role`)· `~/.pi/agent/auth.json`
(pi OAuth/key)· **per-model 属性**(reasoning/maxTokens/thinking/cost)分散在 pi-ai catalog(依赖内)、
`index.ts` 默认(max_tokens ?? 4096)、`agent-leaf.ts` 硬编码(thinkingLevel xhigh)、`cost-ledger.ts` `DEFAULT_PRICES`。

**已咬人的分裂:**
- **mimo agent-leaf 全废**(本 session 根因): mimo 在 xihe registry 但**不在 pi-ai catalog** → `getModel('mimo',…)`
  返空 `{}` → agent 节点 empty-done。pi-ai 0.80 拆全局注册表后的回归。临时补丁 `src/model/mimo-provider.ts`
  经 `pi.registerProvider` 正门补上 —— 这是**第三处**登记, 正是分裂的症状(详见 [[omd-two-model-stacks]])。
- **divergent behavior**: pi-transport 正常完成但 content 空时**静默返 `{text:''}`**([pi-transport.ts:412](../../src/model/pi-transport.ts), 无 guard),
  而 index.ts **有** guard 会响亮报 `truncation`([index.ts:363](../../src/model/index.ts))。两路两行为。
- **thinking 默认 doc/code 不一致**: [agent-leaf.ts:84](../../src/harness/agent-leaf.ts) 注释"默认 medium", :153 实际 `?? 'xhigh'`。

## 机制证伪 (2026-07-22 二次 grill —— 推翻初版 D-2 假设)

初版 SDD 假设"泛化 `mimo-provider.ts` 的 `pi.registerProvider` 扩展"能统一 pi 侧。**实证证伪, 该机制对 agent-leaf 架构性无效:**
- [agent-leaf.ts:191](../../src/harness/agent-leaf.ts) 在 `createAgentSession` **之前**用 compat `getModel(provider, modelId)`(静态 builtin catalog)解析出模型对象 `m`, 再建 session。扩展的 `pi.registerProvider` 在 session **内部**跑 —— 永远晚于 getModel, 解析恒空。
- 亲测 (mimo-provider.ts 头注): 挂载扩展后 agent-leaf 用 `mimo:…` 仍 0-token 静默失败。
- **pi 认自定 provider 的真机制 = `~/.pi/agent/models.json`**(pi ModelRuntime 原生加载)。该文件已有活的自定条目: `zhipu` / `minimax-cn` / `mimo-platform`(baseUrl+apiKey+api+models), 证明这是正门。

## 决策 (Decisions —— 二次 grill 修正后, 2026-07-22)

- **D-1 · 单一真源 = `~/.pi/agent/models.json`** (pi 原生文件, 非 config.apis、非新建 models.json)。它已是 pi
  认自定 provider 的存储, 已被 agent-leaf 原生读。*为什么*: 两栈里 agent-leaf 这栈**只能**从 models.json 认 provider
  (机制证伪), 那就让另一栈 (callModel) 也读它 → 真·单一真源。omd 不"生成/同步"它, 只**读 + upsert**, 从根上消除
  clobber 用户手调条目 (opencode-go compat flags 等) 的风险。

- **D-2 · 两栈共读 models.json** — ① agent-leaf: pi 原生读 (已通, 无需改) ② callModel/xihe: **新增
  `registerProvidersFromModelsJson()`** 读 models.json, 对每个**完整自定条目** (baseUrl+apiKey+api 齐全) 解析
  `$ENV` key → 注册进 xihe registry (openai-compatible); builtin-override 条目 (deepseek/opencode-go, 只 models
  无 baseUrl) **跳过** (pi-native, 走 env + pi-transport, INV-5) ③ **补 callModel 读 per-model 默认**: maxTokens
  从 models.json 的 model 条目读 (给足), 不再 `?? 4096`; thinking 走**全局** THINKING_DEFAULT (models.json 无
  per-model thinking 字段, 故 O6 简化为全局)。*为什么*: 一份文件两栈共读, INV-2 构造上成立, 无同步无 clobber。

- **D-3 · MCP 面 = upsert models.json** — 扩 `config-tools.ts`: `omd_register_provider`(id/baseUrl/keyEnv→`$KEY`/models)
  **upsert 进 models.json 的 providers 段**(按 id merge, 保留既有条目的 compat/其它字段, 不整体替换)+ `omd_set_model`
  (改某条目 per-model)+ `omd_config_status` 读 models.json 展示。key 仍 `omd_set_key`。*为什么*: Nick 要"通 MCP 直接
  登记多家 API"; 写 pi 原生文件即两栈同时生效。

- **D-4 · 收敛 divergent behavior** — pi-transport:412 补空-content guard(与 index.ts:363 对齐, `finishReason==='length'
  && !text.trim()` 抛 retryable `truncation`, 不静默 empty-done)· maxTokens 从 models.json 读给足默认 · thinking 走
  全局 THINKING_DEFAULT (修 agent-leaf 84/153 doc/code 不一致)。*为什么*: [记忆确认] pi/agent-leaf 栈**静默吞错**(失败
  返 0 token 空文本), 正是这次 mimo 排查绕 5 轮的元凶; 有 loud guard 第一轮就见 401/404。**本决策价值最高, 不可省。**

- **D-5 · cost 留 cost-ledger, 不并入** — `DEFAULT_PRICES` 保持坐标键单一真源; 自定 provider 价格经已有注入价表机制
  (ECON-1)叠加 overlay。*为什么*: [已查证 F2] DEFAULT_PRICES 已 model-agnostic / frozen / fail-open, 搬进配置反而劈两处。

- **D-6 · 删 mimo-provider.ts + 废弃 config.apis** — ① `mimo-provider.ts` (pi 扩展)是**证伪的死路**, 连同 3 处挂载
  (agent-leaf/pi-runtime/tui)删; mimo agent-leaf 靠 models.json 的 `mimo-platform` (已工作) ② `config.apis` /
  `registerCustomApis` / 初版 Phase 1 的 `ApiDef.models` **能力冗余** (models.json 是其超集, 还多覆盖 agent-leaf 栈)
  → 归到本 SDD cleanup 删除 (动 tui:166 / headless-config / config-center / bootstrap / index 5 处调用点)。
  *为什么*: 补丁与冗余源的存在本身就是要消除的分裂。**注**: 初版 Phase 1 已落的 `resolveModelDef`/`THINKING_DEFAULT`/
  `MAX_TOKENS_DEFAULT` 里, 后两个默认常量保留复用 (D-4 全局默认), `ApiDef.models`/`resolveModelDef`/`filterModels`
  随 config.apis 一并废。

## 契约 (Contracts)

### 接口结晶 (SDD, 执行器逐字段照写)

**C-1 · models.json reader** (新, 建议 `src/model/models-json.ts`):
```ts
// 读 ~/.pi/agent/models.json 的完整自定 provider 条目 (baseUrl+apiKey+api 齐全者)。
// builtin-override 条目 (只 models 无 baseUrl, 如 deepseek/opencode-go) 跳过 (INV-5)。
// $ENV 引用 (如 "$ZHIPU_API_KEY") 从 process.env 解析; 缺 key → 跳过该 provider (INV-4)。
export interface ModelsJsonEntry { id: string; baseUrl: string; apiKey: string; api: string; models: { id: string; maxTokens?: number; contextWindow?: number }[]; }
export function readCustomProviders(env?: Record<string,string|undefined>): ModelsJsonEntry[];
export function modelsJsonPath(): string; // ~/.pi/agent/models.json (PI_AGENT_DIR 可覆盖)
```

**C-2 · callModel 侧注册** (新, `providers.ts` 加, 与 `registerProvidersFromEnv` 同级):
```ts
// readCustomProviders() → registerProvider(id, {baseUrl, apiKey, api:'openai-compatible', defaultModel})。
// 幂等; boot 时于 registerProvidersFromEnv 之后调 (bootstrap.ts + tui.ts)。返回注册的 id。
export function registerProvidersFromModelsJson(env?: Record<string,string|undefined>): string[];
```

**C-3 · 全局默认常量** (复用初版已落, `role-models.ts`):
```ts
export const THINKING_DEFAULT = 'max';          // 全局 thinking 默认 (Nick 要 max; models.json 无 per-model thinking 字段)
export const MAX_TOKENS_DEFAULT = 32_768;       // callModel maxTokens 兜底 (给足治 reasoning 吃预算; models.json 条目有 maxTokens 时优先)
```

**C-4 · MCP upsert** (`config-tools.ts` 加, upsert `~/.pi/agent/models.json`):
```ts
// omd_register_provider(id, baseUrl, keyEnv, models) → 读 models.json → 按 id merge upsert providers[id]
//   (保留既有条目的 compat/headers 等未提供字段, 不整体替换) → 写回。apiKey 落 "$<keyEnv>" 引用。
// omd_set_model(coord, {maxTokens?, contextWindow?}) → upsert 对应 provider 的 model 条目。
```

**C-5 · 空-content guard 对齐** (`pi-transport.ts:412` 补, 镜像 [index.ts:363](../../src/model/index.ts)) —— **已落**:
`finishReason === 'length' && !text.trim()` → 抛 `ModelError('truncation', …)` (retryable), 不返 `{text:''}`。
*范围*: 修的是 **callModel 栈内部** (index.ts vs pi-transport) 分歧。**agent-leaf 栈** 的静默吞错在 pi
`createAgentSession` 内部 (不走 pi-transport), 是**另一层** —— 见 C-5b。

**C-5b · agent-leaf loud-error** (新, `agent-leaf.ts` 返回前): session 结果 `text` 空 + (stalled / finish 截断)
→ 明确信号 (抛或结构化 error 标记), 不返空文本当成功。*为什么*: [记忆确认] agent-leaf 0-token 静默失败是这次
mimo 排查绕 5 轮的元凶; C-5 只护 callModel 栈, agent-leaf 栈要独立一道。**本轮未落, 待实装。**

### 不变量 (INV)
- **INV-1** 加一家 API / 一个模型 = 改**一处** (`~/.pi/agent/models.json`, 手写或 MCP), 零 .ts 改动。
- **INV-2** 两栈(callModel + agent-leaf)对同一 `provider:model` 坐标见到**同一** provider 定义 —— 由两栈都读
  `~/.pi/agent/models.json` 保证 (agent-leaf pi 原生 / callModel 经 C-2)。cost 一致由 cost-ledger 单一真源保证 (D-5)。
- **INV-3** 空-content / 截断在两栈都**响亮报错**(retryable truncation), 绝不静默 empty-done。
- **INV-4** 无凭证 provider (`$ENV` key 缺) **fail-open**: 跳过注册 + 告警, 不崩会话。
- **INV-5** pi-ai **原生** / builtin-override 条目 (deepseek/opencode-go, 无 baseUrl) 不被 callModel 侧重复登记 (走 env + pi-transport)。

### GWT 验收点
- **GWT-1** *Given* 一个新 openai-compat 端点经 `omd_register_provider` 写进 models.json, *When* conductor(callModel)
  规划 **且** agent-leaf 用它改文件, *Then* 两者都成功, 无需改代码。
- **GWT-2** *Given* 一个 reasoning 模型 + 低 maxTokens, *When* 它在 agent-leaf 里跑到截断, *Then* 报 `truncation`
  错(可重试), 不返空 → 不 empty-done(pi-transport 与 index.ts 同行为)。
- **GWT-3** *Given* 删掉 `mimo-provider.ts` + 3 处挂载, *When* 跑 `mimo-platform:…` agent-leaf, *Then* 仍正常写盘
  (models.json 的 mimo-platform 接管)。
- **GWT-4** *Given* `~/.pi/agent/models.json` 的一个完整自定条目 (如 zhipu), *When* callModel 经 C-2 注册后解析该坐标,
  *Then* xihe registry 里该 provider 的 baseUrl/apiKey/api 与 models.json 一致。
- **GWT-5** *Given* 一个自定条目的 `$ENV` key 对应 env 缺失, *When* boot 调 `registerProvidersFromModelsJson`, *Then*
  该 provider 跳过注册 + 告警, boot 不崩 (INV-4), 其余 provider 正常。
- **GWT-6** *Given* models.json 已有 `opencode-go`(带 compat flags), *When* `omd_register_provider` upsert 另一个 provider,
  *Then* opencode-go 的 compat flags 原样保留 (merge 不 clobber)。

## 分解 (Breakdown)

- **Phase 1** — `models-json.ts`: `readCustomProviders()` + `modelsJsonPath()` + `$ENV` 解析 (C-1)。全局默认常量
  `THINKING_DEFAULT`/`MAX_TOKENS_DEFAULT` 已落 (初版 Phase 1, 复用)。
- **Phase 2** — callModel 侧: `registerProvidersFromModelsJson()` (C-2), 挂 boot (bootstrap.ts + tui.ts, 于
  `registerProvidersFromEnv` 之后); callModel maxTokens 从 models.json 条目读给足, thinking 走全局 THINKING_DEFAULT。
- **Phase 3** — MCP: `omd_register_provider` / `omd_set_model` upsert models.json (merge 保留既有字段) + `omd_config_status`
  读 models.json 展示 (C-4)。
- **Phase 4** — pi-transport:412 空-content guard (对齐 index.ts:363, C-5)。cost overlay 走注入价表 (D-5, **不搬** DEFAULT_PRICES)。
- **Phase 5** — cleanup: 删 `mimo-provider.ts` + 3 处挂载 (agent-leaf/pi-runtime/tui); 废弃 `config.apis` 链
  (`registerCustomApis` / `listCustomApis` / `ApiDef.models` / `resolveModelDef` / `filterModels` + 调用点 tui:166 /
  headless-config / config-center / bootstrap / index)。back-compat 验证: env providers + 角色映射不断。

**复用**: `config-tools.ts`(MCP 面雏形)· `registerProvidersFromEnv`(→ models.json reader 同级模板)·
`cost-ledger.ts` 注入价表机制 (ECON-1, → overlay)· `~/.pi/agent/models.json` (pi 原生, 已有 zhipu/mimo-platform 参照)。

## 非目标 (Non-goals)

- 不重写 pi-ai: 它的 catalog 仍是 pi-ai **原生** provider(anthropic/deepseek)的来源, 我们只补 custom provider + 统一 xihe 侧。
- 不动 OAuth flow: kimi / anthropic 的 pi 内置 OAuth 登录不变(仍 `/login`)。
- 不改 `callModel` / `runExecutorDag` / `createAgentSession` 的**调用面** —— 只改它们背后的 model **解析来源**。
- 不做模型能力自动探测(端点 `/models` 拉取)—— 见 Open O3, 可能是后续。

## 决策记录 (Open O1–O7 已 grill 拍死, 2026-07-21)

| # | Open | 定论 | 依据 |
|---|------|------|------|
| O1 | 配置存哪 | **`~/.pi/agent/models.json`** (二次 grill 翻转: 初版选 config.apis 是在不知 pi 扩展死路前) | [已查证] models.json 已是 pi 原生自定 provider 存储, 有 zhipu/mimo-platform 活条目 |
| O2 | schema 形状 | pi 的 `ProviderConfigSchema` (baseUrl/apiKey/api/compat/models), 不自造 | [已查证] models.json 现有条目 |
| O3 | 属性来源 | **手填** (写 models.json); 端点 `/models` 探测出本 SDD | 草稿自陈 |
| O4 | back-compat | env provider (mimo/deepseek) 路径不动; models.json 叠加自定 | [已查证] registerProvidersFromEnv 是活路径 |
| O5 | native vs custom | callModel 侧只注册**完整自定条目** (baseUrl+apiKey+api); builtin-override (deepseek/opencode-go) 跳过走 pi-native | [已查证] models.json deepseek 只 models 无 baseUrl |
| O6 | thinking 默认 | **全局 THINKING_DEFAULT=max** (翻转: models.json 无 per-model thinking 字段, per-model 无处存) | [已查证] ProviderConfigSchema |
| O7 | usage 修并入 | **不并入** (已落 getSessionStats) | [已查证 memory] |

**二次 grill 的机制修正 + 三处翻转** (Nick 2026-07-22 拍板):
- **D-2 机制翻转**: pi 扩展 `pi.registerProvider` 对 agent-leaf **架构性死路** (agent-leaf:191 getModel 早于 session 扩展) → 改 `~/.pi/agent/models.json` 两栈共读 (agent-leaf pi 原生 / callModel 加 reader)。
- **O1 翻转**: 单一真源从 config.apis → models.json (pi 原生, 无同步无 clobber)。
- **D-6 扩围**: 删 mimo-provider.ts (死路) **+ 废弃 config.apis** (models.json 是其能力超集, Nick: "models.json 就能配不同 API")。
- **D-5 保持**: cost 留 cost-ledger + overlay (初版 grill 结论不变)。

---
*状态: 二次 grill 完 (机制修正), O1–O7 + D-* 重定型。下一步: /omd-execute 按 Phase 1–5 执行 (或 Aalto 手实, correctness 核心)。*
