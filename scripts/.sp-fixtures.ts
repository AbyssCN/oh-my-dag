// ad-hoc fixture check — NOT a test file
import {
  analyzeRun,
  median,
  parseNodesColumn,
  renderMarkdown,
  shapeBucket,
  type RunNode,
  type RunCounters,
  type MarkdownGroup,
} from './scripts/speedup-readout.ts';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, got: unknown, want: unknown): void {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.log(`✗ ${name} — got`, got, 'want', want); }
}
function eq(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

// 8.1 linear
const linear: RunNode[] = [
  { id: 'A', deps: [], durationMs: 100 },
  { id: 'B', deps: ['A'], durationMs: 200 },
  { id: 'C', deps: ['B'], durationMs: 300 },
];
check('8.1 linear', eq(analyzeRun(linear), { kind: 'ok', totalMs: 600, criticalMs: 600, speedup: 1 }), analyzeRun(linear), { kind: 'ok', totalMs: 600, criticalMs: 600, speedup: 1 });

// 8.2 diamond
const diamond: RunNode[] = [
  { id: 'A', deps: [], durationMs: 100 },
  { id: 'B', deps: ['A'], durationMs: 200 },
  { id: 'C', deps: ['A'], durationMs: 300 },
  { id: 'D', deps: ['B', 'C'], durationMs: 50 },
];
const rd = analyzeRun(diamond);
check('8.2 diamond kind=ok', rd.kind === 'ok', rd.kind, 'ok');
if (rd.kind === 'ok') {
  check('8.2 diamond totalMs', rd.totalMs === 650, rd.totalMs, 650);
  check('8.2 diamond criticalMs', rd.criticalMs === 450, rd.criticalMs, 450);
  check('8.2 diamond speedup close', Math.abs(rd.speedup - 650/450) < 1e-10, rd.speedup, 650/450);
}

// 8.3 parallel
const parallel: RunNode[] = [
  { id: 'A', deps: [], durationMs: 100 },
  { id: 'B', deps: [], durationMs: 100 },
  { id: 'C', deps: [], durationMs: 100 },
];
check('8.3 parallel', eq(analyzeRun(parallel), { kind: 'ok', totalMs: 300, criticalMs: 100, speedup: 3 }), analyzeRun(parallel), { kind: 'ok', totalMs: 300, criticalMs: 100, speedup: 3 });

// 8.4 missingThirtyPercent
const missingThirtyPercent: RunNode[] = [
  { id: 'N1', deps: [], durationMs: null },
  { id: 'N2', deps: [], durationMs: null },
  { id: 'N3', deps: [], durationMs: null },
  { id: 'N4', deps: [], durationMs: 100 },
  { id: 'N5', deps: [], durationMs: 100 },
  { id: 'N6', deps: [], durationMs: 100 },
  { id: 'N7', deps: [], durationMs: 100 },
  { id: 'N8', deps: [], durationMs: 100 },
  { id: 'N9', deps: [], durationMs: 100 },
  { id: 'N10', deps: [], durationMs: 100 },
];
check('8.4 missing 30%', eq(analyzeRun(missingThirtyPercent), { kind: 'excluded-missing', missingRatio: 0.3 }), analyzeRun(missingThirtyPercent), { kind: 'excluded-missing', missingRatio: 0.3 });

// 8.5 cycle
const cycle: RunNode[] = [
  { id: 'A', deps: ['B'], durationMs: 100 },
  { id: 'B', deps: ['A'], durationMs: 200 },
];
check('8.5 cycle', eq(analyzeRun(cycle), { kind: 'invalid-cycle' }), analyzeRun(cycle), { kind: 'invalid-cycle' });

// 8.6 shape tri-state
check('8.6 absent null', shapeBucket(null), shapeBucket(null), 'absent');
check('8.6 absent undefined', shapeBucket(undefined), shapeBucket(undefined), 'absent');
check('8.6 absent empty', shapeBucket(''), shapeBucket(''), 'absent');
check('8.6 known', shapeBucket('one-decision-then-fanout'), shapeBucket('one-decision-then-fanout'), 'known');
check('8.6 unknown fake', shapeBucket('not-a-real-shape'), shapeBucket('not-a-real-shape'), 'unknown');
check('8.6 unknown whitespace', shapeBucket('   '), shapeBucket('   '), 'unknown');

// 8.7 median odd/even
check('8.7 median odd', median([1, 3, 2]), median([1, 3, 2]), 2);
check('8.7 median even', median([1, 4, 2, 3]), median([1, 4, 2, 3]), 2.5);

// extras: NULL pass-through (deps valid, duration null) + ratio=0.20 boundary
const passThrough: RunNode[] = [
  { id: 'A', deps: [], durationMs: 100 },
  { id: 'B', deps: ['A'], durationMs: null },  // pass-through
  { id: 'C', deps: ['B'], durationMs: 300 },
];
// ratio = 1/3 < 0.20 → falls through, deps all present → ok
// totalMs = 100 + 300 = 400 (B's null NOT counted)
// criticalMs = 100 + 0 + 300 = 400 (B adds 0 to path)
// speedup = 1
const rpt = analyzeRun(passThrough);
check('pass-through kind ok', rpt.kind === 'ok', rpt.kind, 'ok');
if (rpt.kind === 'ok') {
  check('pass-through totalMs', rpt.totalMs === 400, rpt.totalMs, 400);
  check('pass-through criticalMs', rpt.criticalMs === 400, rpt.criticalMs, 400);
  check('pass-through speedup', rpt.speedup === 1, rpt.speedup, 1);
}

// ratio exactly 0.20 → not excluded (exactly 0.20 falls through)
const ratio20: RunNode[] = [
  { id: 'A', deps: [], durationMs: null },
  { id: 'B', deps: [], durationMs: null },
  { id: 'A2', deps: [], durationMs: 100 },
  { id: 'B2', deps: [], durationMs: 100 },
  { id: 'A3', deps: [], durationMs: 100 },
  { id: 'B3', deps: [], durationMs: 100 },
  { id: 'A4', deps: [], durationMs: 100 },
  { id: 'B4', deps: [], durationMs: 100 },
  { id: 'A5', deps: [], durationMs: 100 },
  { id: 'B5', deps: [], durationMs: 100 },
];
// 2/10 = 0.2; deps all present
const r20 = analyzeRun(ratio20);
check('ratio=0.20 not excluded', r20.kind === 'ok', r20.kind, 'ok');
if (r20.kind === 'ok') {
  // totalMs = 800 (10 nodes × 100 each minus 2 nulls), criticalMs = 100, speedup = 8
  check('ratio=0.20 totalMs', r20.totalMs === 800, r20.totalMs, 800);
  check('ratio=0.20 criticalMs', r20.criticalMs === 100, r20.criticalMs, 100);
  check('ratio=0.20 speedup', r20.speedup === 8, r20.speedup, 8);
}

// deps null with small ratio → invalid-shape
const depsNullSmall: RunNode[] = [
  { id: 'A', deps: null, durationMs: 100 },
  { id: 'B', deps: [], durationMs: 100 },
  { id: 'C', deps: [], durationMs: 100 },
  { id: 'D', deps: [], durationMs: 100 },
  { id: 'E', deps: [], durationMs: 100 },
];
// missingCount = 1, ratio = 1/5 = 0.2 → not excluded, then deps null → invalid-shape
check('deps null small ratio → invalid-shape', analyzeRun(depsNullSmall), analyzeRun(depsNullSmall), { kind: 'invalid-shape' });

// empty → invalid-shape
check('empty → invalid-shape', analyzeRun([]), analyzeRun([]), { kind: 'invalid-shape' });

// duplicate id → invalid-shape
const dup: RunNode[] = [
  { id: 'A', deps: [], durationMs: 100 },
  { id: 'A', deps: [], durationMs: 100 },
];
check('duplicate id → invalid-shape', analyzeRun(dup), analyzeRun(dup), { kind: 'invalid-shape' });

// dangling dep → invalid-shape
const dangling: RunNode[] = [
  { id: 'A', deps: ['Z'], durationMs: 100 },
];
check('dangling dep → invalid-shape', analyzeRun(dangling), analyzeRun(dangling), { kind: 'invalid-shape' });

// self-loop A → A → invalid-cycle
const selfLoop: RunNode[] = [
  { id: 'A', deps: ['A'], durationMs: 100 },
];
check('self-loop → invalid-cycle', analyzeRun(selfLoop), analyzeRun(selfLoop), { kind: 'invalid-cycle' });

// criticalMs == 0 (all durations null, deps valid, ratio small) → invalid-shape
const allNullDur: RunNode[] = [
  { id: 'A', deps: [], durationMs: null },
  { id: 'B', deps: [], durationMs: null },
  { id: 'C', deps: [], durationMs: null },
  { id: 'D', deps: [], durationMs: null },
  { id: 'E', deps: [], durationMs: null },
  { id: 'F', deps: [], durationMs: null },
  { id: 'G', deps: [], durationMs: null },
  { id: 'H', deps: [], durationMs: null },
  { id: 'I', deps: [], durationMs: null },
  { id: 'J', deps: [], durationMs: 100 }, // 1/10 = 0.1 not excluded
];
const rall = analyzeRun(allNullDur);
check('all-null-dur small ratio → invalid-shape (criticalMs=0)', rall.kind === 'invalid-shape', rall.kind, 'invalid-shape');

// parseNodesColumn cases
check('parse string', parseNodesColumn('[{"id":"A","deps":[],"durationMs":100}]')?.length, parseNodesColumn('[{"id":"A","deps":[],"durationMs":100}]')?.length, 1);
check('parse array', parseNodesColumn([{ id: 'A', deps: [], durationMs: 100 }])?.length, parseNodesColumn([{ id: 'A', deps: [], durationMs: 100 }])?.length, 1);
check('parse bad JSON → null', parseNodesColumn('not-json'), parseNodesColumn('not-json'), null);
check('parse non-array → null', parseNodesColumn(123), parseNodesColumn(123), null);
check('parse null → null', parseNodesColumn(null), parseNodesColumn(null), null);
check('parse non-object item → null', parseNodesColumn([null]), parseNodesColumn([null]), null);
check('parse empty id → null', parseNodesColumn([{ id: '', deps: [], durationMs: 1 }]), parseNodesColumn([{ id: '', deps: [], durationMs: 1 }]), null);
check('parse non-string id → null', parseNodesColumn([{ id: 1, deps: [], durationMs: 1 }]), parseNodesColumn([{ id: 1, deps: [], durationMs: 1 }]), null);
check('parse negative duration → null', parseNodesColumn([{ id: 'A', deps: [], durationMs: -1 }]), parseNodesColumn([{ id: 'A', deps: [], durationMs: -1 }]), null);
check('parse NaN duration → null field, not whole row', JSON.stringify(parseNodesColumn([{ id: 'A', deps: [], durationMs: Number.NaN }])), JSON.stringify(parseNodesColumn([{ id: 'A', deps: [], durationMs: Number.NaN }])), JSON.stringify([{ id: 'A', deps: [], durationMs: null }]));
check('parse Infinity duration → null field', JSON.stringify(parseNodesColumn([{ id: 'A', deps: [], durationMs: Infinity }])), JSON.stringify(parseNodesColumn([{ id: 'A', deps: [], durationMs: Infinity }])), JSON.stringify([{ id: 'A', deps: [], durationMs: null }]));
check('parse missing deps → null deps', JSON.stringify(parseNodesColumn([{ id: 'A', durationMs: 100 }])), JSON.stringify(parseNodesColumn([{ id: 'A', durationMs: 100 }])), JSON.stringify([{ id: 'A', deps: null, durationMs: 100 }]));
check('parse deps non-array → null row', parseNodesColumn([{ id: 'A', deps: 'B', durationMs: 1 }]), parseNodesColumn([{ id: 'A', deps: 'B', durationMs: 1 }]), null);
check('parse deps non-string item → null row', parseNodesColumn([{ id: 'A', deps: [1], durationMs: 1 }]), parseNodesColumn([{ id: 'A', deps: [1], durationMs: 1 }]), null);

// median edge cases
check('median empty → NaN', Number.isNaN(median([])), Number.isNaN(median([])), true);
try { median([1, NaN]); console.log('✗ median NaN throw'); fail++; } catch (e) { if (e instanceof TypeError) { pass++; console.log('✓ median NaN throws TypeError'); } else { fail++; console.log('✗ median NaN wrong throw type'); } }
try { median([1, Infinity]); console.log('✗ median Inf throw'); fail++; } catch (e) { if (e instanceof TypeError) { pass++; console.log('✓ median Inf throws TypeError'); } else { fail++; console.log('✗ median Inf wrong throw type'); } }
// median does not mutate input
const arr = [3, 1, 2];
median(arr);
check('median does not mutate', eq(arr, [3, 1, 2]), arr, [3, 1, 2]);

// renderMarkdown structure
const sampleCounters: RunCounters = { excludedMissing: 1, invalidCycle: 2, invalidShape: 3 };
const sampleGroups: MarkdownGroup[] = [
  { label: 'absent', speedups: [1.5, 2.5, 3.0] },
  { label: 'known', speedups: [] },
  { label: 'known:full-stack', speedups: [4.0] },
  { label: 'unknown', speedups: [] },
];
const md = renderMarkdown('全量', sampleGroups, sampleCounters);
console.log('---renderMarkdown output---');
console.log(md);
console.log('---end---');
check('md starts with ##', md.startsWith('## 全量\n'), md.slice(0, 10), '## 全量\n');
check('md ends with single newline', md.endsWith('\n') && !md.endsWith('\n\n'), 'len=' + md.length, 'endsWith one \\n');
check('md has excludedMissing line', md.includes('excludedMissing: 1 / invalidCycle: 2 / invalidShape: 3'), null, null);
check('md empty group shows — and 0', md.includes('| known | — | 0 |'), null, null);
// label with pipe escaping
const esc = renderMarkdown('t', [{ label: 'a|b', speedups: [1] }], sampleCounters);
check('pipe escaped', esc.includes('a\\|b'), esc, null);

console.log(`\n=== ${pass} pass / ${fail} fail ===`);
if (fail > 0) process.exit(1);