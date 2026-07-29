/**
 * worker 质量语料 —— 量「量产座位 (leaf/agent/lens/expand/distill/…) 降到 thinking=low 之后活干得怎么样」。
 *
 * 为什么自己造一套而不是复用 fullstack/debug-planted:
 *   那两套跑一次是几十分钟, N=2 就到半天, 而档位差 (若有) 多半是几个百分点 —— **样本量不够就量不到**。
 *   这里每题一次单发 (无工具循环无 conductor), 秒级, 可以跑 N=5 甚至 10, 才谈得上信噪比。
 *
 * 选题原则: **每题都有确定性判据, 一个判官都不请**。判据分两量, 因为降档最可能坏在第二个上:
 *   score     答得对不对 (宽松抽答案: 允许模型在答案外说废话)
 *   formatOk  格式守没守 (严格: 说了只输出 JSON 就不能带前言; 说了恰好 3 行就不能给 4 行)
 * 量产座位的活恰恰是"被下游程序消费的产出", 格式破了下游直接崩 —— 分开记才看得出降档到底伤在哪。
 *
 * 覆盖面对着量产座位真在干的四类活: 写小段代码 · 从噪声里抽结构 · 按规则算数 · 守死格式。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface WorkerGrade {
  /** 0..1, 答案正确性 (宽松抽取, 不因啰嗦扣分)。 */
  score: number;
  /** 格式约束守住了没有 (无格式约束的题恒 true)。 */
  formatOk: boolean;
  /** 出错/判不了时的原因 (报告里看是"答错"还是"根本没答")。 */
  note?: string;
}

export interface WorkerTask {
  id: string;
  kind: 'code' | 'extract' | 'reason' | 'format';
  /** 这题考什么 (逐题读比总分有信息)。 */
  probes: string;
  prompt: string;
  grade: (output: string) => Promise<WorkerGrade> | WorkerGrade;
}

// ── 抽取工具 ────────────────────────────────────────────────────────────────

/** 取最长的围栏代码块; 没有围栏 → 原文 (模型直接给裸代码也算数)。 */
export function extractCode(text: string): string {
  const blocks = [...text.matchAll(/```(?:ts|typescript|js|javascript)?\s*\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
  return blocks.length ? blocks.sort((a, b) => b.length - a.length)[0]! : text;
}

/** 取最后一个 JSON 对象/数组 (模型爱在 JSON 前后加话)。取不到 → null。 */
export function extractJson(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
  const candidates = [...fenced, text];
  for (const c of candidates.reverse()) {
    const start = Math.min(...[c.indexOf('{'), c.indexOf('[')].filter((i) => i >= 0), Number.MAX_SAFE_INTEGER);
    if (start === Number.MAX_SAFE_INTEGER) continue;
    const end = Math.max(c.lastIndexOf('}'), c.lastIndexOf(']'));
    if (end <= start) continue;
    try {
      return JSON.parse(c.slice(start, end + 1));
    } catch {
      /* 下一个候选 */
    }
  }
  return null;
}

/** 取最后一个数 (含负号/小数)。取不到 → null。 */
export function lastNumber(text: string): number | null {
  const m = [...text.matchAll(/-?\d+(?:\.\d+)?/g)];
  return m.length ? Number(m[m.length - 1]![0]) : null;
}

/**
 * 在**独立子进程**里跑生成的代码 (模型产物, 不进本进程): 写 sol.ts + 判题 harness, `bun run`,
 * 数 `OK`/`NG`。超时/编译错/抛错一律 0 分 —— "跑不起来"和"答错"对下游是同一件事。
 */
export async function runCodeCases(
  code: string,
  entry: string,
  cases: { args: unknown[]; expect: unknown }[],
  timeoutMs = 20_000,
): Promise<WorkerGrade> {
  const dir = mkdtempSync(join(tmpdir(), 'omd-wq-'));
  try {
    writeFileSync(join(dir, 'sol.ts'), code, 'utf-8');
    writeFileSync(
      join(dir, 'run.ts'),
      [
        `import * as sol from './sol.ts';`,
        `const fn = (sol as Record<string, unknown>)['${entry}'] ?? (sol as { default?: unknown }).default;`,
        `if (typeof fn !== 'function') { console.log('NOFN'); process.exit(0); }`,
        `const cases = ${JSON.stringify(cases)};`,
        `for (const c of cases) {`,
        `  try {`,
        `    const got = await (fn as (...a: unknown[]) => unknown)(...c.args);`,
        `    console.log(JSON.stringify(got) === JSON.stringify(c.expect) ? 'OK' : 'NG');`,
        `  } catch { console.log('NG'); }`,
        `}`,
      ].join('\n'),
      'utf-8',
    );
    const proc = Bun.spawn(['bun', 'run', join(dir, 'run.ts')], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(timer);
    if (out.includes('NOFN')) return { score: 0, formatOk: false, note: `未导出 ${entry}` };
    const ok = (out.match(/^OK$/gm) ?? []).length;
    const ng = (out.match(/^NG$/gm) ?? []).length;
    if (ok + ng === 0) return { score: 0, formatOk: false, note: '代码跑不起来 (编译错/无输出)' };
    return { score: ok / cases.length, formatOk: ok + ng === cases.length };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 题库 ────────────────────────────────────────────────────────────────────

const CODE_RULE = '只输出一个 TypeScript 代码块, 不要解释。用 `export function` 导出, 不要用任何依赖。';

export const WORKER_TASKS: readonly WorkerTask[] = [
  {
    id: 'code-duration',
    kind: 'code',
    probes: '写小段纯函数 + 边界 (零值 / 缺单位 / 乱序单位)',
    prompt: `实现 \`export function parseDuration(s: string): number\` —— 把 "1h30m" 这类时长串转成**秒**。
支持单位 d/h/m/s, 可任意组合与顺序 (如 "45s", "2m10s", "1d2h"), 数字为非负整数。
无法解析 (空串 / 含非法字符 / 无单位) 返回 -1。
${CODE_RULE}`,
    grade: (out) =>
      runCodeCases(extractCode(out), 'parseDuration', [
        { args: ['1h30m'], expect: 5400 },
        { args: ['45s'], expect: 45 },
        { args: ['2m10s'], expect: 130 },
        { args: ['1d2h'], expect: 93600 },
        { args: ['0s'], expect: 0 },
        { args: [''], expect: -1 },
        { args: ['abc'], expect: -1 },
        { args: ['10'], expect: -1 },
      ]),
  },
  {
    id: 'code-merge-intervals',
    kind: 'code',
    probes: '经典算法 + 相邻不重叠边界 (最容易在 low 档手滑的地方)',
    prompt: `实现 \`export function mergeIntervals(xs: [number, number][]): [number, number][]\` ——
合并重叠区间, 结果按左端点升序。**相接但不重叠**的区间 (如 [1,2] 与 [2,3]) 视为重叠, 要合并。
空数组返回空数组。
${CODE_RULE}`,
    grade: (out) =>
      runCodeCases(extractCode(out), 'mergeIntervals', [
        { args: [[[1, 3], [2, 6], [8, 10], [15, 18]]], expect: [[1, 6], [8, 10], [15, 18]] },
        { args: [[[1, 2], [2, 3]]], expect: [[1, 3]] },
        { args: [[[5, 6], [1, 2]]], expect: [[1, 2], [5, 6]] },
        { args: [[]], expect: [] },
        { args: [[[1, 10], [2, 3]]], expect: [[1, 10]] },
      ]),
  },
  {
    id: 'code-topo',
    kind: 'code',
    probes: '有环检测 —— "遇到环返回 null"这条最容易被无视',
    prompt: `实现 \`export function topoSort(deps: Record<string, string[]>): string[] | null\` ——
\`deps[x]\` 是 x 依赖的节点数组。返回一个合法拓扑序 (依赖在前); **有环返回 null**。
同层节点按字典序输出, 保证结果唯一。
${CODE_RULE}`,
    grade: (out) =>
      runCodeCases(extractCode(out), 'topoSort', [
        { args: [{ a: [], b: ['a'], c: ['b'] }], expect: ['a', 'b', 'c'] },
        { args: [{ a: [], b: [], c: ['a', 'b'] }], expect: ['a', 'b', 'c'] },
        { args: [{ a: ['b'], b: ['a'] }], expect: null },
        { args: [{}], expect: [] },
      ]),
  },
  {
    id: 'code-csv-line',
    kind: 'code',
    probes: '状态机解析 (引号内逗号 / 双写转义) —— low 档最常给出"split(,)"级别的答案',
    prompt: `实现 \`export function parseCsvLine(line: string): string[]\` —— 解析一行 CSV。
规则: 逗号分隔; 字段可用双引号包裹, 包裹时其中的逗号不分隔; 引号内的 \`""\` 表示一个字面双引号;
不做首尾空白裁剪。空串返回 \`[""]\`。
${CODE_RULE}`,
    grade: (out) =>
      runCodeCases(extractCode(out), 'parseCsvLine', [
        { args: ['a,b,c'], expect: ['a', 'b', 'c'] },
        { args: ['a,"b,c",d'], expect: ['a', 'b,c', 'd'] },
        { args: ['"he said ""hi""",x'], expect: ['he said "hi"', 'x'] },
        { args: ['a,,c'], expect: ['a', '', 'c'] },
        { args: [''], expect: [''] },
      ]),
  },
  {
    id: 'extract-errors',
    kind: 'extract',
    probes: '从噪声日志里抽结构 —— 量产座位最高频的活, 且下游按 JSON 消费',
    prompt: `下面是一段服务日志。抽出所有**唯一**的 HTTP 状态码 (只要 4xx/5xx), 升序排列。
只输出一个 JSON 数组, 不要任何解释文字、不要代码围栏以外的内容。

\`\`\`
12:00:01 GET /api/users 200 12ms
12:00:03 POST /api/login 401 31ms
12:00:04 GET /api/users/7 404 8ms
12:00:07 POST /api/login 401 28ms
12:00:09 GET /health 200 1ms
12:00:11 POST /api/orders 500 220ms
12:00:14 GET /api/orders/3 403 9ms
12:00:15 GET /static/logo.png 304 2ms
12:00:19 POST /api/orders 500 198ms
12:00:22 DELETE /api/users/7 405 5ms
\`\`\``,
    grade: (out) => {
      const got = extractJson(out);
      const want = [401, 403, 404, 405, 500];
      const ok = Array.isArray(got) && JSON.stringify(got.map(Number)) === JSON.stringify(want);
      // 格式严格档: 除 JSON (可含围栏) 外不得有正文。
      const stripped = out.replace(/```(?:json)?/g, '').trim();
      return { score: ok ? 1 : 0, formatOk: /^\[[\s\S]*\]$/.test(stripped), ...(ok ? {} : { note: JSON.stringify(got)?.slice(0, 80) }) };
    },
  },
  {
    id: 'extract-fields',
    kind: 'extract',
    probes: '按 schema 抽字段 + 缺失字段必须给 null (不许编)',
    prompt: `从下面这段报修工单里抽出结构化字段, 只输出一个 JSON 对象, 键固定为
\`{"device":..., "roomNo":..., "reporter":..., "phone":..., "urgent":...}\`。
原文没写的字段填 null (**不要推测**)。urgent 是布尔。不要任何解释文字。

工单原文:
「3 号楼 402 的中央空调从昨晚开始不制冷了, 会议室今天下午有客户来, 麻烦尽快。报修人: 王芳。」`,
    grade: (out) => {
      const got = extractJson(out) as Record<string, unknown> | null;
      if (!got || typeof got !== 'object') return { score: 0, formatOk: false, note: '没给出 JSON' };
      const keys = ['device', 'roomNo', 'reporter', 'phone', 'urgent'];
      const hasAll = keys.every((k) => k in got);
      let hit = 0;
      if (String(got.device ?? '').includes('空调')) hit++;
      if (String(got.roomNo ?? '').includes('402')) hit++;
      if (String(got.reporter ?? '') === '王芳') hit++;
      if (got.phone === null) hit++; // 原文没有电话 —— 编一个出来就是这题的失分点
      if (got.urgent === true) hit++;
      const stripped = out.replace(/```(?:json)?/g, '').trim();
      return { score: hit / 5, formatOk: hasAll && /^\{[\s\S]*\}$/.test(stripped) };
    },
  },
  {
    id: 'reason-pricing',
    kind: 'reason',
    probes: '多条规则叠加求值 —— 规则次序错一步答案就错, 但没有工具可依赖',
    prompt: `按下面的规则算一次订单总价, **只输出最终数字**(单位元, 保留两位小数), 不要过程。

规则 (按顺序应用):
1. 单价 ¥89, 数量 24 件。
2. 数量 ≥ 20 件, 单价打 9 折。
3. 折后小计满 ¥1500, 再减 ¥120。
4. 在以上结果上加 6% 服务费。
5. 服务费后金额四舍五入到分。`,
    grade: (out) => {
      // 89*0.9=80.1 → *24=1922.4 → -120=1802.4 → *1.06=1910.544 → 1910.54
      const n = lastNumber(out);
      const ok = n !== null && Math.abs(n - 1910.54) < 0.005;
      return { score: ok ? 1 : 0, formatOk: /^[^a-zA-Z一-龥]*$/.test(out.trim()), ...(ok ? {} : { note: `得 ${n}` }) };
    },
  },
  {
    id: 'reason-parallel',
    kind: 'reason',
    probes: '按依赖算首层可并行集合 —— 就是引擎自己在做的事, 量产座位最该会',
    prompt: `任务依赖如下 (箭头右边依赖左边):
A → C, B → C, C → E, D → E, F 无依赖。
问: **第一层可以并行开工**的任务有哪些? 只输出这些任务的字母, 逗号分隔, 按字母升序, 不要解释。`,
    grade: (out) => {
      const letters = [...new Set((out.toUpperCase().match(/\b[A-F]\b/g) ?? []))].sort();
      const ok = JSON.stringify(letters) === JSON.stringify(['A', 'B', 'D', 'F']);
      return { score: ok ? 1 : 0, formatOk: out.trim().length <= 20, ...(ok ? {} : { note: letters.join('') }) };
    },
  },
  {
    id: 'format-exactly-3',
    kind: 'format',
    probes: '硬格式约束 (恰好 3 行 / 每行 ≤ 30 字 / 不许出现某些词) —— 下游按行切的那类产出',
    prompt: `用**恰好 3 行**概括"为什么要给 CLI 加 --json 开关", 每行不超过 30 个字符, 每行以 "- " 开头。
不要标题、不要空行、不要任何额外文字。这三行里**不得出现**「用户」「体验」这两个词。`,
    grade: (out) => {
      const lines = out.trim().split('\n').map((l) => l.trim()).filter(Boolean);
      const three = lines.length === 3;
      const dashed = lines.every((l) => l.startsWith('- '));
      const short = lines.every((l) => l.length <= 30);
      const clean = !/用户|体验/.test(lines.join(''));
      const hits = [three, dashed, short, clean].filter(Boolean).length;
      return { score: hits / 4, formatOk: three && dashed && short && clean };
    },
  },
  {
    id: 'format-json-only',
    kind: 'format',
    probes: '"只输出 JSON"的服从度 —— 加一句前言, 下游 JSON.parse 就炸',
    prompt: `把这三条配置项转成 JSON 数组, 每项 \`{"key":..., "value":..., "type":...}\`,
type 取 "string"|"number"|"boolean"。**只输出 JSON, 前后不要任何文字, 不要代码围栏。**

retries = 3
verbose = true
endpoint = https://api.example.com`,
    grade: (out) => {
      const raw = out.trim();
      const noFence = !raw.includes('```');
      const parsed = (() => {
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          return null;
        }
      })();
      const got = parsed ?? extractJson(out);
      const arr = Array.isArray(got) ? (got as Record<string, unknown>[]) : [];
      const want = [
        { key: 'retries', value: 3, type: 'number' },
        { key: 'verbose', value: true, type: 'boolean' },
        { key: 'endpoint', value: 'https://api.example.com', type: 'string' },
      ];
      const hit = want.filter((w) => arr.some((a) => a.key === w.key && a.value === w.value && a.type === w.type)).length;
      return { score: hit / want.length, formatOk: noFence && parsed !== null };
    },
  },
];
