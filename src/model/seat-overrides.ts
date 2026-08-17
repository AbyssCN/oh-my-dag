/**
 * src/model/seat-overrides —— 座位字段的用户覆盖层 (C4, dsh/cordis 吸收计划线 C)。
 *
 * 学 cordis.patch.yml 的形状 (按 id 定位条目、替换字段值), 但**不开新文件**: 真源仍是
 * `.omd/config.json` (`seats` 段, 经 role-models 的 mtime 缓存 fileSeats 读) ——
 * config.pools 第二真源是记档的 bug (#143), 不再造一个。
 *
 * 范围**刻意只有 sampling** (吸收计划 C4 的收窄, 记录防重议):
 *   - model: 已有 config.models 层 (tryResolveSeatModel 第 3 层), 再做一层 = 两层打架;
 *   - thinking: 座位档下发链是已知死层 (#142), 在死层旁边加新覆盖层只会把尸体埋得更深 ——
 *     等 #142 清算后再谈;
 *   - sampling: 全仓唯一没有任何运行时覆盖通道的座位字段 (seatSampling 只读编译期表),
 *     渠道经济学实验要动它就得改源码 —— 这正是本层要开的口。
 *
 * 硬规则 (C4 判据):
 *   - **不许新增座位 id**: 未知 id 响亮拒 (warn + issue 点名), 座位词表仍是编译期事实;
 *   - 无 `seats` 段时逐字节回落 `seatSampling` (byte 级无变化);
 *   - 生效可见: `omd config dump` 的 issues 节亮出坏条目。
 */
import { z } from 'zod';
import { zodIssues, type ConfigIssueSink } from '../config/issues';
import { logger } from '../logger';
import { fileSeats } from './role-models';
import { ALL_SEAT_IDS, seatSampling, type SeatSampling } from './seats';

const seatOverrideSchema = z.looseObject({
  sampling: z
    .looseObject({
      temperature: z.number().optional(),
      topP: z.number().optional(),
    })
    .optional(),
});

export interface SeatOverride {
  sampling?: SeatSampling;
}

export interface SeatOverrideOpts {
  /** 显式 config 路径 (测试隔离缝; 生产省略 = configPath() 发现链)。 */
  configPath?: string;
  issues?: ConfigIssueSink;
}

/**
 * 读 `.omd/config.json` 的 `seats` 段。未知座位 id / 坏条目 → 跳过 + warn + issue 点名
 * (fail-open 不砖, 但绝不静默 —— 拼错座位名的用户必须能看见自己拼错了)。
 */
export function readSeatOverrides(opts: SeatOverrideOpts = {}): Record<string, SeatOverride> {
  const raw = opts.configPath ? fileSeats(opts.configPath) : fileSeats();
  const source = opts.configPath ?? '.omd/config.json';
  const out: Record<string, SeatOverride> = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (!(ALL_SEAT_IDS as readonly string[]).includes(id)) {
      logger.warn({ seat: id }, '[omd/seats] config.seats 里的未知座位 id —— 拒绝 (座位词表是编译期事实, 不接受新增)');
      opts.issues?.push({ source, path: `seats.${id}`, message: `未知座位 id (可选: ${ALL_SEAT_IDS.join(', ')})` });
      continue;
    }
    const parsed = seatOverrideSchema.safeParse(entry);
    if (!parsed.success) {
      opts.issues?.push(...zodIssues(source, `seats.${id}`, parsed.error.issues));
      continue;
    }
    const sampling = parsed.data.sampling;
    out[id] = sampling
      ? {
          sampling: {
            ...(sampling.temperature !== undefined ? { temperature: sampling.temperature } : {}),
            ...(sampling.topP !== undefined ? { topP: sampling.topP } : {}),
          },
        }
      : {};
  }
  return out;
}

/**
 * 座位生效采样 = config.seats 覆盖 ?? 编译期默认 (seatSampling)。
 * 覆盖是**整段替换**不是 deep-merge (同 dsh patch 语义: 留的字段要重述) —— 半合并会让
 * "我只想清掉 temperature" 表达不出来。无覆盖时与 seatSampling 同值 (byte 级无变化)。
 */
export function effectiveSeatSampling(id: string, opts: SeatOverrideOpts = {}): SeatSampling {
  return readSeatOverrides(opts)[id]?.sampling ?? seatSampling(id);
}
