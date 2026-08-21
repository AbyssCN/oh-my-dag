/**
 * **降级版不许盖掉一份不降级的 checkpoint**(2026-08-21,实测被抹两次之后补)。
 *
 * ## 现场
 *
 * 一份手写的、信息完整的交接 checkpoint 被机械降级版覆盖了两次。降级版长这样:
 * ```
 * <!-- DEGRADED: 验真闸两次未过 -->
 * ## §1 Active intent
 * (机械降级 — writer 蒸馏失败: 验真闸两次未过)
 * ## §2 Next concrete action
 * (无)
 * …§3–§9 全是 (无)
 * ```
 * 也就是说这条 fail-open 路径不是"吞了异常",是**把数据删了**。本仓的规矩是
 * 「fail-open 可以吞异常,不许吞证据」—— 删证据比吞证据重一档。
 *
 * ## 判据方向:陈旧但真 > 新鲜但空
 *
 * 旧那份至少还写着上一程干了什么;降级版一个字都没有,留着它等于交接断档。
 * 降级版本身仍落 `.degraded` sidecar —— 「蒸馏为什么失败」是修 writer 的唯一线索,
 * 直接丢掉就又犯一次吞证据。
 *
 * ⚠ 用 `mechanical: true` 强制降级,**不打模型** —— 这条闸要判的是"降级时写不写盘",
 * 与蒸馏质量无关。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWriter } from './writer';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 造一个临时 repo + 一份 CC transcript(两行足够让 excerpt 有内容)。 */
function fixture(): { cwd: string; transcript: string; sessionId: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-writer-clobber-'));
  dirs.push(cwd);
  const transcript = join(cwd, 't.jsonl');
  writeFileSync(
    transcript,
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '把 A 那片做掉' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '做完了,验过了' }] } }),
    ].join('\n'),
  );
  return { cwd, transcript, sessionId: 'sess-clobber' };
}

/** 找到 writer 会写的那个 checkpoint 路径(经真实 runWriter 返回,不手拼)。 */
async function firstRun(f: ReturnType<typeof fixture>): Promise<string> {
  const r = await runWriter({ transcript: f.transcript, sessionId: f.sessionId, cwd: f.cwd, mechanical: true });
  return r.checkpointPath;
}

const GOOD = [
  '## §1 Active intent',
  '手写的完整交接:A 片做完了,C 闸接上了',
  '## §2 Next concrete action',
  '接着做回执说真话',
  ...['§3 Session directives', '§4 Tasks', '§5 Current work', '§6 Files & anchors', '§7 Discovered knowledge', '§8 Errors & fixes', '§9 Decisions'].map(
    (h) => `## ${h}\n(有内容)`,
  ),
].join('\n\n');

describe('runWriter —— 降级不许覆盖好 checkpoint', () => {
  test('★ 已有不降级 checkpoint + 本次降级 → **原文件一个字不动**', async () => {
    // 怎么让它红: 把 writer.ts 里那段 `if (degraded && prevCheckpoint && !prev…DEGRADED)` 摘掉
    // → 回到无条件 writeFileSync, 手写那份被抹, 这条红。那正是 2026-08-21 之前的实装。
    const f = fixture();
    const checkpointPath = await firstRun(f);
    writeFileSync(checkpointPath, GOOD); // 冒充"手写的好版本"

    // 换一份新 transcript 内容, 否则会走 "无新增 → skipped" 那条路, 测不到覆盖。
    writeFileSync(
      f.transcript,
      readFileSync(f.transcript, 'utf-8') +
        '\n' +
        JSON.stringify({ type: 'user', message: { role: 'user', content: '再来一轮新的内容' } }),
    );
    const r = await runWriter({ transcript: f.transcript, sessionId: f.sessionId, cwd: f.cwd, mechanical: true });

    expect(r.degraded).toBe(true);
    expect(readFileSync(checkpointPath, 'utf-8')).toBe(GOOD); // 逐字未变
  });

  test('★ 降级版落 `.degraded` sidecar —— 不覆盖 ≠ 把失败证据也丢了', async () => {
    // 怎么让它红: 只 return 不写 sidecar → 「蒸馏为什么失败」事后无从查, 这条红。
    const f = fixture();
    const checkpointPath = await firstRun(f);
    writeFileSync(checkpointPath, GOOD);
    writeFileSync(
      f.transcript,
      readFileSync(f.transcript, 'utf-8') + '\n' + JSON.stringify({ type: 'user', message: { role: 'user', content: '新内容触发重蒸馏' } }),
    );

    await runWriter({ transcript: f.transcript, sessionId: f.sessionId, cwd: f.cwd, mechanical: true });

    expect(existsSync(`${checkpointPath}.degraded`)).toBe(true);
    expect(readFileSync(`${checkpointPath}.degraded`, 'utf-8')).toContain('DEGRADED');
  });

  test('★ 已有的**也是**降级版 → 照常覆盖(别把第一份降级版永久钉死)', async () => {
    // 反面锚: 不覆盖的判据是"旧的比新的好", 而两份都降级时旧的并不更好。
    // 怎么让它红: 把条件里的 `!prevCheckpoint.startsWith('<!-- DEGRADED')` 删掉 → 永远不覆盖, 这条红。
    const f = fixture();
    const checkpointPath = await firstRun(f);
    const first = readFileSync(checkpointPath, 'utf-8');
    expect(first).toContain('DEGRADED'); // firstRun 用的就是 mechanical

    writeFileSync(
      f.transcript,
      readFileSync(f.transcript, 'utf-8') + '\n' + JSON.stringify({ type: 'user', message: { role: 'user', content: '第二轮新内容' } }),
    );
    await runWriter({ transcript: f.transcript, sessionId: f.sessionId, cwd: f.cwd, mechanical: true });

    expect(readFileSync(checkpointPath, 'utf-8')).not.toBe(first); // 真的更新了
  });

  test('★ 没有旧 checkpoint 时降级照写(首次落盘不该被这条挡住)', async () => {
    const f = fixture();
    const r = await runWriter({ transcript: f.transcript, sessionId: f.sessionId, cwd: f.cwd, mechanical: true });
    expect(r.degraded).toBe(true);
    expect(readFileSync(r.checkpointPath, 'utf-8')).toContain('DEGRADED');
  });
});

// mkdirSync 未直接使用但保留 import 会被 lint 抓 —— 显式引用一次, 说明它属于 fixture 语义。
void mkdirSync;
