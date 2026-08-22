---
name: omd-contract
description: 把审议结论结晶成正式契约文档落盘 docs/plan/,当 /omd-execute 的执行契约。承接 /omd-grill 的决策记录表,写给没有对话上下文的执行器看。含 crystallize/crystals 职能。Trigger:/omd-contract、定契约、写成执行契约、写成 SDD、SDD、结晶、方案定了记下来、列结晶。
---

# /omd-contract — 审议结晶成执行契约

审议(`/omd-grill`、pathfinder 裁决)收敛后,把结论写成结构化 SDD 落盘——它是 `/omd-execute` 的执行契约,写给**没有对话上下文的执行器**,不是给人读的散文。

## 承接 /omd-grill 的决策记录表

| # | 决策 | 定论 | 落点(/omd-note · pathfinder 票 · SDD 章节) | 证据 |
|---|------|------|--------------------------------------------|------|

落点标「SDD 章节」的行 → 进「决策」与「契约」段;标 `/omd-note` 的留台账;标 pathfinder 票的附票 id 进「未决」段。「待 owner / 待实测」项原样进「未决」,不写成结论。

## 落盘

路径:`docs/plan/YYYY-MM-DD-<slug>.md`。每段可被无上下文执行器独立消费:

```markdown
# <标题>
## 目标 (Destination)   一句话讲清做成什么样
## 决策 (Decisions)     D-1..D-N:每条已定型裁决 + 一句为什么 + 证据
## 契约 (Contracts)     不变量 + GWT 验收点——/omd-execute 逐条判 pass/fail 的依据
## 分解 (Breakdown)     依赖图 + 并行波形(写法见下)
## 非目标 (Non-goals)   明确不做什么
## 未决 (Open)          未裁的问题;附 pathfinder 票 id;待实测的标「待实测」
```

GWT 验收点越可证伪,验收越不含糊;一个模糊验收点 = 执行器和你各自解读的裂缝。

## 分解段 —— 默认并行,串行必须给理由

- 只写**真实依赖边**,每条带理由:「B 依赖 A 因 <B 消费 A 的产物 X>」——且 **X 必须出现在 A 的写集清单里**(机器可锚)。写不出被消费产物的边,删——那是顺序偏好,不是依赖。
- **接口依赖就地消解**:B 只需要 A 的类型/签名/schema 而非实装 → 把该接口**冻进本 SDD**(契约段),边删掉,两片并行。接口从此是契约的一部分:A 的实装必须符合它,偏离 = 回流改契约,不是恢复边。(实例:内环 v2 切片 2 只消费切片 1 的 `SddSlice` 结构——冻进 SDD 即可并行,当时没冻,白等一层。)
- **定稿前过一遍并行性审问**:串行率(关键路径长 ÷ 切片数,编译器 `parallelismReadout` 同口径)= 1 的链,逐边重跑上面两问再定稿;审完仍是真串行就如实保留——读数只点名,不否决诚实的线性分解。
- 切片表:| 切片 | 写集 | 依赖(带理由) | verify |。写集两两不相交 = 可并行的机器判据。
- **verify 列必须是可跑命令串**(如 `bun test src/x.test.ts`),不是验收点引用——G 点引用的家在契约段。编译器(sdd-compile)按首词白名单拒不可跑的 verify;写引用 = 这份 SDD 吃不到直通 v2,回落 conductor 铺图税(owner 2026-08-11 裁:直通就是为了消铺图税与墙钟)。全量回归命令不进 verify 列(它只属终局 accept,D-4)。
- 收尾写并行波形一行,conductor 照铺:`并行波形:{1,3,5} → {2} → {4}`。全串行波形须给整体理由,默认视为写错。
- 优先序(哪片价值高)写波形注释或 Open 段,不进依赖边。

### ⚠ 分解表的四条机器硬要求(写错 = 点火当场拒 / 静默回落,而它只在点火那一刻才响)

真源 `src/harness/goal/sdd-direct.ts` + `sdd-compile.ts`。2026-08-18 量过全量语料:
**149 份 plan 文档、52 份有分解段,只有 14 份吃得下 `sddPath` 直通** —— 而直通是夜批的默认路径。
73% 的失败**全部**来自下面四条,一条都没写进过本模板:

1. **切片列必须裸数字开头** —— `| 1 span 计算 …`。写 `S1` / `**S1 …**` / `Phase` 一律拒
   (`sdd-direct.ts` 的 `/^(\d+)/`;编号是波形/依赖引用它的唯一方式)。
2. **波形行独占一行** —— `WAVE_LINE` 锚行首。写成「写集两两不相交 ✓。并行波形:…」会被
   **静默忽略**(不报错,图退回按依赖边排;2026-08-18 实测)。
3. **写集只收相对路径,且不许留空** —— 写「无」/「dispatch」这类词会被拒;空写集直接拒
   (写集是并行安全的机器判据)。
4. **verify 只许指向本片新建的、实装前天然红的测试**(O-6)。`run-goal.ts` 会在编图前
   逐片预跑一枪 verify:**读到绿 = RED 前提不成立 → 整图回落 v1 conductor 铺图**,
   而点火回执那句「SDD 直通」只讲契约段、**不报执行段已回落** —— 唯一线索是节点名从
   `s1-red/s1/s1-green` 变成 `execute::<hash>`。既有测试要跟着改,写进**写集**,别写进 verify。

## 结晶后立刻验证 —— 不验不算结晶

写完**当场**跑一次,编译不过就地重写。**别等点火才发现**(2026-08-23 一晚 15 片实测:
所有「契约编译通过、跑起来必挂」的错法,都是在这一步能机械判死的)。

```bash
bun -e '
const { parseBreakdown, loadSddContract } = await import("./src/harness/goal/sdd-direct.ts");
const { compileBreakdown } = await import("./src/harness/goal/sdd-compile.ts");
const p = "docs/plan/<刚写的>.md";
loadSddContract(p);                                   // 契约段 + 分解段齐不齐
const b = parseBreakdown(await Bun.file(p).text());
console.log("writeSet:", JSON.stringify(b.slices.map((s) => s.writeSet)));
console.log("falsify:", JSON.stringify(b.falsify));   // ← 逐条核对是不是你写的那一行
console.log("nodes:", Object.keys(compileBreakdown(b, { acceptCommand: "bun test" }).nodes).join(" "));
'
```

**逐条核对(每条都花过一整轮)**:

| 看什么 | 判据 |
|---|---|
| `falsify` 解出来的 `oldText` | 与你写的**逐字相同**。含 `\|`(TS 的 `\|\|`)会被 markdown 切列 ⇒ 截成半句 ⇒ 跑起来 `matches=0` |
| 写集含 `src/harness/dag/types.ts` | 必须同时含 `docs/architecture/seams.md` **与** `src/harness/dag/seam-catalog.test.ts`(结构绊线写死了两个字面量,增删字段必红)|
| 命令首词 | **不许 `npx`** —— 执行体沙箱里退出 **127**;用 `./node_modules/.bin/<bin>` |
| `nodes` 清单 | 与你预期的节点数一致;`sN-falsify-*` 该在的在、不该在的没有 |

⚠ 上面前三条今天已由编译器**硬拒**(`sdd-direct` / `sdd-compile`),
所以这一步跑不过 = 契约真有问题,**不是工具挑剔**。

### 还有一条,抓的是**另一半**

```bash
bun run plan-doc-check <文档>
```

它查的是**文档形态**:切片列编号是不是裸数字、波形行有没有独占一行、有没有未决段,
以及**不变量与 GWT 配没配上**。上面那条 `bun -e` 查的是**跑起来会不会挂**。
**两条抓的不是同一批错,都要跑。**

### ⚠ INV / GWT 必须写成它读得懂的形状,否则它数出 0 条(而它是对的)

真源 `src/harness/plan/plan-doc-score.ts:242-245`:

| 它认什么 | 正则要求 | 写成这样才算数 |
|---|---|---|
| 不变量 | `INV_RE` —— 列表项 + **粗体** + `INV-` | `- **INV-1 短输出零回归**:…` |
| GWT | `GIVEN_RE` —— 字面 `Given`(可带 `*`)+ 同项里有 `Then` | `- **GWT-1** *Given* … *When* … *Then* …` |
| 配对 | GWT 嵌在 INV 下当子项,**或**正文里点名 `(INV-1)` | 两种都行,挑一种 |

⚠ **别写 `- INV-1 …`(不加粗)或 `**G** … **W** … **T**` 简写** ——
2026-08-23 实测:本仓多份既有契约用的正是这两种,于是 `plan-doc-check` 判
「契约段在,但一条不变量、一条 GWT 都没有」**blocker**。
那不是误报,是**它看不见**。同一份内容换成上表的形状后立刻
「不变量配 GWT 率 7/7 · GWT 可判定率 7/7 · PASS」。
**Then 里写机器判得了的东西**(`.includes('…')` / 具体数字 / 文件路径),
写「合理」「符合预期」会被单独点名。

⚠ **有一条 `major` 躲不掉**:新建文件必然被 `breakdown-path-missing` 点名
(`plan-doc-gaps.ts:207`,纯按 `!fileExists` 报;它的修法文案让你写「新建」,
但**检测器里没有一处读这两个字**)。`major` 不拦人(要 `--strict` 才拦),照点火。

### falsify 表的锚点两条硬规矩(拿不准就别写表)

① 锚点必须是「**实装写完之后一定长这样**」的一行 ——
拿不准(数组还是 Set、一行还是多行、字段顺序)⇒ **别写进表**;
② 锚点必须**改了真会变行为** —— 改完测试照样绿的锚点是**哑弹**,
那种 falsify 节点**必然判失败**,白挂一个节点。

两条有一条不满足,就把判别力交给**手做**那一跳(验收里写清「改什么 → 哪条必红 → 还原复绿」)。

## 纪律

- 只写已定型的决策;未决进 Open 段(或 `map_add` 开票)。
- **验收分两栏**:判据(必须能区分做完/没做)与护栏(防回归、本来就该绿)。
  把护栏当判据写会被判据自证闸判 `[vacuous]` —— 它在活还没干之前就已经满足。
- **每条验收出口前问两遍**:这条能不能验?**执行体有没有能力遵守它?**
  (实测写过的做不到条款:`npx tsc`、「全量 0 fail」在执行体沙箱里、
  「`s1-green` 不许被合并」——那是引擎的优化,执行体控制不了。)
- 无证据的决策行,先补证据或降级进 Open,不进 Contracts。
- 写完提示 owner:确认后 `/omd-execute` 执行。
- 看已有结晶 → `ls docs/plan/*.md` 按时间列出。

## 边界

- 审议在 `/omd-grill`(问透之前不结晶);轻量决策/引用 → `/omd-note`;执行 → `/omd-execute`,本 skill 不碰实现。
