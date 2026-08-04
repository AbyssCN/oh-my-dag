/**
 * t1 (图#11): 同名 checkpoint 覆写前留存旧轮 —— 证据不许被静默抹掉。
 *
 * 背景: f2-a-1 两轮 run 的 checkpoint 按 nodeId 逐轮覆写, 第一轮尾链在事后时间轴上整体消失
 * (交接 20 把它读成了「547s 调度空洞」)。修法: 覆写前把旧文件归档成 `<nodeId>.__r<K>.json`。
 *
 * 反向自检: 本文件先于修复跑过一次 —— 「旧轮留存」那条在未修引擎上红 (归档文件不存在),
 * 修后绿。「loadAllGreen 不读归档」钉住 resume 语义不因此改变 (归档若被当绿节点读回,
 * 旧轮 done 会顶掉新轮结果 —— 那比丢证据更坏)。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckpointManager } from './checkpoint-manager';
import type { NodeCheckpoint } from './types';

const dirs: string[] = [];
const freshRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'omd-cp-archive-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const cp = (nodeId: string, status: 'done' | 'failed', summary: string): NodeCheckpoint =>
  ({
    nodeId,
    leafKind: 'agent',
    status,
    outputPaths: [],
    artifactHashes: {},
    tokenUsage: null,
    summary,
    durationMs: 10,
    createdAt: new Date().toISOString(),
    schemaVersion: 1,
  }) as NodeCheckpoint;

describe('checkpoint 覆写归档 (t1 图#11)', () => {
  test('同名二次保存 → 旧轮归档 __r1, 最新在原名; 三次 → __r2', () => {
    const mgr = new CheckpointManager(freshRoot());
    mgr.saveCheckpoint('run1', cp('audit', 'failed', '第一轮'));
    mgr.saveCheckpoint('run1', cp('audit', 'done', '第二轮'));
    const dir = join(dirs[dirs.length - 1]!, '.omd', 'continuity', 'run1');
    expect(existsSync(join(dir, 'audit.__r1.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'audit.__r1.json'), 'utf-8')).summary).toBe('第一轮');
    expect(JSON.parse(readFileSync(join(dir, 'audit.json'), 'utf-8')).summary).toBe('第二轮');
    mgr.saveCheckpoint('run1', cp('audit', 'done', '第三轮'));
    expect(JSON.parse(readFileSync(join(dir, 'audit.__r2.json'), 'utf-8')).summary).toBe('第二轮');
    expect(JSON.parse(readFileSync(join(dir, 'audit.json'), 'utf-8')).summary).toBe('第三轮');
  });

  test('loadAllGreen 不读归档 (resume 只认最新, 旧轮 done 不许顶掉新轮)', () => {
    const mgr = new CheckpointManager(freshRoot());
    mgr.saveCheckpoint('run1', cp('audit', 'done', '第一轮')); // 旧轮是 done
    mgr.saveCheckpoint('run1', cp('audit', 'failed', '第二轮')); // 新轮 failed
    const green = mgr.loadAllGreen('run1');
    // 归档的第一轮 done 不许出现 —— 出现即 resume 会把失败节点当绿跳过
    expect(green.filter((c) => c.nodeId === 'audit')).toHaveLength(0);
  });

  test('loadCheckpoint 按 nodeId 只回最新', () => {
    const mgr = new CheckpointManager(freshRoot());
    mgr.saveCheckpoint('run1', cp('audit', 'done', '第一轮'));
    mgr.saveCheckpoint('run1', cp('audit', 'done', '第二轮'));
    expect(mgr.loadCheckpoint('run1', 'audit')?.summary).toBe('第二轮');
  });
});
