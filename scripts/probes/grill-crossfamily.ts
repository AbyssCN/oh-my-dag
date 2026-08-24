/**
 * 跨家族蓝军:把 SDD 交给非 Claude 家族的座位对抗审问 (INV-7「判 ≠ 候选族」的本意)。
 *
 * 为什么单独写:`conductor_chat` 锁在 conductor 座 (今天 = claude-opus-5),与作者同族;
 * 同族自审共享盲点,而这恰是本仓要防的那类失效。本脚本直接走 gateway 单发,座位可指定。
 *
 * 用法: bun run scripts/probes/grill-crossfamily.ts <model> <sdd路径> <输出路径>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { send } from '../../src/model/gateway';
import { bootstrapModelRuntime } from '../../src/model/bootstrap';

const [model, sddPath, outPath] = process.argv.slice(2);
if (!model || !sddPath || !outPath) {
  console.error('用法: bun run scripts/probes/grill-crossfamily.ts <model> <sdd路径> <输出路径>');
  process.exit(2);
}

const sdd = readFileSync(sddPath, 'utf8');

const SYSTEM = `你是蓝军。任务是对抗式审问一份执行契约 SDD —— **找出它站不住的地方**,不是盖章放行。默认怀疑,证据不足就判不通过。

严格要求:
- 每条断言要么指向 SDD 里的具体章节/决策编号,要么指向给你的实测数字。
- **禁用**「通常」「一般来说」「最佳实践是」这类没有指向的话。
- 不要为了配合作者而找理由支持它。判"不值得做"就直说。`;

const USER = `## 待审文档

<sdd>
${sdd}
</sdd>

## 背景

omd 是 DAG 执行引擎。今天的 best-of-N (\`tournament\`/\`judge\`/\`parallel\`) 跑在**文本轴**:
\`ctx.leaf\` 是单发模型调用返回文本,零文件副作用。本 SDD 要开**新轴**:从执行到一半的
agent leaf (会动文件、跑工具循环) 分叉 N 条各自继续执行,择优取一条并入,其余回收。

## 作者自知的六处软点 —— 逐条打

① **D-3a 的 30% 阈值仍是拍的**。只冻结了计算口径 (R_token/C_token、R_wall/C_wall),
   阈值本身零外部锚。为什么 30% 不是 15% 或 60%?这个数决定 A/B 走哪条。若它任意,
   整个 D-3 裁决机制是不是自欺?
② **O-2 未证而整个 B 路线押在它上面**。"对话上下文存在客户端还是 provider 侧"语料未覆盖,
   而 B 成立的前提就是"上下文能从显式本地记录重建"。押未证前提写 5 个切片,合理吗?
③ **D-9「分支必须同模型」是推的不是验的**。从"换模型使缓存失效"推出,但没验过"同 goal
   不同角度"能否产出足够执行分化。若三分支 diff 高度相似,best-of-N 就没有 N。致命吗?
④ **D-8 三档副作用边界靠人工声明,无机械闸**。错归一次 = N 次真实副作用 (N 次付款/部署)。
   本仓纪律是"讲道理拦不住,判据要做成会跑的东西"——这条明显违了。
⑤ **87.7% 缓存命中是代理指标**。量的是"线性推进叶子",而分叉重放是"同前缀新请求"。
   文档标注了这点,但 D-3 的经济性论证仍建在它上面。够格支撑那个结论吗?
⑥ **N=4 上限与 1/N 预算都是拍的**。无读数支撑 4 而非 3 或 8;1/N 均分假设三分支等价,
   但它们 goal 不同,凭什么等价?

## 独立判断:这条原语值不值得做

实测依据 (非估计):
- agent leaf 墙钟: p50=1.4 / p75=3.3 / p90=6.7 / p95=10.2 / p99=21.3 / max=61.7 min (n=1368)
- **≥15min 的 25 个叶子里 24 个 done** —— 长叶是高产叶,不是卡住的叶
- 全仓缓存命中中位 ~88%,p10 仅 19.8%
- firecracker 快照恢复 12-16ms (本机跑通,含真分叉验证)
- omd 其它已知缺口: 叶级看门狗未建 (单叶挂死 26 分钟无人管) · run 级预算超支 46% 零记录 ·
  \`[cost]\` 账本低报成本 (conductor 那一发不进账)

**若结论是「omd 的瓶颈不在这里,这是过早优化」,直接说**,并给你认为更该先做的三件事 + 理由。

## 输出格式 (不要散文)

1. **逐条判决 ①-⑥**: 每条「站得住 / 站不住 / 需补 X 才站得住」三选一 + 一句理由。
   站不住的**点名具体哪一句**。
2. **作者没自觉到的洞**: 他列了六条自知软处,你要找的是**第七条以后**。这部分最值钱。
3. **值不值得做**: 一句结论 + 三条理由。判"不值得"就给替代优先级排序。
4. **若要做,最小可证伪的第一步**: 不是 SDD 里那个 S1,而是你认为的。`;

bootstrapModelRuntime();

const t0 = Date.now();
console.error(`[grill-crossfamily] 座位 ${model} · SDD ${sdd.length} 字符 · 发出…`);

try {
  const res = await send({
    model,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: USER },
    ],
    meta: { role: 'grill-crossfamily' },
  });
  const text = res.text ?? '';
  writeFileSync(outPath, text, 'utf8');
  console.error(
    `[grill-crossfamily] 完成 ${((Date.now() - t0) / 1000).toFixed(1)}s · ${text.length} 字符 → ${outPath}`,
  );
  console.error(`[grill-crossfamily] usage: ${JSON.stringify(res.usage ?? {})}`);
} catch (err) {
  // fail-open 不许吞证据 (本仓 §3): 留原文
  console.error(`[grill-crossfamily] 失败: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
