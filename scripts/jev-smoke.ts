/**
 * scripts/jev-smoke —— **对 Jev 发一发真请求,把五问的读数打出来**(契约
 * `docs/plan/2026-09-22-jev-传感器-阶段0-E1-执行契约.md` 切片 5)。
 *
 * ## 为什么要有它
 *
 * `src/model/jev-client.test.ts` 全离线 —— 它钉的是「我们按什么形发」,钉不了「对面还认不认这个形」。
 * base URL 换了、`answers.<id>.noul` 改名、key 过期、配额尽 —— 这些在离线测试里全绿,
 * 只有一发真调用看得见(仓规 P-2:一条命令就能看到的事别用推的)。
 *
 * ## 用法
 *
 *   bun scripts/jev-smoke.ts        # key 由 bun 自动从 cwd 的 .env 加载 (TYPESAFE_API_KEY)
 *
 * 退出码:通了或没配 key 0 · 真失败 1。
 * ⚠ 它**不打印 key**,只打印 ok/why/ms/model/inputTokens 与每问的 noul。
 *
 * ## 超时为什么不是生产的 800 ms
 *
 * 生产超时 800 ms 是「迟到即作废」的边界;探针要的是**真实时延那个数**,好拿它跟 800 比。
 * 用 800 跑探针,对面慢一点就只剩一个 `timeout`,量不到东西。
 */
import { askJev } from '../src/model/jev-client';
import { SENSOR_QUESTIONS, buildSensorState, createSensorTape, type SensorQuestionId } from '../src/harness/sensors/sensor-state';

/** 探针专用的时延上限:量数用,不是生产边界。 */
const SMOKE_TIMEOUT_MS = 5000;

async function main(): Promise<number> {
  if (!process.env.TYPESAFE_API_KEY) {
    console.log('no-key (TYPESAFE_API_KEY 没配 —— 传感器在这台机器上恒无信号, 这是合法状态, 不是失败)');
    return 0;
  }

  // 手写一个小状态: 一个目标 + 三条只读勘察 + 空 claims —— 形态与 conductor 第 4 步左右一致。
  const tape = createSensorTape();
  tape.observeRead({ kind: 'grep', key: 'grep -n askJev src/', excerpt: 'src/model/jev-client.ts:78:export async function askJev' });
  tape.observeRead({ kind: 'read', key: 'src/model/jev-client.ts', excerpt: 'model/jev-client —— TypeSafe System One 的裸 HTTP 客户端' });
  tape.observeRead({ kind: 'ls', key: 'ls src/harness/sensors', excerpt: 'sensor-state.ts sensor-state.test.ts' });
  const state = buildSensorState({
    goal: '把 Jev 传感器接到 conductor 的逐步回路上, 默认 off, 读数写进 ~/.omd/sensors/*.jsonl',
    step: 4,
    readonlySteps: 3,
    dispatches: 0,
    filesTouched: 0,
    tape,
  });

  const r = await askJev({ state, questions: SENSOR_QUESTIONS, timeoutMs: SMOKE_TIMEOUT_MS });
  const stateChars = JSON.stringify(state).length;

  if (!r.ok) {
    console.log(`ok=false why=${r.why} ms=${r.ms} stateChars=${stateChars}${r.detail ? ` detail=${r.detail}` : ''}`);
    return 1;
  }

  console.log(`ok=true ms=${r.ms} model=${r.model ?? '?'} inputTokens=${r.inputTokens ?? '?'} outputTokens=${r.outputTokens ?? '?'} stateChars=${stateChars}`);
  for (const id of Object.keys(SENSOR_QUESTIONS) as SensorQuestionId[]) {
    const noul = r.answers[id]?.noul;
    // 没答上的问题打 `-`, 不打 0 —— 「没回来」与「判为否」是两件事 (仓规 §静默坑 1)。
    console.log(`  ${id.padEnd(22)} ${noul === undefined ? '-' : noul.toFixed(3)}`);
  }
  return 0;
}

process.exit(await main());
