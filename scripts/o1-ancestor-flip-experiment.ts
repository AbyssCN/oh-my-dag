#!/usr/bin/env bun
/**
 * 切片1 O-1 机理实测 (2026-08-10): 共享祖先节点文本变化 → 兄弟节点语义指纹是否被打翻。
 *
 * 单变量: 仅共享祖先 A 的 goal append 一段反馈文字, 其余节点逐字节不动。
 * 消费 src/harness/plan-passes/semantic-key.ts 的 merkleFingerprints / computeReuse ——
 * 与 engine.ts (:575 reuse、:719 fingerprint 上报) 同一代码路径, 纯函数零 IO。
 *
 * 临时实验脚本 (blame-scoped-node-retry 切片1), 不修改 src/**。
 *
 * 判据 (动手前写死):
 *   证实: C1 fp(A) 变化 ∧ C2 兄弟子树 B1/B2/C1/C2 全打翻 (自身字段零改动) ∧
 *         C3 无关分支 U/V 稳定 (隔离, 无过度失效) ∧ C4 复用层 A 子树全不复用而 U/V 仍复用。
 *   证伪: F1 fp(A) 变但任一兄弟节点 fp 不变 (未沿链传播);
 *         F2 fp(U)/fp(V) 也变 (打翻全图, 非"打翻兄弟");
 *         F3 fp(A) 自身不变 (goal 文本未入指纹 → D-21 对该变化整体不敏感);
 *         F4 复用层仍复用任一 A 子树节点 (指纹变但复用没被拦住)。
 */
import type { ConductorPlan } from "../src/harness/conductor-plan";
import type { LeafResult } from "../src/harness/dag/types";
import { merkleFingerprints, computeReuse } from "../src/harness/plan-passes/semantic-key";

const plan = (nodes: ConductorPlan["nodes"]): ConductorPlan => ({ name: "o1-exp", nodes });

// ── 图: 共享祖先 A, 兄弟子树 B1→B2 与 C1→C2, 无关分支 U→V ──────────────────
const baseNodes = {
	A: { goal: "调查用户流失原因" },
	B1: { goal: "分析流失用户画像", depends_on: ["A"] },
	B2: { goal: "汇总画像结论", depends_on: ["B1"] },
	C1: { goal: "分析流失时间分布", depends_on: ["A"] },
	C2: { goal: "汇总时间结论", depends_on: ["C1"] },
	U: { goal: "核对历史数据口径" },
	V: { goal: "产出口径说明", depends_on: ["U"] },
};
const base = plan(baseNodes);

// ── 单变量处理: 仅 A.goal append 一段反馈文字 ──────────────────────────────
const treated = plan({
	...baseNodes,
	A: { goal: baseNodes.A.goal + "\n[verifier 反馈] 用户明说主因是价格, 请重点核实价格敏感度。" },
});

// ── prior results: 全 done (供 computeReuse 匹配) ──────────────────────────
const done = (id: string): LeafResult => ({
	id,
	status: "done",
	kind: "inproc",
	output: `out-${id}`,
	deps: [],
	usage: { in: 1, out: 1 },
});
const priorResults: Record<string, LeafResult> = Object.fromEntries(
	Object.keys(baseNodes).map((id) => [id, done(id)]),
);

// ── 原始读数 ────────────────────────────────────────────────────────────────
const fpBase = merkleFingerprints(base);
const fpTreated = merkleFingerprints(treated);
const allIds = Object.keys(baseNodes);
const flipped = allIds.filter((id) => fpBase.get(id) !== fpTreated.get(id));
const stable = allIds.filter((id) => fpBase.get(id) === fpTreated.get(id));

console.log("=== 原始读数: 语义指纹 (36 进制) 前后对照, 唯一变化 = A.goal append ===");
for (const id of allIds) {
	const mark = fpBase.get(id) === fpTreated.get(id) ? "STABLE " : "FLIPPED";
	console.log(`${id.padEnd(3)} base=${String(fpBase.get(id)).padEnd(10)} treated=${String(fpTreated.get(id)).padEnd(10)} ${mark}`);
}
console.log(`\nflipped: [${flipped.join(", ")}]`);
console.log(`stable : [${stable.join(", ")}]`);

// ── 跨轮复用 (D-21 消费面) ──────────────────────────────────────────────────
const reuseBaseline = computeReuse(base, { plan: base, results: priorResults }); // 同图同文 → 全复用
const reuseTreated = computeReuse(treated, { plan: base, results: priorResults }); // 仅 A.goal 变

console.log("\n=== computeReuse (跨轮复用集, prior=base 全 done) ===");
console.log(`baseline (同图同文)    : reused=[${[...reuseBaseline.keys()].join(", ")}]  (${reuseBaseline.size}/7)`);
console.log(`treated  (仅 A.goal 变): reused=[${[...reuseTreated.keys()].join(", ")}]  (${reuseTreated.size}/7)`);

// ── 判据判定 (动手前写死, 此处只念表) ───────────────────────────────────────
const c1 = flipped.includes("A");
const c2 = ["B1", "B2", "C1", "C2"].every((id) => flipped.includes(id));
const c3 = ["U", "V"].every((id) => stable.includes(id));
const c4 =
	["B1", "B2", "C1", "C2"].every((id) => !reuseTreated.has(id)) &&
	["U", "V"].every((id) => reuseTreated.has(id));
const confirmed = c1 && c2 && c3 && c4;

console.log("\n=== 判据判定 ===");
console.log(`C1 fp(A) 变化                            : ${c1 ? "PASS" : "FAIL"}`);
console.log(`C2 兄弟子树 B1/B2/C1/C2 全打翻 (字段零动) : ${c2 ? "PASS" : "FAIL"}`);
console.log(`C3 无关分支 U/V 稳定 (隔离无过度失效)     : ${c3 ? "PASS" : "FAIL"}`);
console.log(`C4 复用层: A 子树全不复用, U/V 仍复用     : ${c4 ? "PASS" : "FAIL"}`);
console.log(
	`\n结论: ${confirmed
		? "证实 — 祖先文本变化打翻兄弟指纹 (D-3 机理性根因假设成立)"
		: "证伪 — 至少一条判据不满足, 整轮重跑另有原因 (D-3 需重议)"}`,
);
