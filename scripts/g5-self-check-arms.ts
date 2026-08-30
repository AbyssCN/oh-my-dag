/**
 * scripts/g5-self-check-arms.ts —— **G-5 两臂**:节点级 self_check 自修环到底吃不吃分。
 * (侦察笔记 `docs/plan/2026-08-30-sdk-selfcheck-recon.md` §G-5;S-1 `b40e4869` 的验收。)
 *
 * ## 四要素(动手前写死,事后不许改)
 *
 * **① 单一变量** = `OMD_SELF_CHECK`(`0` 关 / 默认开)。**只动这一个**:
 * 同一个临时仓、同一份 plan、同一个座位、同一个 `maxSelfRepair`(默认 2)。
 *
 * **② 预先声明的成败信号**
 *
 * | | 臂 A(`OMD_SELF_CHECK=0`) | 臂 B(默认开) |
 * |---|---|---|
 * | `selfRepair` 落账 | **缺席**(判据没被派 ⇒ 引擎侧不写这一格) | 在场,`rounds ≥ 1` |
 * | `convergedAt` | n/a | **非 null**(转绿了) |
 * | 终态产物过不过判据 | 预期**不过**(没人在环内拦它) | 预期**过** |
 *
 * · **B 优于 A** ⟺ B 的 判据通过率 > A,且 B 的 `convergedAt` 非 null 次数 > 0。
 * · **判为"这一格不成立"** ⟺ 两臂通过率相同 —— 那时先怀疑夹具(判据太容易/太难),
 *   **再**怀疑自修环。仓规:*一个在任何干预下都不动的数,通常量的是尺子*。
 * · **判为"夹具坏了"** ⟺ 臂 A 通过率就已经是 100%(判据拦不住任何东西,不是判据)。
 *
 * **③ 对照基线**:两臂在**同一台机器、同一 cwd 模板、同一座位**上交替跑(A,B,A,B…),
 * 不是先跑完 A 再跑 B —— 机器负载在飘(σ̂ 批正在跑),分段跑会把负载差算进变量。
 * 开跑先打印 `resolveSeatModel('agent')` 的实际坐标,坐标不同则整个对比作废。
 *
 * **④ 要收什么数**:每次跑收 `{arm, trial, status, selfRepair, checkPass, wallMs, tokens}`,
 * **两侧都写** —— 塌了也是读数(说明自修环在生产座位上不吃分,那同样值钱)。
 *
 * ## 夹具:一个**故意欠说明**的目标
 *
 * 目标只说「写一个 out.txt」,**不说内容**;`check.sh` 要求内容恰好是 `BANANA`。
 * 于是首轮几乎必然不过,而失败输出里带着 `check.sh` 的判词 —— 自修环该做的正是
 * 「读判词 → 改做法 → 再自检」。臂 A 没有这个环,产出就停在第一版。
 *
 * ⚠ 诚实边界:「首轮必然不过」是**概率**不是保证(模型可能碰巧猜中 BANANA,或先读 check.sh)。
 * 所以每臂跑 N 次看通过率,不看单次;N 小的时候不许把差写成结论。
 *
 * 用法:`bun run scripts/g5-self-check-arms.ts [N]`(默认 N=3,即 6 次真跑)
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from '../src/harness/dag/engine';
import { createAgentLeafRunner } from '../src/harness/agent-leaf';
import { createCommandLeafRunner } from '../src/harness/command-leaf';
import { resolveSeatModel } from '../src/model/role-models';
import type { ConductorPlan } from '../src/harness/conductor-plan';
import type { ExecutorDagConfig } from '../src/harness/dag/types';

/**
 * 判据脚本。**用 `bun` 不用 `bash`** —— `bash` 不在 `DEFAULT_COMMAND_ALLOWLIST` 里
 * (白名单故意不放 shell 解释器: 放了等于白名单失效)。第一版写成 `bash check.sh`,
 * self_check 探针当场被闸拒: `kind:"blocked"` · `exitCode:-1` · `rounds:0` ——
 * 自修环一轮都没跑。那是**夹具的错不是引擎的错**, 记在这免得下次又写 bash。
 */
const CHECK_TS = `const fs = require('node:fs');
if (!fs.existsSync('out.txt')) { console.log('check: out.txt 不存在'); process.exit(1); }
const c = fs.readFileSync('out.txt', 'utf8').trim();
if (c === 'BANANA') { console.log('check: OK'); process.exit(0); }
console.log(\`check: out.txt 的内容是 '\${c}', 但判据要求内容恰好是 BANANA\`);
process.exit(1);
`;

/**
 * 目标**故意欠说明**, 且**不提** check 的存在 —— 第一版写了「仓里有个 check.sh 是判据」,
 * 模型直接去读判据、首轮就写对, 两臂都 100% 通过 ⇒ 判据拦不住任何东西, 夹具坏了。
 * 现在它只能从**失败输出**里学到「要 BANANA」, 而那正是自修环该提供的东西。
 */
const GOAL = '在仓根写一个 out.txt 文件。';

interface Trial {
  arm: 'A-off' | 'B-on';
  trial: number;
  status: string | undefined;
  selfRepair: unknown;
  checkPass: boolean;
  wallMs: number;
  tokensIn: number;
  tokensOut: number;
  error?: string;
}

function makeTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omd-g5-'));
  writeFileSync(join(dir, 'check.ts'), CHECK_TS);
  // 真实仓都有 —— 也让语言一致判定 (command-leaf D-2) 有 marker 可依。
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'g5-fixture', private: true }));
  return dir;
}

/** 跑完之后独立再判一次 check.sh —— 不信引擎自报, 用同一条判据在终态上重跑。 */
async function checkPasses(cwd: string): Promise<boolean> {
  const proc = Bun.spawn(['bun', 'run', 'check.ts'], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return (await proc.exited) === 0;
}

async function runArm(arm: Trial['arm'], trial: number, model: string): Promise<Trial> {
  const cwd = makeTree();
  const prev = process.env.OMD_SELF_CHECK;
  if (arm === 'A-off') process.env.OMD_SELF_CHECK = '0';
  else delete process.env.OMD_SELF_CHECK;

  const plan: ConductorPlan = {
    name: 'g5',
    nodes: {
      w: {
        goal: GOAL,
        executor: 'agent',
        output_type: 'file',
        output_path: 'out.txt',
        self_check: { command: 'bun run check.ts', expect_exit: 0 },
      },
    },
  } as ConductorPlan;

  const t0 = Date.now();
  try {
    const config = {
      cwd,
      leafModel: model,
      agentRunner: createAgentLeafRunner({ cwd }),
      commandRunner: createCommandLeafRunner({ cwd, allowlist: ['bun', 'cat', 'ls'] }),
    } as unknown as ExecutorDagConfig;
    const result = await runExecutorDagWithPlan(plan, config);
    const leaf = result.results.w;
    return {
      arm,
      trial,
      status: leaf?.status,
      selfRepair: (leaf as { selfRepair?: unknown } | undefined)?.selfRepair,
      checkPass: await checkPasses(cwd),
      wallMs: Date.now() - t0,
      tokensIn: result.usage?.leavesIn ?? 0,
      tokensOut: result.usage?.leavesOut ?? 0,
    };
  } catch (e) {
    return { arm, trial, status: 'threw', selfRepair: undefined, checkPass: false,
             wallMs: Date.now() - t0, tokensIn: 0, tokensOut: 0, error: (e as Error).message };
  } finally {
    if (prev === undefined) delete process.env.OMD_SELF_CHECK;
    else process.env.OMD_SELF_CHECK = prev;
    rmSync(cwd, { recursive: true, force: true });
  }
}

const main = async () => {
  const N = Number(process.argv[2] ?? 3);
  const seat = resolveSeatModel('agent');
  const model = typeof seat === 'string' ? seat : (seat as { model?: string; coord?: string }).model
    ?? (seat as { coord?: string }).coord ?? String(seat);
  console.log('G-5 两臂 —— 节点级 self_check 自修环');
  console.log(`座位 agent = ${model}   (③ 对照基线: 两臂同座位, 坐标不同则整个对比作废)`);
  console.log(`N = ${N} / 臂, 交替跑 (A,B,A,B…), 单一变量 = OMD_SELF_CHECK\n`);

  const rows: Trial[] = [];
  for (let i = 1; i <= N; i++) {
    for (const arm of ['A-off', 'B-on'] as const) {
      const r = await runArm(arm, i, model);
      rows.push(r);
      const sr = r.selfRepair ? JSON.stringify(r.selfRepair) : '缺席';
      console.log(
        `  ${arm} #${i}: status=${r.status} checkPass=${r.checkPass} ` +
        `selfRepair=${sr} ${r.wallMs}ms in=${r.tokensIn} out=${r.tokensOut}` +
        (r.error ? ` ERR=${r.error}` : ''),
      );
    }
  }

  console.log('\n── 汇总(两侧都写)──────────────────────');
  for (const arm of ['A-off', 'B-on'] as const) {
    const a = rows.filter((r) => r.arm === arm);
    const pass = a.filter((r) => r.checkPass).length;
    const conv = a.filter((r) => (r.selfRepair as { convergedAt?: number | null } | undefined)?.convergedAt != null).length;
    const ms = Math.round(a.reduce((s, r) => s + r.wallMs, 0) / (a.length || 1));
    console.log(`  ${arm}: 判据通过 ${pass}/${a.length} · convergedAt 非 null ${conv}/${a.length} · 均 ${ms}ms`);
  }
  const pa = rows.filter((r) => r.arm === 'A-off' && r.checkPass).length;
  const pb = rows.filter((r) => r.arm === 'B-on' && r.checkPass).length;
  console.log('\n判据(预先声明的):');
  if (pa === N) console.log('  ⚠ 夹具坏了 —— 臂 A 就已经全过, 这条判据拦不住任何东西, 不是判据。');
  else if (pa === pb) console.log('  ⚠ 两臂读数相同 —— 先怀疑夹具, 再怀疑自修环 (量的可能是尺子)。');
  else if (pb > pa) console.log(`  ★ B 优于 A (${pb}/${N} vs ${pa}/${N}) —— 自修环在生产座位上吃到分。`);
  else console.log(`  ✗ B 不优于 A (${pb}/${N} vs ${pa}/${N}) —— 塌了, 这也是读数, 照写。`);
  console.log(`\n⚠ N=${N} 很小: 差值不许写成结论, 只作"值不值得加大 N"的依据。`);
};

main().catch((e) => { console.error('探针本身炸了:', e); process.exit(1); });
