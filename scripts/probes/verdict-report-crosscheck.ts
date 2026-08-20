/**
 * 报告数字 ↔ readings JSON 逐字核对 (反向自检: 故意改报告里任一数字 -> exit 1)。
 * 用法: bun run scripts/probes/verdict-report-crosscheck.ts
 */
import { readFileSync } from 'node:fs';

const R = 'scripts/probes/readings';
const report = readFileSync('scripts/probes/exec-fork-verdict-readings.md', 'utf8');
const j = (n: string) => JSON.parse(readFileSync(`${R}/${n}.json`, 'utf8'));
const ab = j('ab-probe'), base = j('baseline'), ctl = j('control'), trt = j('treatment');

const fails: string[] = [];
const must = (v: unknown, label: string) => {
  if (!report.includes(String(v))) fails.push(`报告缺 ${label} = ${String(v)}`);
};

for (const p of ab.paths) {
  must(p.wallclockMs, `ab ${p.pathId} wallclock`);
  must(p.tokensIn, `ab ${p.pathId} in`);
  must(p.tokensOut, `ab ${p.pathId} out`);
  must(p.cacheCreationInputTokensFirst, `ab ${p.pathId} cacheCreation`);
}
must(base.armWallclockMaxMs, 'baseline armMax');
must(base.path.tokensIn, 'baseline in');
must(base.path.tokensOut, 'baseline out');
must(base.path.cacheCreationInputTokensFirst, 'baseline cacheCreation');

for (const [arm, data] of [['control', ctl], ['treatment', trt]] as const) {
  must(data.armWallclockMaxMs, `${arm} armMax`);
  must(data.abort.cumulativeWallclockMs, `${arm} cumulative`);
  for (const d of data.distances) must(d, `${arm} distance`);
  for (const g of data.groups) {
    must(g.armWallclockMaxMs, `${arm} g${g.group} max`);
    must(g.pairDistance, `${arm} g${g.group} pairDistance`);
    for (const p of g.paths) {
      must(p.wallclockMs, `${arm} ${p.pathId} wallclock`);
      must(p.tokensIn, `${arm} ${p.pathId} in`);
      must(p.tokensOut, `${arm} ${p.pathId} out`);
      must(p.cacheCreationInputTokensFirst, `${arm} ${p.pathId} cacheCreation`);
    }
  }
}
must(trt.verdict.maxControl, 'verdict maxControl');
must(trt.verdict.minTreatment, 'verdict minTreatment');
must(trt.wallclockVsBaseline.diffMs, 'wallclockVsBaseline diffMs');
must(trt.controlVsTreatmentWallclock.diffMs, 'controlVsTreatment diffMs');

// null 三态: 不许把 null 写成数值形容词
for (const w of ['近零', '很低', '约 0', '接近 0', '几乎为 0', '大约']) {
  const hits = report.split('\n').filter((l) => l.includes(w) && !l.includes('禁止出现') && !l.includes('未出现'));
  if (hits.length) fails.push(`禁用措辞 "${w}": ${hits.length} 行`);
}

if (fails.length) {
  console.error(fails.join('\n'));
  process.exit(1);
}
console.log('crosscheck OK: 报告数字与 readings JSON 逐字一致, 无禁用措辞');
