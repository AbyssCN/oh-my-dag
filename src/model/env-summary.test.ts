/**
 * env 摘要的**位置与嗓门**契约(2026-08-12,片 C)。
 *
 * ## 事故
 *
 * `bootstrapModelRuntime` 每次都往 stderr 印一行 `[omd env] providers=[…] · web=✓`。
 * 每个 dag-exec 子进程、每个脚本各印一次;2026-08-12 一天六个 exec.log 里它出现六次,
 * **一次都没被读**。而同一天我因为不知道「哪份 config.json 生效」判错了一次资源可用性,
 * 据此撤了两个健康的 run —— 那个路径本可以印在这一行里,但这一行在没人开的日志里。
 *
 * ## 两条不变量
 *
 * 1. **正常时不出声**:它只在异常(provider 一个都没注册上)时是信息,其余时候是噪声。
 *    ⚠ 这与「四格计数 0 也印」**方向相反**,是刻意的:那是**分格**(回答「这一格是多少」,
 *    缺席与 0 必须分开);这是**告警**(回答「有没有出事」,没出事就该安静)。
 *    判别法写进 `renderEnvSummary` 的注了。
 * 2. **信息不许因此消失**:摘要移进**有人读的地方**(起跑回执),而不是删掉。
 *    静默之后「查过且正常」与「压根没跑」就分不开了 —— 所以必须有一个出口留着。
 *
 * ## 反向自检
 *
 * 每条注释里写了「怎么让它红」,两条都当场证伪过。
 */
import { describe, expect, test } from 'bun:test';
import { envSummaryLine, shouldWarnEnv } from './bootstrap';

describe('env 摘要', () => {
  test('★ 1: provider 非空 → 不告警; 空 → 告警', () => {
    // 怎么让它红: shouldWarnEnv 改成恒 true(回到每次都印)→ 第一条红。
    expect(shouldWarnEnv(['deepseek', 'mimo'])).toBe(false);
    // 怎么让它红: 改成恒 false → 第二条红。provider 空 = .env 没配/没 propagate,
    // 那是**必须立刻看见**的一件事, 不许因为「安静点」把它一起吞了。
    expect(shouldWarnEnv([])).toBe(true);
  });

  test('★ 2: 摘要行带 provider 列表与**生效的** config 路径', () => {
    const line = envSummaryLine(['deepseek', 'mimo']);
    // 怎么让它红: 摘要里不拼 config 路径 → 红。
    // 这一位是片 C 的全部理由: 2026-08-12 我据 `~/.omd/config.json` 判了一次资源不可用,
    // 而仓内那份才生效(role-models.ts:79-88 撞到仓根就停, 刻意不越仓边界)。
    expect(line).toContain('config=');
    expect(line).toContain('.omd/config.json');
    expect(line).toContain('deepseek');
    // provider 空时要写出**怎么办**, 不能只说「空」
    expect(envSummaryLine([])).toMatch(/\.env|--env-file/);
  });
});
