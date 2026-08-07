/**
 * src/tui/boot —— **起不来的时候说人话**(S-4b,2026-08-07)。
 *
 * ## 这条是实测撞出来的,不是设想的
 *
 * 把对话位接上手之后,我起了一个空仓验收「能不能独立在一个仓里工作」。
 * 结果 `omd tui` **启动即死**,屏幕上是一坨:
 *
 * ```
 * 428 |  * 座位模型解析, 解不到即抛 (INV-MODEL-5 计划期响亮失败)。
 * 433 |   if (!r) throw new SeatUnresolvedError(seat);
 *                       ^
 * SeatUnresolvedError: [omd/model] 座位 'conductor' 未配模型 —— ...
 *      at resolveSeatModel (src/model/role-models.ts:433:17)
 * ```
 *
 * 抛得对(INV-MODEL-5 要的就是计划期响亮失败),**但这是用户在新仓里见到的第一屏**。
 * 一个日常主力前端的第一屏不能是别人家的行号。原因是真的:座位配置是**逐仓**的
 * (`<cwd>/.omd/config.json`),所以**除了 omd 自己这个仓,任何仓第一次跑都会撞上**。
 *
 * ## 只翻译,不吞
 *
 * 原始 message 一字不改地留在输出里(本仓纪律:fail-open 可以吞异常,不许吞证据)。
 * 这一层只在它前面加一句人话 + 两条能直接敲的命令。
 */

/** 认得出来的启动失败。认不出的一律走 `unknown` —— 不猜。 */
export type BootFailureKind = 'seat-unresolved' | 'unknown';

export function classifyBootFailure(err: unknown): BootFailureKind {
  const name = (err as { name?: string } | null)?.name ?? '';
  const msg = err instanceof Error ? err.message : String(err);
  // ⚠ 认 name **也**认 message:错误跨了动态 import 边界之后 `instanceof` 未必成立,
  //   而只认 name 的话换个抛法就静默退化成 unknown(那是"翻译层看起来还在、其实不翻了")。
  if (name === 'SeatUnresolvedError' || msg.includes('未配模型')) return 'seat-unresolved';
  return 'unknown';
}

/**
 * 起不来时打给用户的那几行。**原始 message 原样带着。**
 *
 * @param cwd 出问题的那个仓 —— 必须写出来:座位是逐仓配的,用户得知道是哪个仓缺配置。
 */
export function formatBootFailure(err: unknown, cwd: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  const kind = classifyBootFailure(err);
  if (kind === 'seat-unresolved') {
    return [
      `omd tui 起不来:这个仓还没配座位(座位是**逐仓**的,配置在 ${cwd}/.omd/config.json)。`,
      '',
      '两条路任选一条:',
      '  omd init            首次配置向导(选档 + 填 key)',
      '  omd models auto     已经有 key 的话, 按渠道自动分配座位',
      '',
      `引擎原话: ${raw}`,
      '',
    ].join('\n');
  }
  return [`omd tui 起不来: ${raw}`, ''].join('\n');
}
