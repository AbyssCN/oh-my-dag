/**
 * **`writer.log` 的 sha 必须锚在盘上那份 checkpoint,不是"本次蒸馏出的那份"**
 * (owner 2026-08-22)。
 *
 * ## 现场
 *
 * session `50f0173c`:writer 20:35:17 蒸馏出 5,821 字符落盘 + 镜像进 SQLite,
 * **20 秒后**一次进程外的 Write 把 `checkpoint.md` 换成另一份 2,902 字符的手写版。
 * 事后唯一的痕迹是 `writer.log` 里对不上的 `chars=5821` —— 而"对不对得上"得先有人
 * 去数盘上那份多少字符。没人会去数。**漂了不留痕。**
 *
 * 这不是闸:omd 拦不住自己进程外的覆盖,也不该拦。这几条判的是**锚本身立得住**——
 * 锚要是记成"我打算写的那份",漂就永远判不出来,字段等于白加。
 *
 * ⚠ 全部用 `mechanical: true` 强制降级,**不打模型**:要判的是"哈希取自哪份",
 * 与蒸馏质量无关。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWriter } from './writer';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 与 `sha256sum … | cut -c1-12` 逐字一致 —— 测试这侧独立算一遍, 不 import 实装的 helper。 */
const expectSha = (s: string): string => createHash('sha256').update(s, 'utf-8').digest('hex').slice(0, 12);

function fixture(): { cwd: string; transcript: string; sessionId: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-writer-sha-'));
  dirs.push(cwd);
  const transcript = join(cwd, 't.jsonl');
  writeFileSync(
    transcript,
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '把 A 那片做掉' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '做完了,验过了' }] } }),
    ].join('\n'),
  );
  return { cwd, transcript, sessionId: 'sess-sha' };
}

/** 追一行新内容, 否则会走「无新增 → skipped」那条路。 */
function appendTurn(transcript: string, text: string): void {
  writeFileSync(transcript, `${readFileSync(transcript, 'utf-8')}\n${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}`);
}

const GOOD = [
  '## §1 Active intent',
  '手写的完整交接',
  '## §2 Next concrete action',
  '接着做',
  ...['§3 Session directives', '§4 Tasks', '§5 Current work', '§6 Files & anchors', '§7 Discovered knowledge', '§8 Errors & fixes', '§9 Decisions'].map(
    (h) => `## ${h}\n(有内容)`,
  ),
].join('\n\n');

describe('runWriter —— sha 锚在盘上那份', () => {
  test('★ 正常落盘:sha = 盘上文件的 sha256 前 12 位', async () => {
    // 怎么让它红: 把 `sha: sha12(md)` 改成任意常量 / 改成 hash 别的串 → 这条红。
    const f = fixture();
    const r = await runWriter({ transcript: f.transcript, sessionId: f.sessionId, cwd: f.cwd, mechanical: true });
    expect(r.sha).toBe(expectSha(readFileSync(r.checkpointPath, 'utf-8')));
  });

  test('★ skipped(无新增内容, 不写盘):sha 是**旧**那份的, 不是这次算出来的', async () => {
    // 怎么让它红: 三条返回路径共用 `sha12(md)` → skipped 那条会报"本次要写的那份"的哈希,
    // 而盘上是旧的 → 这条红。那正好是这个字段最容易被写错的地方。
    const f = fixture();
    const first = await runWriter({ transcript: f.transcript, sessionId: f.sessionId, cwd: f.cwd, mechanical: true });
    const onDisk = readFileSync(first.checkpointPath, 'utf-8');

    const second = await runWriter({ transcript: f.transcript, sessionId: f.sessionId, cwd: f.cwd, mechanical: true });
    expect(second.skipped).toBe(true);
    expect(second.sha).toBe(expectSha(onDisk));
    expect(readFileSync(first.checkpointPath, 'utf-8')).toBe(onDisk); // 真没写盘
  });

  test('★ 降级不覆盖:sha 是被保留的那份的, 不是降级版的', async () => {
    // 怎么让它红: 这条路 return `sha12(md)`(md = 降级版) → 与盘上的 GOOD 对不上, 这条红。
    const f = fixture();
    const first = await runWriter({ transcript: f.transcript, sessionId: f.sessionId, cwd: f.cwd, mechanical: true });
    writeFileSync(first.checkpointPath, GOOD); // 冒充手写好版本
    appendTurn(f.transcript, '新内容触发重蒸馏');

    const r = await runWriter({ transcript: f.transcript, sessionId: f.sessionId, cwd: f.cwd, mechanical: true });
    expect(r.degraded).toBe(true);
    expect(r.sha).toBe(expectSha(GOOD));
    expect(r.sha).not.toBe(expectSha(readFileSync(`${first.checkpointPath}.degraded`, 'utf-8')));
  });

  test('★ 落盘后被进程外改掉 → sha 与盘上不再相等(这就是它要抓的那个漂)', async () => {
    // 这条不是反向自检, 是**正面演示**: 复现 50f0173c 那次现场的最小形态。
    // 怎么让它红: 让 writer 每次返回时现读盘算哈希(而不是记它写下去的那份)——
    // 那样漂就被抹平, 字段失去意义, 这条红。
    const f = fixture();
    const r = await runWriter({ transcript: f.transcript, sessionId: f.sessionId, cwd: f.cwd, mechanical: true });
    expect(r.sha).toBe(expectSha(readFileSync(r.checkpointPath, 'utf-8')));

    writeFileSync(r.checkpointPath, '手写版覆盖了机器版'); // 进程外那一手
    expect(r.sha).not.toBe(expectSha(readFileSync(r.checkpointPath, 'utf-8')));
  });
});
