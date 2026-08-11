/**
 * scripts/path-sweep —— waiting_human 超时扫描的**常驻跑者** (CI cron 入口)。
 *
 * O-1 终裁 (owner 2026-08-11): 提醒走 TUI+GH, GH 要尽量实时 ——「人不在 TUI 面前也被触达」。
 * afk-hook 的 watchAfkResults 生产零驱动者 (2026-07-22 台账同结论), 本脚本就是那个驱动者的
 * 最小形态: GitHub Actions schedule 每小时跑一次, 对每张 gh 后端地图 sweep 一遍 ——
 * 超 72h 的等人票经 notify-gh 在对应 issue 落提醒评论, GH 通知天然推手机。
 *
 * 机器全在被测面里, 这里零判据:
 *  - 零 stale 零写 (1890115 铁律, backend 构造保证) —— 没超时的 tick 对世界零触碰;
 *  - 幂等靠 staleAt 评论锚 (notify-gh), 同一次超时不重复评论 —— cron 频率不产生刷屏;
 *  - 单图失败只记不停 (一张图的 gh 异常不该饿死其它图的提醒)。
 */
import { resolveBackend } from '../src/harness/pathfinder/backend';

const cwd = process.cwd();
const backend = resolveBackend(cwd, { env: { ...process.env, OMD_PATH_BACKEND: 'gh' } });
const maps = backend.listMaps(cwd);
console.log(`[path-sweep] ${maps.length} 张 gh 地图`);
let fired = 0;
for (const m of maps) {
  try {
    const stale = backend.sweepWaiting?.(cwd, m.slug, { now: new Date().toISOString() }) ?? [];
    fired += stale.length;
    for (const e of stale) {
      console.log(`[path-sweep] ⏳ ${m.slug}/${e.ticketId} 等人超时 (自 ${e.waitingSince}) — 已提醒`);
    }
  } catch (err) {
    // fail-open 不吞证据: 单图异常记原文继续 (退出码仍 0 —— cron 不是闸, 提醒漏一轮下轮补)。
    console.error(`[path-sweep] ✗ ${m.slug}: ${String(err)}`);
  }
}
console.log(`[path-sweep] 完成: ${fired} 条提醒`);
