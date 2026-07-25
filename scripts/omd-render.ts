#!/usr/bin/env bun
/**
 * scripts/omd-render —— render CLI 的薄壳: 参数解析 + 渲染全部逻辑在 src/harness/render/omd-render.ts。
 *
 * 契约: stdout 只打印产物绝对路径 (每行一个), 下游 attach_media 审查 leaf 按 leaf-media 的
 * MEDIA_REF_RE 正则拾取; 一切错误/日志走 stderr, 失败 exit 1 — stdout 不得有噪音。
 *
 * 用法:
 *   bun run scripts/omd-render.ts <file|url> [--out dir] [--viewport WxH]... [--hover sel] [--focus sel] [--frames [n]]
 */
import "../src/harness/script-bootstrap";
import {
	parseRenderArgs,
	renderTargets,
} from "../src/harness/render/omd-render";

try {
	const args = parseRenderArgs(process.argv.slice(2));
	const produced = await renderTargets(args);
	for (const p of produced) console.log(p);
} catch (err) {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
}
