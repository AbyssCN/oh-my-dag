# SDD — review 深度升级:实测把"DAG 分解"证否,收敛到单 agent

> 承接会话:omd-review 深度评估 → 升级共享承重件 runReview。执行契约。
> 日期 2026-07-22。状态:**SUPERSEDED by 实测**——DAG 分解路径(compileReviewPlan/verify-map)
> 经 4 轮 A/B + 3 方埋 bug 召回测**明确败给单 agent**,已删。最终交付 = `run-single.ts`(单 agent 深审)。

## ★ 实测结论(收口,2026-07-22)

**问题**:omd-review 深度天花板 + 我常驳 finding。**实测 4 轮**(baseline / DAG-verify-map v1 / +强制oracle v2 / DAG-find+确定性verify v3)+ **3 方埋 bug 召回测**(authz P0 + null-deref P1):

| 臂 | 真 bug 召回 | 假阳性 | 备注 |
|---|---|---|---|
| baseline(diff-盲 find + mimo verify) | **2/2** | 0 | 多维度冗余(7 条报 2 bug,无去重)|
| DAG 分解 find + 确定性 verify(v3) | **2/2** | **2 假 REFUTED**(路径截断)| + tool flaky / mimo 驱动不了工具 |
| **单 agent(不分解)+ 确定性 verify** | **2/2** | **0** | **最干净:自然去重、推理最好、最简** |

**裁决**:
1. **召回退化担忧证否**——三臂全 2/2,分解/保守 find 不丢真 logic bug。
2. **DAG 分解 = 过度工程**:没加召回,精度更差(路径截断假证伪),故障模式更多(tool stale、mimo 当 agent 驱不动工具),代码最重 → **删**。
3. **单 agent 最优**:一个连贯 context 看全 diff + 读全仓 + 强制 oracle 实测(杀 $.cwd 类外部 API 幻觉)→ 确定性 verifyFindings(mimo 当纯 judge,不驱工具)。**跨模型仍在**(deepseek find + mimo verify)。
4. **强制 oracle 纪律**(库/runtime API 主张必须 `bun -e` 实测,跑不出不报)是治幻觉的关键,保留在单 agent goal。
5. 附带修:mimo `xhigh`→HTTP 500(降 `high`,.env);review agent 限 `read+bash` 只读硬化。

**最终交付**:`run-single.ts` + `runReview` 分流 `opts.single ?? OMD_REVIEW_SINGLE=1`(默认 off,baseline 不动);`dag-review --single` 深审入口。契约冻结不变(dag-review/dag-build 消费点无改)。

---
> 以下为原始 DAG-native 设计(已 SUPERSEDED,留档记录被证否的路径)。

## 0. 一句话

把 `runReview` 的内核从 diff-盲的 `Promise.all` 升成 executor-dag:**find 变 agent 叶能读代码库**(从源头掐掉"X 在 diff 外"整类误报)+ **verify 用 `map` over findings**(每 finding 一个 agent skeptic 全工具取证)。**契约冻结 + 默认 off 灰度**,两调用方(/omd-review、dag-build)无感继承。

## 1. 动机(为什么值得动承重件)

- `runReview` 被 **两处共用**:`scripts/dag-review.ts`(手动审)+ `scripts/dag-build.ts:347`(fleet 建码绿后自动门控)。改深度 = 抬升"手动审"+"fleet 产码质量门"两条线,leverage 2×。
- 现实现深度天花板(实测:我经常驳 finding):① find 层**只喂 diff**,对 diff 外代码的主张无从查证 → 量产"X 未定义其实在 diff 外"/"缺守卫其实在 JOIN 里"整类误报;② verify 的 `gatherEvidence` 是 ±30 行窄确定性窗,判不动 → fail-open→CONFIRMED → 落人工。
- 跨模型 mimo verify(已配 .env)补 verify 侧;本 SDD 补 **find 侧代码库访问** + **verify 深度(agent map)**。

## 2. 铁律:契约冻结(REVIEW-1)

`runReviewDag(opts: RunReviewOpts): Promise<RunReviewResult>` **返回型与 `runReview` 完全一致**:
```
RunReviewResult { findings: ReviewFinding[]; verified?: VerifiedFinding[]; outPath; model; sddPath?; specSkipped? }
```
两调用方消费点(dag-review 取 findings/verified/outPath/sddPath/specSkipped;dag-build 取 findings/outPath)**一字不改**。灰度期 Promise.all 老路径原样保留。

## 3. 灰度 opt-in(REVIEW-2)

`runReview` 顶部分流:`if (opts.dag ?? env.OMD_REVIEW_DAG === '1') return runReviewDag(opts)`。
- **默认 off** → 老 Promise.all 不动,dag-build 零风险。
- `/omd-review` 加 `--dag` flag(dag-review.ts 传 `dag:true`)先灰度、measure S/N。
- 证明后:翻默认 / 或 dag-build 显式开。**不证明不切承重的 fleet 路径。**

## 4. 架构:compileReviewPlan(镜像已交付的 compileDebugPlan)

```
find_correctness ┐
find_security    ├─ 并行 sibling agent 叶(codegraph/read 读代码库)
find_boundary    ┤   goal = buildReviewPrompt(dim) + diff + 自证伪纪律(先查 diff 外真身再报)
find_contract    ┘   ← #3:find 拿代码库访问,源头掐 diff-盲误报
find_spec (G3)   ──   agent + SDD 注入(buildSpecReviewPrompt);无 SDD → 节点跳过
      ↓ 全部 feed
verify (map over findings)
  lister:  extractFindings 结构化 → {findings:[{id,severity,file,line,claim,symbols,dimension}]}
  template: agent skeptic per finding — 全工具取证(codegraph 调用链/impact + read)+ refute-first 裁决
  keyBy:   id (= findingKey: file+claim 前缀 hash;跨 lens 撞同一 bug 折叠 + resume 稳定)
  maxItems: 有界(默认 24)
      ↓
judge (leaf): findingKey 去重 + 严重度排序 + CONFIRMED-only 出口
```
收口 `PlanSchema.parse`。find_spec / verify 子是**只读**:goal 避 producesFiles 强写信号(回归守卫同 deepen/debug)。

## 5. 结果映射(REVIEW-3,DAG LeafResult → 冻结契约)

| 契约字段 | 来源 |
|---|---|
| `findings: ReviewFinding[]` | 每 `find_<dim>` 节点 output → `{dimension, text, ...screenFinding(text)}` |
| `verified: VerifiedFinding[]` | verify map 子:lister 的 ExtractedFinding(severity/file/line/claim/symbols/dimension)⋈ 子 VERDICT/reason |
| `outPath` | judge 输出 + 两轴分段组装落盘(同 run.ts 报告格式) |
| `sddPath`/`specSkipped` | find_spec 节点存在性 + SDD 定位结果 |
| `model` | findModel 坐标 |

## 6. 复用(不重写校准资产)

- find goal:`buildReviewPrompt` / `buildSpecReviewPrompt` 原样(+ 一段"你可读代码库,先自证伪再报,禁推测性 P0")。
- verify:`extractFindings`(lister 结构化逻辑)+ verifyOne 的 refute-first checklist(子 goal)+ `findingKey`(去重)。
- `screenFinding`(slop 软筛)、`DIMS_BY_GATE`、`ROUND_CAPS` 不变。
- 执行:`runExecutorDagWithPlan` + `createAgentLeafRunner`(agent 叶带工具),同 dag-deepen/dag-debug。

## 7. 反 happy-path 约束

1. **契约冻结**:runReviewDag 返回型 = runReview,消费方无改(REVIEW-1)。
2. **默认 off**:未证明前 fleet 路径走老实现,不炸 dag-build(REVIEW-2)。
3. **只读**:find/verify 全 agent 叶只读代码库,不写盘;提修仅文本(同现 review)。
4. **有界**:verify map maxItems + ROUND_CAPS 1 轮,防扇出膨胀。
5. **降级**:agent 叶符号→codegraph/文本→ugrep 双路(agent-leaf 原生),codegraph 缺不硬依赖。

## 8. 交付 + 测试

| 文件 | 内容 |
|---|---|
| `src/harness/review/review-plan.ts` | compileReviewPlan(find/verify-map/judge)+ JUDGE/VERIFY 节点 id |
| `src/harness/review/run-dag.ts` | runReviewDag(executor-dag → RunReviewResult 映射) |
| `src/harness/review/run.ts` | 顶部 opts.dag/OMD_REVIEW_DAG 分流(≤5 行) |
| `scripts/dag-review.ts` | `--dag` flag → dag:true(灰度入口) |
| 测试 | `review-plan.test.ts`(plan shape + find 只读守卫 + verify map spec)· `run-dag.test.ts`(注入 fake _runDag → 验契约映射) |

`tsc --noEmit && bun test`(review 相关)全绿才 commit。review 模块独立,不碰 registry 在途工作。

## 9. Phase 边界

- **本 SDD(Phase 1)**:全 DAG-native path(find agent + verify map + judge),灰度 opt-in,契约冻结。
- **非目标**:不翻默认(measure 后另议);不改 Promise.all 老路径;不动 dag-build 的门控逻辑(它自动继承分流)。
