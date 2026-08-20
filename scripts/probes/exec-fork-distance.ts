#!/usr/bin/env bun
/**
 * exec-fork-distance —— dist(x,y) 计算器,按 execute::3tliwmwch7vbj 契约 §4 冻结的定义。
 * 零模型调用,纯字符串归一 + Levenshtein。给 exec-fork-verdict 的 c/d 信号(control/treatment
 * distances)提供确定性、可重跑的实现,不重新发明归一步骤或阈值。
 *
 * ## 这条度量怎么被证伪(动手前写死,不是事后补)
 *
 *   ① **同一文本 -> dist 必须 = 0。** 喂两份逐字节相同的 diff(哪怕带尾部空白/CRLF 差异,
 *      因为 normalize 会吃掉这些),Levenshtein(A,A)=0 -> dist=0。若跑出非 0,归一或距离
 *      实现有 bug —— 这是最基本的可证伪条件,见 `runSelfTest()` 用例 1。
 *   ② **完全不相交的 token 集合 -> dist 必须接近上界(不小于一个高阈值,如 >=0.8)。**
 *      两份长度相近、token 完全不重叠的文本,edit distance 应逼近 max(len(A),len(B)),
 *      归一后逼近 1。若跑出远小于 0.8 的值,说明归一步骤把不该等同的行谁给等同了
 *      (例如把 diff hunk 头当噪声丢了)。见 `runSelfTest()` 用例 2。
 *   ③ **上界钉死为 1。** dist = L / max(len(A), len(B), 1),分母恒 >= 分子(insert/delete
 *      把一条序列变成另一条最多需要 max(lenA,lenB) 步),所以 dist 永远落在 [0,1] 闭区间,
 *      不会溢出。`runSelfTest()` 用例 3 断言这一点在退化输入(空串)上也成立。
 *
 * 跑法:
 *   bun run scripts/probes/exec-fork-distance.ts --self-test
 *     只跑上面三条自证用例,不碰 readings 目录,退出码非 0 = 证伪成功(度量本身有洞)。
 *
 *   bun run scripts/probes/exec-fork-distance.ts --readings-dir <dir>
 *     读 <dir> 下 control.json / treatment.json(execute::3tliwmwch7vbj §5 schema 的
 *     ArmReading[]),对每个 arm 内的所有 diff 两两算 dist,打印:
 *       - 每个 pair 的 dist
 *       - arm 内分布统计:n / min / median / max
 *     不写 verdict、不判 separable —— 那是下游 exec-fork-verdict 的事,本脚本只出距离。
 *
 *   bun run scripts/probes/exec-fork-distance.ts --diff a.diff b.diff
 *     直接给两个 diff 文件路径,打印单个 dist(x,y)。debug 用。
 */

// ---------- §4 归一 + 距离(契约冻结,不得改动步骤顺序) ----------

/**
 * normalize(text):
 *   1. \r\n -> \n
 *   2. 按行 split
 *   3. 每行去尾部空白
 *   4. 丢弃空行
 *   5. 每行按 /\s+/ split 成 token,再扁平化
 *   6. 保留大小写与标点
 * 返回值是扁平 token 数组(Levenshtein 的操作单位是 token,不是字符)。
 */
export function normalize(text: string): string[] {
  const unified = text.replace(/\r\n/g, "\n");
  const lines = unified.split("\n");
  const tokens: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    if (line.length === 0) continue;
    for (const tok of line.split(/\s+/)) {
      if (tok.length > 0) tokens.push(tok);
    }
  }
  return tokens;
}

/** Levenshtein edit distance over token arrays; insert/delete/substitute each cost 1. */
export function levenshtein(a: string[], b: string[]): number {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  // rolling two-row DP, O(n*m) time, O(m) space
  let prev = new Array<number>(m + 1);
  let curr = new Array<number>(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1, // delete
        (curr[j - 1] ?? 0) + 1, // insert
        (prev[j - 1] ?? 0) + cost, // substitute
      );
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[m] ?? 0;
}

/** dist(x,y) = L / max(len(A), len(B), 1), range [0,1]. */
export function dist(x: string, y: string): number {
  const A = normalize(x);
  const B = normalize(y);
  const L = levenshtein(A, B);
  const denom = Math.max(A.length, B.length, 1);
  return L / denom;
}

// ---------- 分布统计 ----------

interface DistStats {
  n: number;
  min: number | null;
  median: number | null;
  max: number | null;
}

function computeStats(values: number[]): DistStats {
  if (values.length === 0) return { n: 0, min: null, median: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  const median =
    n % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
  return { n, min: sorted[0] ?? null, median, max: sorted[n - 1] ?? null };
}

function pairwiseDistances(texts: string[]): { i: number; j: number; d: number }[] {
  const out: { i: number; j: number; d: number }[] = [];
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      out.push({ i, j, d: dist(texts[i] ?? "", texts[j] ?? "") });
    }
  }
  return out;
}

// ---------- 自证(可证伪三用例) ----------

function runSelfTest(): number {
  let failures = 0;

  // 用例 ①: 同一文本 -> dist = 0(含 CRLF/尾部空白差异,normalize 应吃掉)
  const same = "diff --git a/x b/x\n+line one  \n+line two\n";
  const sameCrlf = same.replace(/\n/g, "\r\n");
  const d1 = dist(same, sameCrlf);
  if (d1 !== 0) {
    console.error(`[FAIL] 用例①同一文本: 期望 dist=0, 实得 ${d1}`);
    failures++;
  } else {
    console.log("[PASS] 用例①同一文本 -> dist=0");
  }

  // 用例 ②: 完全不相交的 token 集合 -> dist 逼近上界(>=0.8)
  const x = Array.from({ length: 20 }, (_, i) => `alpha_${i}`).join(" ");
  const y = Array.from({ length: 20 }, (_, i) => `zeta_${i}`).join(" ");
  const d2 = dist(x, y);
  if (d2 < 0.8) {
    console.error(`[FAIL] 用例②不相交集合: 期望 dist>=0.8, 实得 ${d2}`);
    failures++;
  } else {
    console.log(`[PASS] 用例②不相交集合 -> dist=${d2} (>=0.8)`);
  }

  // 用例 ③: 上界钉死为 1,含退化输入(空串)
  const d3empty = dist("", "");
  if (d3empty !== 0) {
    console.error(`[FAIL] 用例③空-空: 期望 dist=0, 实得 ${d3empty}`);
    failures++;
  } else {
    console.log("[PASS] 用例③空-空 -> dist=0");
  }
  const d3oneEmpty = dist("", "some content here\n");
  if (d3oneEmpty < 0 || d3oneEmpty > 1) {
    console.error(`[FAIL] 用例③空-非空越界: 实得 ${d3oneEmpty}`);
    failures++;
  } else {
    console.log(`[PASS] 用例③空-非空落在 [0,1] -> dist=${d3oneEmpty}`);
  }
  // 上界探针: 大量互不相同 token 时 dist 不应超过 1
  const big1 = Array.from({ length: 500 }, (_, i) => `t${i}`).join(" ");
  const big2 = Array.from({ length: 500 }, (_, i) => `u${i}`).join(" ");
  const d3big = dist(big1, big2);
  if (d3big > 1) {
    console.error(`[FAIL] 用例③上界越界: 实得 ${d3big} > 1`);
    failures++;
  } else {
    console.log(`[PASS] 用例③大规模不相交 -> dist=${d3big} <= 1`);
  }

  if (failures > 0) {
    console.error(`\n自证失败: ${failures} 条用例未过。度量实现有洞,先修再用。`);
    return 1;
  }
  console.log("\n全部自证用例通过。");
  return 0;
}

// ---------- readings 消费(执行契约 §5 schema) ----------

interface PathReadingLike {
  pathId: string;
  entry: string;
  // diff 文本从哪来: 契约未指定字段名,兼容两种常见落地方式。
  diffText?: string | null;
  diffFile?: string | null;
  outputDiff?: string | null;
}

interface GroupReadingLike {
  group: number;
  paths: [PathReadingLike, PathReadingLike];
  pairDistance?: number | null;
}

interface ArmReadingLike {
  arm: string;
  entry: string;
  groups?: GroupReadingLike[];
}

async function resolveDiffText(p: PathReadingLike, readingsDir: string): Promise<string | null> {
  if (typeof p.diffText === "string") return p.diffText;
  if (typeof p.outputDiff === "string") return p.outputDiff;
  if (typeof p.diffFile === "string" && p.diffFile.length > 0) {
    const path = p.diffFile.startsWith("/") ? p.diffFile : `${readingsDir}/${p.diffFile}`;
    const file = Bun.file(path);
    if (await file.exists()) return await file.text();
    console.error(`[WARN] diffFile 不存在: ${path} (pathId=${p.pathId})`);
    return null;
  }
  return null;
}

async function runOnReadings(readingsDir: string): Promise<number> {
  const armFiles = ["control.json", "treatment.json"];
  let exitCode = 0;

  for (const fname of armFiles) {
    const path = `${readingsDir}/${fname}`;
    const file = Bun.file(path);
    if (!(await file.exists())) {
      console.error(`[SKIP] 找不到 ${path}`);
      continue;
    }
    const arm: ArmReadingLike = await file.json();
    console.log(`\n=== arm: ${arm.arm} (entry=${arm.entry}) ===`);
    if (arm.entry === "not_run" || arm.entry === "na") {
      console.log("  该 arm 未跑或不适用,跳过。");
      continue;
    }
    if (!arm.groups || arm.groups.length === 0) {
      console.log("  无 groups,跳过。");
      continue;
    }

    // 组内两两距离(每组 2 路,恰好 1 对 = 契约的 pairDistance)
    const groupDistances: number[] = [];
    for (const g of arm.groups) {
      const [p0, p1] = g.paths;
      const t0 = await resolveDiffText(p0, readingsDir);
      const t1 = await resolveDiffText(p1, readingsDir);
      if (t0 === null || t1 === null) {
        console.log(`  group ${g.group}: 缺 diff 文本 (pathId=${p0.pathId}/${p1.pathId}), 跳过`);
        continue;
      }
      const d = dist(t0, t1);
      groupDistances.push(d);
      const declared = g.pairDistance;
      const mismatchNote =
        typeof declared === "number" && Math.abs(declared - d) > 1e-9
          ? ` (⚠ readings 中已记录 pairDistance=${declared}, 与本次重算不同)`
          : "";
      console.log(`  group ${g.group}: dist(${p0.pathId}, ${p1.pathId}) = ${d}${mismatchNote}`);
    }

    const stats = computeStats(groupDistances);
    console.log(
      `  arm 内分布: n=${stats.n} min=${stats.min} median=${stats.median} max=${stats.max}`,
    );
  }

  return exitCode;
}

async function runOnFiles(fileA: string, fileB: string): Promise<number> {
  const a = await Bun.file(fileA).text();
  const b = await Bun.file(fileB).text();
  const d = dist(a, b);
  console.log(`dist(${fileA}, ${fileB}) = ${d}`);
  return 0;
}

// ---------- entrypoint ----------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--self-test")) {
    process.exit(runSelfTest());
  }

  const diffIdx = args.indexOf("--diff");
  if (diffIdx >= 0) {
    const fileA = args[diffIdx + 1];
    const fileB = args[diffIdx + 2];
    if (!fileA || !fileB) {
      console.error("用法: --diff <fileA> <fileB>");
      process.exit(1);
    }
    process.exit(await runOnFiles(fileA, fileB));
  }

  const dirIdx = args.indexOf("--readings-dir");
  const readingsDir: string =
    (dirIdx >= 0 ? args[dirIdx + 1] : undefined) ?? `${import.meta.dir}/readings`;

  process.exit(await runOnReadings(readingsDir));
}

if (import.meta.main) {
  main();
}
