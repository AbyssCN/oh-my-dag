/**
 * repo-checks-manifest loader 单元测试 (D4 切片 1 verify, #271)。
 *
 * 覆盖 INV-D4-2 三态:
 *   ① 文件缺席 → `[]` (零回归锚点)
 *   ② 合法 JSON → 原样解析返回
 *   ③ 格式坏 (JSON 坏 / 顶层非数组 / 条目缺 id / command 缺 `{files}`) → throw,
 *      message 含文件路径 (排账可见, 拒绝静默掉线)
 *
 * 反向自检 (与 post-leaf-gate.test.ts / repo-checks.test.ts 同款):
 *   - 用 mkdtemp 隔振, 互不污染。
 *   - 禁词类样例**不出现**在测试字面量里 —— 需要样词时由 S3 拼接构造, S1 单元层
 *     只验装载契约, 不验仓规命令语义。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadRepoChecksManifest,
  REPO_CHECKS_MANIFEST_FILENAME,
} from './repo-checks-manifest';

// ── 测试用临时目录 ───────────────────────────────────────────────────────────

let tmpRoots: string[] = [];

async function newTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'omd-repo-checks-manifest-'));
  tmpRoots.push(dir);
  return dir;
}

beforeEach(() => {
  tmpRoots = [];
});

afterEach(async () => {
  await Promise.all(
    tmpRoots.map(async (d) => {
      try {
        await rm(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }),
  );
});

// ── INV-D4-2 ① 缺席 ──────────────────────────────────────────────────────────

describe('loadRepoChecksManifest / ① 缺席 = 今天 (零回归)', () => {
  test('文件不存在 → 返回 []', async () => {
    const tmp = await newTmp();
    expect(loadRepoChecksManifest(tmp)).toEqual([]);
  });

  test('文件名导出 = .omd-repo-checks.json (INV-D4-1 锚点)', () => {
    expect(REPO_CHECKS_MANIFEST_FILENAME).toBe('.omd-repo-checks.json');
  });
});

// ── INV-D4-2 ② 合法 ──────────────────────────────────────────────────────────

describe('loadRepoChecksManifest / ② 合法清单往返', () => {
  test('单条合法条目 → 原样返回 (id + command)', async () => {
    const tmp = await newTmp();
    const manifest = [{ id: 'only-one', command: 'scan --files {files}' }];
    await writeFile(join(tmp, REPO_CHECKS_MANIFEST_FILENAME), JSON.stringify(manifest));

    const result = loadRepoChecksManifest(tmp);
    expect(result).toEqual(manifest);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('only-one');
    expect(result[0]?.command).toBe('scan --files {files}');
  });

  test('多条合法条目 → 顺序与文件一致, 全部带 {files} 占位符', async () => {
    const tmp = await newTmp();
    const manifest = [
      { id: 'jargon', command: 'bun run scripts/jargon-scan.ts --files {files}' },
      { id: 'catch-evidence', command: 'bun run scripts/catch-evidence-scan.ts --files {files} --base HEAD' },
    ];
    await writeFile(join(tmp, REPO_CHECKS_MANIFEST_FILENAME), JSON.stringify(manifest));

    const result = loadRepoChecksManifest(tmp);
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.id)).toEqual(['jargon', 'catch-evidence']);
    expect(result[1]?.command).toContain('{files}');
  });

  test('空数组 (合法) → 返回 []', async () => {
    const tmp = await newTmp();
    await writeFile(join(tmp, REPO_CHECKS_MANIFEST_FILENAME), '[]');

    const result = loadRepoChecksManifest(tmp);
    expect(result).toEqual([]);
  });
});

// ── INV-D4-2 ③ 坏清单 (fail-loud) ────────────────────────────────────────────

describe('loadRepoChecksManifest / ③ 格式坏 → throw (path 必现)', () => {
  test('坏 JSON → throw, message 含文件绝对路径', async () => {
    const tmp = await newTmp();
    const manifestPath = join(tmp, REPO_CHECKS_MANIFEST_FILENAME);
    await writeFile(manifestPath, '{ this is not valid JSON');

    expect(() => loadRepoChecksManifest(tmp)).toThrow();
    try {
      loadRepoChecksManifest(tmp);
      throw new Error('unreachable: should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain(manifestPath);
    }
  });

  test('顶层非数组 (对象) → throw, message 含路径', async () => {
    const tmp = await newTmp();
    const manifestPath = join(tmp, REPO_CHECKS_MANIFEST_FILENAME);
    await writeFile(
      manifestPath,
      JSON.stringify({ checks: [{ id: 'a', command: 'scan {files}' }] }),
    );

    expect(() => loadRepoChecksManifest(tmp)).toThrow();
    try {
      loadRepoChecksManifest(tmp);
      throw new Error('unreachable: should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain(manifestPath);
      expect((e as Error).message).toContain('顶层必须是数组');
    }
  });

  test('顶层为字符串 → throw, message 含路径', async () => {
    const tmp = await newTmp();
    const manifestPath = join(tmp, REPO_CHECKS_MANIFEST_FILENAME);
    await writeFile(manifestPath, '"a string, not an array"');

    expect(() => loadRepoChecksManifest(tmp)).toThrow();
    try {
      loadRepoChecksManifest(tmp);
      throw new Error('unreachable: should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain(manifestPath);
    }
  });

  test('顶层为 null → throw, message 含路径', async () => {
    const tmp = await newTmp();
    const manifestPath = join(tmp, REPO_CHECKS_MANIFEST_FILENAME);
    await writeFile(manifestPath, 'null');

    expect(() => loadRepoChecksManifest(tmp)).toThrow();
    try {
      loadRepoChecksManifest(tmp);
      throw new Error('unreachable: should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain(manifestPath);
      expect((e as Error).message).toContain('顶层必须是数组');
    }
  });

  test('条目缺 id → throw, message 含路径 + 下标', async () => {
    const tmp = await newTmp();
    const manifestPath = join(tmp, REPO_CHECKS_MANIFEST_FILENAME);
    await writeFile(manifestPath, JSON.stringify([{ command: 'scan {files}' }]));

    expect(() => loadRepoChecksManifest(tmp)).toThrow();
    try {
      loadRepoChecksManifest(tmp);
      throw new Error('unreachable: should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain(manifestPath);
      expect((e as Error).message).toContain('[0]');
      expect((e as Error).message).toContain('id');
    }
  });

  test('id 为空串 → throw (id 不可为空)', async () => {
    const tmp = await newTmp();
    const manifestPath = join(tmp, REPO_CHECKS_MANIFEST_FILENAME);
    await writeFile(manifestPath, JSON.stringify([{ id: '', command: 'scan {files}' }]));

    expect(() => loadRepoChecksManifest(tmp)).toThrow();
    try {
      loadRepoChecksManifest(tmp);
      throw new Error('unreachable: should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain(manifestPath);
      expect((e as Error).message).toContain('id');
    }
  });

  test('id 非字符串 (数字) → throw', async () => {
    const tmp = await newTmp();
    const manifestPath = join(tmp, REPO_CHECKS_MANIFEST_FILENAME);
    await writeFile(manifestPath, JSON.stringify([{ id: 42, command: 'scan {files}' }]));

    expect(() => loadRepoChecksManifest(tmp)).toThrow();
    try {
      loadRepoChecksManifest(tmp);
      throw new Error('unreachable: should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain(manifestPath);
    }
  });

  test('command 缺 → throw, message 含路径 + 该条 id', async () => {
    const tmp = await newTmp();
    const manifestPath = join(tmp, REPO_CHECKS_MANIFEST_FILENAME);
    await writeFile(manifestPath, JSON.stringify([{ id: 'no-cmd' }]));

    expect(() => loadRepoChecksManifest(tmp)).toThrow();
    try {
      loadRepoChecksManifest(tmp);
      throw new Error('unreachable: should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain(manifestPath);
      expect((e as Error).message).toContain('no-cmd');
      expect((e as Error).message).toContain('command');
    }
  });

  test('command 无 {files} 占位符 → throw (INV-D4-1 协议锚点)', async () => {
    const tmp = await newTmp();
    const manifestPath = join(tmp, REPO_CHECKS_MANIFEST_FILENAME);
    await writeFile(manifestPath, JSON.stringify([{ id: 'global', command: 'global-scan' }]));

    expect(() => loadRepoChecksManifest(tmp)).toThrow();
    try {
      loadRepoChecksManifest(tmp);
      throw new Error('unreachable: should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain(manifestPath);
      expect((e as Error).message).toContain('{files}');
      expect((e as Error).message).toContain('global');
    }
  });

  test('★ severity 缺席 → 不带该键 (零回归锚: 既有 manifest 行为逐字节不变)', async () => {
    const tmp = await newTmp();
    await writeFile(
      join(tmp, REPO_CHECKS_MANIFEST_FILENAME),
      JSON.stringify([{ id: 'a', command: 'scan {files}' }]),
    );
    const checks = loadRepoChecksManifest(tmp);
    expect(checks[0]!.severity).toBeUndefined();
  });

  test('★ severity 合法值原样带出', async () => {
    const tmp = await newTmp();
    await writeFile(
      join(tmp, REPO_CHECKS_MANIFEST_FILENAME),
      JSON.stringify([{ id: 'a', command: 'scan {files}', severity: 'advisory' }]),
    );
    expect(loadRepoChecksManifest(tmp)[0]!.severity).toBe('advisory');
  });

  test('★ severity 拼错 → 响亮拒, 不静默当 blocking', async () => {
    // 静默当 blocking 会让人以为已经降级了、实际仍在杀节点 —— 那正是本仓要杀的形态。
    const tmp = await newTmp();
    const manifestPath = join(tmp, REPO_CHECKS_MANIFEST_FILENAME);
    await writeFile(
      manifestPath,
      JSON.stringify([{ id: 'a', command: 'scan {files}', severity: 'advisroy' }]),
    );
    try {
      loadRepoChecksManifest(tmp);
      throw new Error('unreachable: should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('severity');
      expect((e as Error).message).toContain('advisroy');
    }
  });

  test('条目本身非对象 (数组) → throw, message 含路径 + 下标', async () => {
    const tmp = await newTmp();
    const manifestPath = join(tmp, REPO_CHECKS_MANIFEST_FILENAME);
    await writeFile(manifestPath, JSON.stringify([['nested', 'array']]));

    expect(() => loadRepoChecksManifest(tmp)).toThrow();
    try {
      loadRepoChecksManifest(tmp);
      throw new Error('unreachable: should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain(manifestPath);
      expect((e as Error).message).toContain('[0]');
    }
  });

  test('第二条坏: 第一条合法不掩盖第二条坏 (不短路, 排账可见全貌)', async () => {
    const tmp = await newTmp();
    const manifestPath = join(tmp, REPO_CHECKS_MANIFEST_FILENAME);
    await writeFile(
      manifestPath,
      JSON.stringify([
        { id: 'good', command: 'scan --files {files}' },
        { id: 'bad', command: 'no-placeholder' }, // 第二条坏 → 应被立刻抓住
      ]),
    );

    expect(() => loadRepoChecksManifest(tmp)).toThrow();
    try {
      loadRepoChecksManifest(tmp);
      throw new Error('unreachable: should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain(manifestPath);
      expect((e as Error).message).toContain('[1]');
      expect((e as Error).message).toContain('bad');
    }
  });
});