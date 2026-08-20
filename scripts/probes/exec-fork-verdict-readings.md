# exec-fork verdict —— 读数报告

> 只写量到的。量不到的原样写 `null` / `missing` + 对应 `entry` + 原因,**不用任何数值形容词**
> (「近零」「很低」「约 0」这类措辞在本报告中禁止出现 —— `NULL` ≠ 0 ≠ 不适用)。
> 数据源(逐份核过,文件名与 `entry` 均合规,`exec-fork-metrics.ts --report` 退出码 0):
> `scripts/probes/readings/{ab-probe,baseline,control,treatment}.json`,四份 `entry` 全部 = `ran`。
> 报告日期 2026-08-13。写集限 `scripts/probes/`。

---

## 0. 一句话结论

四个信号 a/b/c/d **全部量到**:a=true(两路 `contextRebuilt` 均 true),b=`[0, 3225]`(首路首发 cache_read = `0`,次路 = `3225`),
c(噪声底)= `[0, 0.8928571428571429, 0]`,d(处理臂)= `[0.8235294117647058, 0.42857142857142855, 0.8421052631578947]`。
预声明判官判 `separable=false`。→ **选出口三:整条 exec-fork 轴归档**(依据见 §8)。

---

## 1. 信号 a —— resume 换 cwd 指向独立 worktree 能否重建上下文

| 项 | 值 | 来源 |
|---|---|---|
| 判词(事先写死) | 「不能则 B 路线不成立,整条 exec-fork 轴当场归档」 | 契约 §2 信号表 |
| `entry` | `ran` | ab-probe.json |
| 实测 a | **true** | `ab-probe.json.a` |
| 逐路证据 | `ab-probe-1.contextRebuilt = true`;`ab-probe-2.contextRebuilt = true` | ab-probe.json |
| `abortReason` | `null`(entry=ran,未中止) | ab-probe.json |
| seat | `claude-code:claude-sonnet-5` | ab-probe.json |

a=true ⇒ 判词前件(「不能」)不成立,**不据 a 归档**。

---

## 2. 信号 b —— 两路首发 `cache_read_input_tokens` 原始值

| 路 | `cacheReadInputTokensFirst` | 是否 >0 | `cacheCreationInputTokensFirst` |
|---|---|---|---|
| ab-probe-1 | `0` | 否 | `11316` |
| ab-probe-2 | `3225` | 是 | `8087` |

`ab-probe.json.b = [0, 3225]`。**这里的 `0` 是实测原始值 0,不是 null**(entry=ran,该路真跑过);
两者含义不同,不合并。C-9(首发即有 cache read)**只在第二路成立**,第一路首发为 `0`。

其余各路首发 cache_read 恒为 `3225`(baseline / control 6 路 / treatment 6 路,共 13 路,值全同)——
同一批 checkpoint 共同起点的表现。

---

## 3. 信号 c —— 对照臂(同 goal 两路)距离分布 = 噪声底

`control.json.entry = ran`,`groups = 3`,`abort = {triggered:true, reason:"budget_3_groups", atGroup:3, cumulativeWallclockMs:74206}`(预算上限正常中止,非异常)。

| group | pairDistance |
|---|---|
| 1 | `0` |
| 2 | `0.8928571428571429` |
| 3 | `0` |

原始 `distances = [0, 0.8928571428571429, 0]`;`distanceStats = {n:3, min:0, median:0, max:0.8928571428571429}`。

**噪声底不是零**:同 goal 两路在 group 2 上距离 `0.8928571428571429`,即 agent leaf 非确定性单独就能造出该量级的距离。
`control.json.verdict = null`(对照臂按契约不出裁决,c 是噪声底不是结果)。

**度量口径**(原样录自 `control.json.distanceNote`):距离由 `exec-fork-runner.ts` 内联算出 `dist(p1.output, p2.output)`,
对象是 agent stdout 全文,**不是 diff**;`exec-fork-distance.ts --readings-dir` 读本文件时 3 组全 SKIP
(`PathReading` schema 无 diffText/diffFile/outputDiff 字段,`resolveDiffText` 返回 null),属已知 schema 缺口,未越写集修引擎。

---

## 4. 信号 d —— 处理臂分布与 c 的可分性

`treatment.json.entry = ran`,`groups = 3`,`abort = {triggered:true, reason:"budget_3_groups", atGroup:3, cumulativeWallclockMs:95618}`。

| group | pairDistance |
|---|---|
| 1 | `0.8235294117647058` |
| 2 | `0.42857142857142855` |
| 3 | `0.8421052631578947` |

原始 `distances = [0.8235294117647058, 0.42857142857142855, 0.8421052631578947]`。

预声明判官(未事后修改)`treatment.json.verdict`:

```
separable      = false
reason         = "不同 goal 未与噪声底分离"
maxControl     = 0.8928571428571429
minTreatment   = 0.42857142857142855
thresholdUsed  = 0.1
noiseCap       = 0.25
```

即 `minTreatment(0.42857142857142855) < maxControl(0.8928571428571429) + 0.1`,且 `maxControl > noiseCap(0.25)`。
**d 不可分**(是实测判 false,不是「判不了」)。

---

## 5. 墙钟(单位 ms,原语墙钟 = max(N 路))

**逐路**

| arm / path | wallclockMs |
|---|---|
| ab-probe-1 | `23677` |
| ab-probe-2 | `28404` |
| baseline | `11792` |
| g1-c1 / g1-c2 | `15761` / `11706` |
| g2-c1 / g2-c2 | `10770` / `13122` |
| g3-c1 / g3-c2 | `11189` / `11658` |
| g1-t1 / g1-t2 | `15585` / `16890` |
| g2-t1 / g2-t2 | `14680` / `16731` |
| g3-t1 / g3-t2 | `15084` / `16648` |

**组级 / arm 级 max**

| 量 | 值 |
|---|---|
| control group1/2/3 armWallclockMaxMs | `15761` / `13122` / `11658` |
| treatment group1/2/3 armWallclockMaxMs | `16890` / `16731` / `16648` |
| control arm max | `15761` |
| treatment arm max | `16890` |
| ab-probe arm max | **missing**(`ab-probe.json` 无 `armWallclockMaxMs` 键;`entry=ran`;该文件为 A/B 探针,契约未要求 arm 级 max) |

**单路不分叉基线**:`baseline.json.armWallclockMaxMs = 11792`,`baseline.path.wallclockMs = 11792`,
`baseline.verdict = null`,`baseline.abort = null`,`baseline.path.contextRebuilt = null`(该字段在基线路未记,`entry=ran`;原因:基线单路不做 resume 换 cwd 观测)。

**差值**(原样取自 treatment.json,非本报告计算):
`wallclockVsBaseline = {treatment 16890, baseline 11792, diffMs 5098}`;
`controlVsTreatmentWallclock = {control 15761, treatment 16890, diffMs 1129}`。

**净正/净负判断**:处理臂 max 相对单路基线多 `5098` ms(`16890 / 11792 = 1.4323`,该比值由上述两数得出),
而质量侧 d 判 `separable=false` —— **多出的墙钟换不回可分的质量分布**,按契约 §4 裁定:关键路径上**净负**。

---

## 6. token / verify / 配额

**逐路 token**(in / out / cacheRead首发 / cacheCreation首发)

| path | in | out | cacheRead | cacheCreation |
|---|---|---|---|---|
| ab-probe-1 | `96259` | `742` | `0` | `11316` |
| ab-probe-2 | `149176` | `1368` | `3225` | `8087` |
| baseline | `69219` | `548` | `3225` | `10077` |
| g1-c1 | `69684` | `461` | `3225` | `10181` |
| g1-c2 | `69714` | `472` | `3225` | `10183` |
| g2-c1 | `69666` | `460` | `3225` | `10181` |
| g2-c2 | `69074` | `585` | `3225` | `10051` |
| g3-c1 | `69268` | `519` | `3225` | `10055` |
| g3-c2 | `71702` | `510` | `3225` | `10547` |
| g1-t1 | `76084` | `529` | `3225` | `11385` |
| g1-t2 | `76227` | `544` | `3225` | `11364` |
| g2-t1 | `75723` | `513` | `3225` | `11383` |
| g2-t2 | `73522` | `594` | `3225` | `11070` |
| g3-t1 | `71634` | `470` | `3225` | `10566` |
| g3-t2 | `73256` | `521` | `3225` | `10886` |

**verify**:15 路 `verifyPassed` **全部 = false**(ab-probe 2 + baseline 1 + control 6 + treatment 6)。
即两臂与基线在同一水平上,verify 不构成臂间差异;同时说明本批 sandbox 任务无一路通过 `bash verify.sh`。

**配额撞墙点**:15 路 `quotaWall.hit` 全部 = `false`,`quotaWall.rawError` 全部 = `null`
(`entry=ran`,即真跑过且未触发 `GoUsageLimitError` 一类)。**本次实验无配额撞墙点。**

**`costUsd` 非信号声明**(契约 §6):本报告全程未读取 `costUsd`。理由是本机 41 个坐标里 31 个走订阅口径、
`costUsd = null` 被合计跳过,`totalUsd` 恒等于 deepseek 一条计价线 —— 该数在两臂之间不会变化,量的是尺子不是被测对象。
成本侧只用上表 token 数与 `quotaWall`。

**`[cost]` 标签缺失**:`ab-probe.json.costTagSample = null`(`entry=ran`)。原因原样录自 `costTagNote`:
stdout 全程未出现 `[cost]` 行(全量日志 grep 0 命中),根因是 `[cost]` 只由 `src/harness/research/fanout.ts:498` 的
`stage('cost',...)` 打印、挂在 research 扇出路径,而 `exec-fork-runner.ts` 走 `runExecutorDagWithPlan` 直调,结构上不产出该 tag。
**此处为 `null`,不折算、不填 0。**

---

## 7. 两侧都记

契约要求:不塌 → 写清同 goal 也分化了多少;塌 → 写清不同 goal 也没分化。**本轮是塌的一侧,两侧读数都在:**

- **噪声底有多高**(不塌侧应填的数,实测):同 goal 两路 3 组距离 `[0, 0.8928571428571429, 0]`,max = `0.8928571428571429`,
  median = `0`,即三组里两组两路输出距离为 `0`、一组分化到 `0.8928571428571429`。
- **不同 goal 也没分化**(塌侧,实测):处理臂 3 组 `[0.8235294117647058, 0.42857142857142855, 0.8421052631578947]`,
  最小值 `0.42857142857142855` 落在噪声底 max 之下,`separable=false` —— **改 goal 措辞造出的差异,分不出噪声底之外的选择空间。**

---

## 8. 出口裁决(三选一,只选一个)

**裁决:`d 不可分 → 整条轴归档` —— 「若处理臂与噪声底(信号 c)不可分,`d 不可分则原语无 N 永久归档`——整条 exec-fork 轴归档,不再复议(除非有新的可证伪证据)。」**(逐字引自契约 §7 第三条)

依据读数(逐条对前件):
- 前件「处理臂与噪声底不可分」= **成立**:`treatment.json.verdict.separable = false`,
  `minTreatment 0.42857142857142855 < maxControl 0.8928571428571429 + thresholdUsed 0.1`,且 `maxControl > noiseCap 0.25`(§4)。
- 不选出口一(节点级就够 → 永久归档):其前件是「a/b/c/d 显示节点级 resume 已能拿到分叉本该有的收益」——
  a=true 只证明 resume 能重建上下文,c/d 未显示任何可测收益,**收益侧无读数支持**,前件不成立。
- 不选出口二(收益存在但粒度不够 → 重写 SDD):其前件是「确有可测收益」——d 判 `separable=false`(§4),
  且墙钟侧净负(diffMs `5098`,§5),**收益不存在**,前件不成立。

裁决只依赖 c/d 两格实测值;a=true 与 b=`[0, 3225]` 不改变该裁决(它们证明的是通道可用,不是收益存在)。

---

## 9. 已知 / 未知 / 下一步

**已知**:四文件 `entry` 全 `ran`;a=true;b=`[0, 3225]`;c=`[0, 0.8928571428571429, 0]`;d=`[0.8235294117647058, 0.42857142857142855, 0.8421052631578947]` 且 `separable=false`;
两臂各 3 组后按 `budget_3_groups` 正常中止(累计墙钟 control `74206` / treatment `95618`);15/15 路 `verifyPassed=false`;15/15 路无配额撞墙。

**未知(原样保留为 null/missing,不数值化)**:
- `ab-probe.json.armWallclockMaxMs` = **missing**(该文件无此键)。
- `ab-probe.json.costTagSample` = `null` —— 原因见 §6(结构上不产出 `[cost]` tag)。
- `baseline.json.path.contextRebuilt` = `null`;`baseline.json.verdict` = `null`;`baseline.json.abort` = `null`;`control.json.verdict` = `null`。
- 15 路 `quotaWall.rawError` = `null`(因 `hit=false`,无错误串可录)。
- 基于 diff 的距离度量 = **未测**:`exec-fork-distance.ts --readings-dir` 3 组全 SKIP(schema 无 diff 字段),本轮距离全部基于 stdout 文本。

**下一步(裁决已定,只留证伪通道)**:整条轴归档;若将来要复议,需要的新可证伪证据是
**基于 diff(而非 stdout 文本)的距离度量下,处理臂最小值高于噪声底 max + 0.1** —— 即先补 `PathReading` 的 diff 字段再重跑同批设计。

---

## 10. 自检

- 本报告每个数字均逐字取自 `scripts/probes/readings/*.json`,无推算值;唯一由两数得出的是 §5 的比值 `1.4323`,已标明来源。
- `null` / `missing` 一律原样书写并附 `entry` 与原因;全文未出现「近零 / 很低 / 约 0」一类数值形容词。
- `0`(实测零)与 `null`(未记)与 `missing`(无该键)三者全文分开,不合并。
- 事先写死的判词与出口原文逐字引用,未新增条件、未放宽阈值。
- 出口裁决有且仅有一个(§8),引用契约 §7 第三条原文。
- 机械核对:`bun run scripts/probes/verdict-report-crosscheck.ts` 退出码 0;反向自检已实做
  (把 `23677` 改成 `23678` → exit 1「报告缺 ab ab-probe-1 wallclock = 23677」,改回后 exit 0)。
- 上游产物闸:`bun run scripts/probes/exec-fork-metrics.ts --report` 退出码 0(四文件名合规,`entry` 三态合规)。

---

## 11. 写集与 docs/ 归因(收尾 `git status --short --untracked-files=all` 白名单校验)

**本节点新增/修改的文件**(仅这两个):
- `scripts/probes/exec-fork-verdict-readings.md`(本报告)
- `scripts/probes/verdict-report-crosscheck.ts`(数字核对闸,含反向自检)

**未被清理的 4 个 docs/ 未跟踪文件 —— 逐个归因,均不动**(不得改动无法明确归因的用户文件):

| 路径 | mtime | 归因判断 |
|---|---|---|
| `docs/plan/2026-08-11-四要素定稿-owner-2026-08-11-加第-4-条信号-假设-cubesandbox-能.md` | `2026-08-11 18:27:54` | 早于本实验(本轮 run 在 2026-08-13),主题为 cubesandbox 四要素,非本实验产物 → 不动 |
| `docs/plan/卡与profile-流程图.html` | `2026-08-11 17:37:27` | 同上,主题无关 → 不动 |
| `docs/reference/harness-firsthand-2026-08-11/SELF-AUDIT.md` | `2026-08-11 17:57:21` | 同上,主题无关 → 不动 |
| `docs/plan/2026-08-12-这是-grill-exec-fork-verdict-的解冻闸-它出读数之前-exec-fork.md` | `2026-08-13 00:17:39` | 本实验时间窗内,但内容是本票的**契约/任务书原文**(§2 信号表、§7 三出口的引用源,全程被各节点读取),不是报告类误写产物;删除它等于删掉本轮裁决的判据来源 → 不动,仅在此登记 |

**因此不作「唯一改动文件」一类声明**:本节点写集是上面两个文件;工作区里另有 4 个 docs/ 未跟踪文件按上表归因保留,其中 3 个早于本实验、1 个是本票契约原文。
