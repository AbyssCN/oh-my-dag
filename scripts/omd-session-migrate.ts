/**
 * scripts/omd-session-migrate —— 把旧 `.omd/chat/<id>.json` 迁进 pi 的 append-only JSONL(SDD 片 C)。
 *
 * ## 三条纪律,每条都有代价来路
 *
 * 1. **默认只报不改**(`--write` 才动文件)。迁移是一次性、不可逆的动作,
 *    而这个仓的判据是「删/覆盖之前先看目标」。
 * 2. **逐条校验才算迁成**:条数相同 **且** 每条消息 `JSON.stringify` 逐字相同。
 *    校验不过 ⇒ **不动旧文件**、响亮报出来(迁一半还把旧的删了 = 静默丢会话)。
 * 3. **幂等**:已经在新库里的 id 直接跳过并说明。跑两遍不许出现两份。
 *
 * ⚠ 旧文件迁完**改名** `<id>.json.migrated`,**不删**。要清由人另外动手。
 *
 * ## 用法
 *
 *   bun run scripts/omd-session-migrate.ts              # 报告(默认, 不改任何文件)
 *   bun run scripts/omd-session-migrate.ts --write      # 真迁
 *   bun run scripts/omd-session-migrate.ts --cwd /path  # 指定仓根(默认 process.cwd())
 *
 * 退出码:0 没有可迁的 / dry 跑完且全都能迁 · 1 有校验不过的 · 2 迁完了(--write)。
 */
import { existsSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createOmdSessionStore } from '../src/harness/chat/session-store';
import { dataPath } from '../src/harness/project-scope';

/** 与 `ChatStore.dir()` 同一条判断 —— 两处漂开就会去迁一个空目录然后报"没有可迁的"。 */
function chatDir(repoRoot: string): string {
  return process.env.OMD_DATA_HOME?.trim() ? dataPath('chat') : join(repoRoot, '.omd/chat');
}

export interface OldSession {
  id: string;
  title?: string;
  messages: AgentMessage[];
  parent?: { id: string; atMessage: number };
}

/** 旧格式的文件名单(只认 `<id>.json`,不碰 `.migrated` 与新库那层目录)。 */
export function oldFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => join(dir, e.name))
    .sort();
}

export function readOld(path: string): OldSession | { error: string } {
  try {
    const o = JSON.parse(readFileSync(path, 'utf-8')) as Partial<OldSession>;
    if (typeof o.id !== 'string' || !Array.isArray(o.messages)) return { error: 'id 或 messages 字段不对' };
    return { id: o.id, messages: o.messages as AgentMessage[], ...(o.title ? { title: o.title } : {}), ...(o.parent ? { parent: o.parent } : {}) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * 校验:**条数 + 逐条逐字**。
 *
 * ⚠ 只比条数是不够的 —— 投影层要是把 `content` 结构改了形,条数照样对得上
 * (本仓那条"结论对 ≠ 证据够格")。
 */
export function sameMessages(a: readonly AgentMessage[], b: readonly AgentMessage[]): { ok: true } | { ok: false; why: string } {
  if (a.length !== b.length) return { ok: false, why: `条数不同:旧 ${a.length} / 新 ${b.length}` };
  for (let i = 0; i < a.length; i++) {
    const x = JSON.stringify(a[i]);
    const y = JSON.stringify(b[i]);
    if (x !== y) return { ok: false, why: `第 ${i + 1} 条不同:\n    旧 ${x.slice(0, 160)}\n    新 ${y.slice(0, 160)}` };
  }
  return { ok: true };
}

export interface MigrateReport {
  migrated: string[];
  skipped: { id: string; why: string }[];
  failed: { id: string; why: string }[];
}

export async function migrate(repoRoot: string, write: boolean): Promise<MigrateReport> {
  const dir = chatDir(repoRoot);
  const store = createOmdSessionStore(repoRoot);
  const existing = new Set((await store.list()).map((m) => m.id));
  const report: MigrateReport = { migrated: [], skipped: [], failed: [] };

  for (const path of oldFiles(dir)) {
    const old = readOld(path);
    if ('error' in old) {
      report.failed.push({ id: path, why: `读不出来:${old.error}` });
      continue;
    }
    if (existing.has(old.id)) {
      report.skipped.push({ id: old.id, why: '新库里已经有这个 id(幂等跳过)' });
      continue;
    }
    if (!write) {
      report.migrated.push(old.id); // dry:只说"能迁"
      continue;
    }
    const sess = await store.create(old.id, old.title ?? '');
    for (const m of old.messages) await sess.append(m);
    const check = sameMessages(old.messages, await sess.messages());
    if (!check.ok) {
      // ⚠ 校验不过**不动旧文件** —— 新库里那份留着给人看(删它会把证据一起删掉)。
      report.failed.push({ id: old.id, why: check.why });
      continue;
    }
    renameSync(path, `${path}.migrated`);
    report.migrated.push(old.id);
  }
  return report;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--cwd');
  const repoRoot = i === -1 ? process.cwd() : (argv[i + 1] as string);
  const write = argv.includes('--write');

  const r = await migrate(repoRoot, write);
  const dir = chatDir(repoRoot);
  console.log(`会话目录:${dir}`);
  if (r.migrated.length === 0 && r.skipped.length === 0 && r.failed.length === 0) {
    console.log('没有旧格式会话 —— 不用迁');
    process.exit(0);
  }
  if (r.migrated.length) console.log(`${write ? '已迁' : '能迁'} ${r.migrated.length} 份:${r.migrated.join(', ')}`);
  for (const s of r.skipped) console.log(`跳过 ${s.id}:${s.why}`);
  for (const f of r.failed) console.log(`✗ ${f.id}:${f.why}`);
  if (!write) console.log('\n(dry)没有改动任何文件。真要迁:加 --write');
  process.exit(r.failed.length > 0 ? 1 : write ? 2 : 0);
}

if (import.meta.main) void main();
