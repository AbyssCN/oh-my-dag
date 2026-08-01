/**
 * agent leaf 的**进展看门狗** —— 「没跑起来」与「跑得久」必须分得开 (2026-08-01)。
 *
 * ## 这份网钉的是一个真出过的误判
 *
 * 老判据是「启动后 45s 内累积**文本**不足 32 字节 → 判 provider 挂死」。它只数 `text_delta`,
 * 而模型在**推理**时发的是 `thinking_delta` —— 于是一个正在认真想问题的叶子, 在判据眼里
 * 和一个死掉的 provider 长得一模一样。worker 档提到 xhigh (deepseek 上 = `reasoning_effort: max`)
 * 之后, 这不再是"理论上会", 而是**常态**: 想 50 秒再动手是这一档的正常行为。
 *
 * 新判据只问「它还在动吗」: 任何循环事件都算动, 工具在飞时不计时。
 * 这里用**假时钟 + 手喂事件**测那个状态机本身 —— 不打网络、不等真的 3 分钟。
 */
import { describe, expect, it } from 'bun:test';

/**
 * 看门狗的状态机(与 `agent-leaf.ts` 里那段逐条对应)。
 *
 * 为什么这里重述一遍而不是 import: runner 里那段是长在一次真调用的闭包里的(要 controller /
 * 事件流 / 计时器),抽出来单测就得先把它做成一个可注入时钟的独立件 —— 而它只有十行。
 * 重述的代价是**两处会漂**,所以这份用例同时是那段代码的**规格**: 改那边就来改这边,
 * 两边对不上时说明有一边写错了。
 */
class Watchdog {
  private lastProgressAt: number;
  constructor(
    private readonly idleTimeoutMs: number,
    private now: number,
  ) {
    this.lastProgressAt = now;
  }
  private pendingTools = 0;
  note(): void {
    this.lastProgressAt = this.now;
  }
  toolStart(): void {
    this.pendingTools++;
    this.note();
  }
  toolEnd(): void {
    this.pendingTools = Math.max(0, this.pendingTools - 1);
    this.note();
  }
  /** 时钟推进到 t; 返回此刻是否判定停摆。 */
  tickTo(t: number): boolean {
    this.now = t;
    if (this.idleTimeoutMs <= 0) return false;
    if (this.pendingTools > 0) return false; // 工具在飞 = 在干活
    return this.now - this.lastProgressAt >= this.idleTimeoutMs;
  }
}

const IDLE = 180_000;

describe('进展看门狗', () => {
  it('★ 一直在推理 (只有 thinking_delta, 一个字正文都没有) → 不判死', () => {
    const wd = new Watchdog(IDLE, 0);
    // 模拟 10 分钟纯推理: 每 20s 一个 thinking_delta, 正文始终为空。
    for (let t = 20_000; t <= 600_000; t += 20_000) {
      expect(wd.tickTo(t)).toBe(false); // 先推进时钟再记进展 (事件是在 t 这一刻到的)
      wd.note(); // 老判据在这里看到的是 "0 字节正文" → 会判死
    }
  });

  it('★ 真死的 provider (零事件) → 一个窗口内被抓到', () => {
    const wd = new Watchdog(IDLE, 0);
    expect(wd.tickTo(IDLE - 1)).toBe(false);
    expect(wd.tickTo(IDLE)).toBe(true);
  });

  it('★ 长工具在飞 (跑 10 分钟的 bun test, 期间零事件) → 不判死', () => {
    const wd = new Watchdog(IDLE, 0);
    wd.toolStart();
    expect(wd.tickTo(600_000)).toBe(false); // 远超一个窗口, 但它在干活
    wd.toolEnd();
    expect(wd.tickTo(600_000)).toBe(false); // 刚结束 = 刚有进展
    expect(wd.tickTo(600_000 + IDLE)).toBe(true); // 之后再没动静才算死
  });

  it('★ 窗口是**滚动**的 —— 中途才挂起的 provider 也抓得到 (老判据只在启动看一眼)', () => {
    const wd = new Watchdog(IDLE, 0);
    for (let t = 30_000; t <= 300_000; t += 30_000) {
      expect(wd.tickTo(t)).toBe(false);
      wd.note();
    }
    // 300s 处开始没动静了
    expect(wd.tickTo(300_000 + IDLE - 1)).toBe(false);
    expect(wd.tickTo(300_000 + IDLE)).toBe(true);
  });

  it('并发工具批: 最后一个结束前都不算闲', () => {
    const wd = new Watchdog(IDLE, 0);
    wd.toolStart();
    wd.toolStart();
    wd.toolEnd();
    expect(wd.tickTo(500_000)).toBe(false); // 还有一个在飞
    wd.toolEnd();
    expect(wd.tickTo(500_000 + IDLE)).toBe(true);
  });

  it('idleTimeoutMs=0 = 关闸 (逃生口)', () => {
    const wd = new Watchdog(0, 0);
    expect(wd.tickTo(10_000_000)).toBe(false);
  });
});
