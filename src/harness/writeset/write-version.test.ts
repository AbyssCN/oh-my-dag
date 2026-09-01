/**
 * 版本守卫的反向自检(2026-09-01)。
 *
 * ## 现场(先证明这道闸有活干,再有这个文件)
 *
 * `#253` 之后写型 run 落隔离 worktree,但隔离粒度是 **per-run**:
 * `run-worktree.ts:154` `runWorktreeDir(cwd, runId)` 只以 runId 作键,`assemble.ts:602` 起
 * 一个 run 只造**一个** runner(cwd 烤死在构造期),而 agent 叶默认并发 **36**
 * (`fleet.ts:40`)。所以一个 run 的并发兄弟共用一棵树、一个 index。
 * 今天这件事只有事后才知道:`touch-ledger.ts:4`「只记不拦」,`engine.ts:5671` 的
 * `detectRuntimeWriteRace` 在整张图跑完之后才跑且自标「只报不拦」。
 *
 * ## 两侧同等重要
 *
 * 拦住盲盖只是一半。另一半是**别拦正当的写** —— 新建文件、连写两次、edit 之后再 write,
 * 这些今天全是合法的,拦一个就多一个假 major,而假 major 的代价是有人把整条闸关掉。
 * 下面两组用例数量对等。
 *
 * ## 怎么让它红(每条用例上都写了;摘掉不红的测试不算数)
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkWriteVersion,
  describeVersionDenied,
  observePath,
  type FileObservation,
} from './write-version';

const present = (hash: string | null, mode = '644', link: string | null = null): FileObservation => ({
  kind: 'present',
  state: { hash, mode, link },
});
const absent: FileObservation = { kind: 'absent' };

describe('版本守卫 —— 拦住的那一侧', () => {
  test('★★ 读过之后被兄弟改了 → 拒 (FS_STALE_VERSION)', () => {
    // 怎么让它红: 把 write-version.ts 的 `sameState` 改成 `return true` → 这条红。
    const v = checkWriteVersion({ observed: present('aaaa'), actual: present('bbbb') });
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('FS_STALE_VERSION');
    // 证据必须说清变的是哪一位 —— 只说"失配"执行体只会原样再试一次。
    expect(v.evidence).toContain('aaaa');
    expect(v.evidence).toContain('bbbb');
  });

  test('★★ 一次都没读过, 而文件已经在盘上 → 拒 (FS_NOT_OBSERVED)', () => {
    // 怎么让它红: 把 `observed === undefined` 那条分支改成恒 `{allowed:true,...}` → 这条红。
    const v = checkWriteVersion({ observed: undefined, actual: present('aaaa') });
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('FS_NOT_OBSERVED');
  });

  test('★ 内容一样但 mode 变了 → 拒 (hash 的盲区之一)', () => {
    // 怎么让它红: 把 sameState 里的 `a.mode === b.mode` 删掉 → 这条红。
    const v = checkWriteVersion({ observed: present('aaaa', '644'), actual: present('aaaa', '755') });
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('FS_STALE_VERSION');
  });

  test('★ 内容一样但 symlink 换了目标 → 拒 (hash 的盲区之二: 写会落到另一个文件上)', () => {
    // 怎么让它红: 把 sameState 里的 `a.link === b.link` 删掉 → 这条红。
    const v = checkWriteVersion({
      observed: present('aaaa', '777', '/repo/real-a'),
      actual: present('aaaa', '777', '/repo/real-b'),
    });
    expect(v.allowed).toBe(false);
  });

  test('★★ 观察到不存在, 写的那一刻却有了 → 拒, 且归 STALE 不归 NOT_OBSERVED', () => {
    // 「没观察过」与「观察到不存在」是两个态, 归错格 = 判词让人去做错的下一步
    // (NOT_OBSERVED 说"先去读一下", STALE 说"重读并重想该写什么")。
    // 怎么让它红: 把 `observed.kind === 'absent'` 那条分支删掉 (让它掉进最后的 sameState 比较)
    //            → 类型先报错; 或把它的 code 改成 'FS_NOT_OBSERVED' → 这条红。
    const v = checkWriteVersion({ observed: absent, actual: present('aaaa') });
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('FS_STALE_VERSION');
  });

  test('★ 观察到存在, 写的那一刻被删了 → 拒', () => {
    // 怎么让它红: 把 `actual.kind === 'absent'` 那条分支改成 allowed:true → 这条红。
    const v = checkWriteVersion({ observed: present('aaaa'), actual: absent });
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('FS_STALE_VERSION');
  });
});

describe('版本守卫 —— 放行的那一侧 (假 major 的代价是有人把闸关掉)', () => {
  test('★★ 新建一个盘上没有的文件 (没观察过 + 不存在) → 放行', () => {
    // 这是绝大多数正当写。怎么让它红: 把 NOT_OBSERVED 那条判据从「盘上有」放宽成「一律拒」→ 这条红。
    expect(checkWriteVersion({ observed: undefined, actual: absent }).allowed).toBe(true);
  });

  test('★ 观察到不存在 + 此刻仍不存在 → 放行 (新建)', () => {
    expect(checkWriteVersion({ observed: absent, actual: absent }).allowed).toBe(true);
  });

  test('★★ 读过之后没人动过 → 放行 (逐位一致)', () => {
    const v = checkWriteVersion({ observed: present('aaaa', '644', null), actual: present('aaaa', '644', null) });
    expect(v.allowed).toBe(true);
    expect(v.code).toBeNull();
  });

  test('★ 连写两次同一个文件 → 第二次放行 (第一次写完会重新观察)', () => {
    // 模拟 agent-tools 的 write 路径: 写完 observed(full) 记的是新版本, 第二次写自然一致。
    const afterFirstWrite = present('bbbb');
    expect(checkWriteVersion({ observed: afterFirstWrite, actual: present('bbbb') }).allowed).toBe(true);
  });
});

describe('observePath —— 观察侧与判侧必须是同一把尺子', () => {
  test('★★ 同一个文件量两次 → 逐位一致 (量法漂了会造出假失配)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-wv-'));
    try {
      writeFileSync(join(dir, 'a.txt'), 'hello');
      const o1 = observePath(dir, 'a.txt');
      const o2 = observePath(dir, 'a.txt');
      expect(o1.kind).toBe('present');
      expect(checkWriteVersion({ observed: o1, actual: o2 }).allowed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('★★ 真改一次内容 → 判失配 (端到端: 不靠手捏的 hash)', () => {
    // 怎么让它红: 把 observePath 改成恒返 {kind:'absent'} → observed 变 absent 而 actual 也 absent,
    //            这条会读成放行 → 红。
    const dir = mkdtempSync(join(tmpdir(), 'omd-wv-'));
    try {
      const p = join(dir, 'a.txt');
      writeFileSync(p, 'hello');
      const before = observePath(dir, 'a.txt');
      writeFileSync(p, 'hello world'); // ← 并发兄弟干的那一下
      const v = checkWriteVersion({ observed: before, actual: observePath(dir, 'a.txt') });
      expect(v.allowed).toBe(false);
      expect(v.code).toBe('FS_STALE_VERSION');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('★ 不存在的路径 → absent, **不是** present-with-null-hash', () => {
    // NULL≠0≠不适用: 「量过了, 不在盘上」必须是自己的一格, 不许折进 present 里的 hash=null
    //  (目录就是 present ∧ hash=null —— 两者折在一起就再也分不开)。
    // 怎么让它红: 把 observePath 的存在判据从 `state.mode === null` 换成 `state.hash === null` →
    //            下面的目录用例会翻成 absent → 红。
    const dir = mkdtempSync(join(tmpdir(), 'omd-wv-'));
    try {
      expect(observePath(dir, 'nope.txt').kind).toBe('absent');
      mkdirSync(join(dir, 'sub'));
      const d = observePath(dir, 'sub');
      expect(d.kind).toBe('present');
      // 目录: lstat 成功 (mode 有) 但 hashArtifact 读不出内容 (hash 为 null) —— 两位不是一件事。
      expect(d.kind === 'present' && d.state.hash).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('★ symlink 换目标 → 端到端判失配 (内容 hash 一个字节不动)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-wv-'));
    try {
      writeFileSync(join(dir, 'a'), 'same');
      writeFileSync(join(dir, 'b'), 'same'); // 内容完全相同 → hash 相同
      symlinkSync(join(dir, 'a'), join(dir, 'l'));
      const before = observePath(dir, 'l');
      rmSync(join(dir, 'l'));
      symlinkSync(join(dir, 'b'), join(dir, 'l')); // ← 兄弟把 symlink 指到别处
      const v = checkWriteVersion({ observed: before, actual: observePath(dir, 'l') });
      expect(v.allowed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('★ chmod → 端到端判失配', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-wv-'));
    try {
      const p = join(dir, 'a.sh');
      writeFileSync(p, '#!/bin/sh\n');
      const before = observePath(dir, 'a.sh');
      chmodSync(p, 0o755);
      expect(checkWriteVersion({ observed: before, actual: observePath(dir, 'a.sh') }).allowed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('判词 —— 三条硬要求 (少一条闸就会被绕过或被关掉)', () => {
  test('★★ STALE 判词: 带证据 + 明说别重试 + 给下一步', () => {
    // 怎么让它红: 把 describeVersionDenied 里 '别原样重试' 那半句删掉 → 这条红。
    const v = checkWriteVersion({ observed: present('aaaa'), actual: present('bbbb') });
    const msg = describeVersionDenied('src/x.ts', v, 'write');
    expect(msg).toContain('BLOCKED 写版本失配');
    expect(msg).toContain('aaaa'); // 证据原样带上
    expect(msg).toContain('别原样重试'); // node-failure.ts:178 的既有纪律
    expect(msg).toContain('read(src/x.ts)'); // 下一步:重读再写
    expect(msg).toContain('升 owner'); // 另一条出路
  });

  test('★★ NOT_OBSERVED 与 STALE 的判词必须不同 (两码的修法不同)', () => {
    // 怎么让它红: 把 describeVersionDenied 的 code 分支去掉、两码共用一条判词 → 这条红。
    const notObserved = describeVersionDenied(
      'src/x.ts',
      checkWriteVersion({ observed: undefined, actual: present('aaaa') }),
      'write',
    );
    const stale = describeVersionDenied(
      'src/x.ts',
      checkWriteVersion({ observed: present('aaaa'), actual: present('bbbb') }),
      'write',
    );
    expect(notObserved).toContain('写前未观察');
    expect(notObserved).not.toContain('BLOCKED 写版本失配');
    expect(stale).not.toContain('写前未观察');
  });
});
