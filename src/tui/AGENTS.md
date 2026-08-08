# `src/tui/` —— 自建终端前端的局部纪律

> 这一份只写**这个目录特有、而仓根 harness 推不出来**的。
> 全局纪律在 `.claude/CLAUDE.md`,设计真源在 `docs/plan/2026-08-07-omd-agent-tui-sdd.md`,
> 范围与验收真源在 `docs/plan/2026-08-07-omd-agent-tui-goal.md`。

---

## 1. 四层测试各自证明什么 —— **边界声明**

| 层 | 在哪 | 证明 | **不证明** |
|---|---|---|---|
| **L1** 纯函数 | `render/*.test.ts` · `seat-picker.test.ts` · `context.test.ts` | 算法(宽度/截断/解析/字形判定) | 组件有没有把 width 传下去 |
| **L2** 组件 | `components/*.test.ts` | `render(width)` 返回的行**都不超宽**、状态转移对 | 真终端里画出来什么样 |
| **L3** 真 PTY | `scripts/tui-pty-check.mjs`(node 托管) | UI 循环起得来 · 真 pi-tui 渲染 · 按键收得到 · 流式装配 · Ctrl+C 干净退出 | **引擎行为 · 真模型 · 会话持久化 · DAG 执行** |
| **L4** 真引擎冒烟 | `scripts/tui-l4-smoke.ts`(`OMD_L4=1` 才跑) | 真座位 → 真 `runChatTurn` → 真工具面 → 会话真落库 | UI(它不起 TUI) |

**L3 跑的是 `OMD_TUI_BACKEND=fixture`**,后端自报 `fixture://l3-test`。
拿这条 lane 声称引擎侧的任何事,就是本仓 S-1 那一族。

⚠ **PTY lane 必须由 node 托管,不许改回 `bun test`。**
实测:`@lydell/node-pty` 在 bun 宿主下**一个字节都不回**(node 宿主同样调用正常)。
硬写进 `bun test` 会收到空输出 → 每条 `includes()` 都假、每条 `not.toContain()` 都真
= **一条永远绿的假闸**。`src/tui/tui-pty.test.ts` 只负责把脚本调起来收退出码。

⚠ **永不做 ANSI 快照。** 快照会因任何布局微调全红,等于没有测试。
断言**归一化可见文本**;那个归一化函数自己带反测(`selfTestOracle`)。

---

## 1.5 ★ pi-tui 有的一律引用,不手搓(owner 定,2026-08-08)

**「用 pi-tui 就是为了尽可能少手搓。」** 加任何组件/工具函数之前,过三问:

1. **pi-tui 有没有?** —— `ls node_modules/@earendil-works/pi-tui/dist/components/` +
   `ugrep "^export" dist/index.d.ts`。**别凭印象说"它没有"。**
2. **有却不用,理由写得出来吗?** —— 写进台账 §2,**带行号或实测**。写不出来就是在手搓。
3. **真没有的话,我写的是薄封装还是第二套实现?** —— 薄封装可以(`fitLine` 包
   `truncateToWidth` 就是),另写一套宽度/截断/按键解析**不行**(理由见下一节)。

**台账在 `docs/bars/pi-tui-模块台账.md`** —— 每个 pi-tui 导出都记了态度
(已用 / 欠账 / 有理由不用 / 不适用)。**改了 `src/tui` 就去更新它**,
还掉一条欠账就从 §1 挪到 §3,别让它烂在表里。

现状:引用 **21 / 约 70**(2026-08-08 复核,命令在台账 §3)。
本程还上两笔:**`SettingsList`**(设置页 → `components/settings-panel.ts`)·
**`getKeybindings`**(`keys.ts` 补 pi-tui 认不出的双 ESC)。

剩下最大的一笔:**`Input`** —— 手搓的输入框(`dialog.ts input()`)没有光标移动 / undo /
按词操作 / 粘贴处理。⚠ `Input` **不支持遮蔽**,所以 `/login` 落 key 那处必须保留手搓,
换的时候要在代码里写明这个理由。

⚠ 台账 §1.1 记了一条**实测更正**:「换成 `matchesKey` 是纯赢」是错的,它是**一换一**
(omd 的表有双 ESC 而 pi-tui 没有;pi-tui 有 kitty 编码而 omd 没有)。
**照台账原文直接换会静默丢掉一种编码** —— 动 `dialog.ts` 那张表之前先读 §1.1。

---

## 2. 宽度只有一把尺子

一律用 pi-tui 的 `visibleWidth` / `truncateToWidth`,**不自己写第二套**。
这不是省事:Rich 那条路被否掉的理由之一正是"两套宽度算法打架",而 `'节点'.length === 2`
但它占 **4 列**。同一个判据散成三份必然漂移(字形 · 表格 · 单行)。

- **状态行截断,不折行**(`components/status-line.ts`)—— 状态行一折,下面所有东西的行号
  整体下移,而 HUD 按行差分画,结果是**布局错位**不是"多一行"。
- **正文折行**(`ChatLog` / `Markdown`)—— 那里折行是对的。

---

## 3. 字形:白名单之外的一律不用

读数在 `render/glyph-table.ts`(**生成文件,别手改**),产它的探针是
`scripts/tui-glyph-probe.ts`。判定是**三态**:

- `safe` 两把尺子(pi-tui / Unicode EAW)一致;
- `needs-tty` **歧义宽度** —— CJK locale 画 2 列、别处 1 列。不是"不安全",是**这台机器上答不了**;
- `unsafe` 字体私用区 / emoji / ZWJ —— 量了也只对一台机器成立。

**新增任何 chrome 文案都加进 `tui.ts` 的 `CHROME` 对象**,否则它不过字形闸
(`render/glyphs.test.ts` 只扫那一个对象)。这条闸抓到过 header 里的 em dash。

真终端那一列要靠**在真终端里手跑** `bun run scripts/tui-glyph-probe.ts --tty` 补 ——
自动化 lane 后面没有终端模拟器,没人回答 `CSI 6n`。**量不到就写"未量",不拿 Unicode 表冒充。**

---

## 4. 断链说明卡:三种合法画法,没有第四种

上游能力还没接通 / 探测不到时:

1. **无源恒缺席** —— 键不出现(`DagHud` 没有 run 时 `render()` 返回 `[]`;
   codegraph 探不到时工具**从工具列表消失**);
2. **禁用态 + 原因句** —— 零假数据(`/runs` 在没有该能力的后端上说"没有 listRuns 能力");
3. **灰常量即真值** —— `PathHud` 前沿为 0 时画 0,**并说清为什么是 0**。

**绝不许**让一个接口编一个看起来对的返回值。那会让每次手测都读成"能用了"。

---

## 5. 组件改了内容**不会自己重绘**

实读 `pi-tui/components/text.js:20-25`:`setText` 只写字段、清行缓存,**不触发重绘**。
改完内容必须由调用方 `tui.requestRender()`。

⚠ 这类 bug **L1/L2 测不到**(组件状态确实变了),只有 L3 抓得到 —— S2 的 PTY lane 第一跑
就是死在这里,症状是"屏幕停在首帧、看起来 UI 挂了",而所有逻辑都是对的。

---

## 6. 日志一个字节都不许进终端

`omd tui` 起来的第一件事是 `redirectTuiLogs()`(`logging.ts`),**在 `runOmdTui` 之前**。
TUI 独占终端,stdout 与 **stderr 都会花屏**,而且是**静默**的:插一条 pino 进画面中间,
屏幕错位、下一帧覆盖不齐,没有任何一处报错。

开不出日志文件时**整程静默**(不是继续往终端上打),原因存在 `reason` 列,`close()` 时打到 stderr。

---

## 7. 每加一条闸,当场证伪一次

把闸弄红的方式写进注释。一条永远绿的闸比没有闸更坏。

⚠ **证伪本身也会假。** 本程撞到两次:脚本里的字符串替换没匹配上,闸"没红"是因为
**根本没改到文件**。用断言式替换(匹配不到就失败),别用静默的 `replace`。

本程被证伪抓出来的假闸(都是我自己写的):
- S4-2 用子串 `.claude/CLAUDE.md` —— 全局那份显示成 `~/.claude/CLAUDE.md`,同一子串照样命中;
- S10-3 "某段文本只出现一次" —— 每片各开一条消息时,两片文本各自仍只出现一次;
- S6 组合符探针 —— 源码里直接写 `é` 会被 NFC 归一化成预组形,量的是另一个码点。
