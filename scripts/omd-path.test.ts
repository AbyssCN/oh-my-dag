import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOmdPath } from './omd-path';
import { saveMap } from '../src/harness/pathfinder-extension';

function collect() {
  const lines: string[] = [];
  return { out: (s: string) => lines.push(s), text: () => lines.join('\n') };
}

describe('omd-path CLI', () => {
  test('--help prints usage, exit 0, needs no cwd/env/keys', () => {
    const c = collect();
    const code = runOmdPath(['--help'], { cwd: '/definitely/not/a/repo', out: c.out });
    expect(code).toBe(0);
    expect(c.text().toLowerCase()).toContain('usage');
  });

  test('-h alias also prints usage exit 0', () => {
    const c = collect();
    expect(runOmdPath(['-h'], { cwd: '/nope', out: c.out })).toBe(0);
    expect(c.text().toLowerCase()).toContain('usage');
  });

  test('no arg, no maps → friendly empty message exit 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-path-'));
    try {
      const c = collect();
      expect(runOmdPath([], { cwd: dir, out: c.out })).toBe(0);
      expect(c.text().toLowerCase()).toContain('no open maps');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no arg → lists open maps with destination + counts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-path-'));
    try {
      saveMap(
        {
          destination: 'Ship X',
          slug: 'ship-x',
          tickets: [{ id: 'a', type: 'task', title: 'a', blockedBy: [], status: 'open' }],
          decisionsLog: [],
        },
        dir,
      );
      const c = collect();
      expect(runOmdPath([], { cwd: dir, out: c.out })).toBe(0);
      const text = c.text();
      expect(text).toContain('ship-x');
      expect(text).toContain('Ship X');
      expect(text).toContain('1 open');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('<destination> creates a map (markdown truth on disk), exit 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-path-'));
    try {
      const c = collect();
      expect(runOmdPath(['Build', 'the', 'thing'], { cwd: dir, out: c.out })).toBe(0);
      expect(c.text().toLowerCase()).toContain('created');
      expect(existsSync(join(dir, 'docs', 'plan', 'pathfinder', 'build-the-thing.md'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('<destination> twice → second resumes (idempotent)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-path-'));
    try {
      runOmdPath(['Ship X'], { cwd: dir });
      const c = collect();
      expect(runOmdPath(['Ship X'], { cwd: dir, out: c.out })).toBe(0);
      expect(c.text().toLowerCase()).toContain('resumed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
