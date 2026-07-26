/**
 * fullstack fixture —— **真正的大规模 DAG** 测试床 (2026-07-26 owner 指派)。
 *
 * 与 medium/large 的根本区别: 那两个是"照测试重建我们自己的模块" —— 全是纯 TS, 一条 tsc+test 闸
 * 就判完, 且**碰不到 UI 证据链**(引擎最独特的那条回路从来没被 eval 覆盖过)。
 *
 * 这个 fixture 是**绿地全栈**: 后端存储 + API 映射 + 前端渲染 + 真截图审查, 一次跑完覆盖
 *   ① 多节点扇出 (三个互相独立的实现面 → 必须 depends_on 同一份契约)
 *   ② 前后端跨簇并行 (契约冻结后两侧互不依赖 —— conductor 画对了才并得起来)
 *   ③ UI 证据链 (render command 打印图片路径 → attach_media 审查判真像素)
 *   ④ 二次审查升档 (第二层看图节点按 stamp 规则自动升强档多模态)
 *
 * oracle 仍然只认客观闸: whole-project tsc + 三份**预写测试**(契约, 不许改) + 截图存在且非空。
 * 三份测试覆盖 backend 不变量 / API 映射 / HTML 结构与转义 —— 分辨率远高于 medium 的"整体过挂"。
 *
 * ⚠ UI 证据链需要 omd-render, 而它住在**本仓**不在 fixture 里。command leaf 不进 bwrap jail
 * (只受 cwd + 白名单 + 超时约束), 所以 SPEC 里给绝对路径, 由 `bun run <abs>/scripts/omd-render.ts` 调。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createWorktreeFixture, type WorktreeFixture } from './worktree';

const APP = 'eval-app';

/** 预写测试 = 契约 (INV-3 钉 public API; fleet 不许改测试)。 */
const BOARD_TEST = `import { describe, expect, test } from 'bun:test';
import { createBoard } from './board';

describe('board store', () => {
  test('新建的板子是空的', () => {
    expect(createBoard().list()).toEqual([]);
  });

  test('add 回新任务且带 open 状态', () => {
    const b = createBoard();
    const t = b.add({ id: 't1', title: '写文档' });
    expect(t.status).toBe('open');
    expect(b.list().length).toBe(1);
  });

  test('重复 id 抛错 (不静默覆盖)', () => {
    const b = createBoard();
    b.add({ id: 't1', title: 'a' });
    expect(() => b.add({ id: 't1', title: 'b' })).toThrow();
  });

  test('空 title 抛错', () => {
    expect(() => createBoard().add({ id: 't1', title: '   ' })).toThrow();
  });

  test('complete 把状态翻成 done', () => {
    const b = createBoard();
    b.add({ id: 't1', title: 'a' });
    expect(b.complete('t1').status).toBe('done');
  });

  test('complete 幂等: 重复完成不抛错也不改变计数', () => {
    const b = createBoard();
    b.add({ id: 't1', title: 'a' });
    b.complete('t1');
    expect(b.complete('t1').status).toBe('done');
    expect(b.list().length).toBe(1);
  });

  test('complete 不存在的 id 抛错', () => {
    expect(() => createBoard().complete('nope')).toThrow();
  });

  test('list 按状态过滤', () => {
    const b = createBoard();
    b.add({ id: 't1', title: 'a' });
    b.add({ id: 't2', title: 'b' });
    b.complete('t1');
    expect(b.list('done').map((t) => t.id)).toEqual(['t1']);
    expect(b.list('open').map((t) => t.id)).toEqual(['t2']);
  });

  test('list 保插入序', () => {
    const b = createBoard();
    for (const id of ['a', 'b', 'c']) b.add({ id, title: id });
    expect(b.list().map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  test('list 返回副本 (外部改动不污染内部状态)', () => {
    const b = createBoard();
    b.add({ id: 't1', title: 'a' });
    b.list().pop();
    expect(b.list().length).toBe(1);
  });
});
`;

const API_TEST = `import { describe, expect, test } from 'bun:test';
import { createBoard } from './board';
import { handle } from './api';

const board = () => {
  const b = createBoard();
  b.add({ id: 't1', title: '写文档' });
  return b;
};

describe('api handler', () => {
  test('GET /tasks 回 200 + 列表', () => {
    const r = handle(board(), { method: 'GET', path: '/tasks' });
    expect(r.status).toBe(200);
    expect((r.body as { tasks: unknown[] }).tasks.length).toBe(1);
  });

  test('GET /tasks?status=done 过滤', () => {
    const r = handle(board(), { method: 'GET', path: '/tasks', query: { status: 'done' } });
    expect((r.body as { tasks: unknown[] }).tasks).toEqual([]);
  });

  test('POST /tasks 回 201', () => {
    const r = handle(board(), { method: 'POST', path: '/tasks', body: { id: 't2', title: 'x' } });
    expect(r.status).toBe(201);
  });

  test('POST /tasks 缺字段回 400 且带 error (不是 500)', () => {
    const r = handle(board(), { method: 'POST', path: '/tasks', body: { id: 't2' } });
    expect(r.status).toBe(400);
    expect((r.body as { error?: string }).error).toBeTruthy();
  });

  test('POST /tasks/:id/complete 回 200', () => {
    expect(handle(board(), { method: 'POST', path: '/tasks/t1/complete' }).status).toBe(200);
  });

  test('未知路径回 404', () => {
    expect(handle(board(), { method: 'GET', path: '/nope' }).status).toBe(404);
  });

  test('已知路径 + 错方法回 405', () => {
    expect(handle(board(), { method: 'DELETE', path: '/tasks' }).status).toBe(405);
  });
});
`;

const RENDER_TEST = `import { describe, expect, test } from 'bun:test';
import { renderBoardHtml } from './render-board';

const T = [
  { id: 't1', title: '写文档', status: 'open' as const },
  { id: 't2', title: '发版', status: 'done' as const },
];

describe('renderBoardHtml', () => {
  test('产出完整独立页面 (可直接 file:// 打开)', () => {
    const h = renderBoardHtml(T);
    expect(h).toContain('<!doctype html>');
    expect(h).toContain('</html>');
    expect(h).toContain('<style>'); // 样式内联, 不依赖外部 CSS
  });

  test('每个任务一行, 带 data-task-id', () => {
    const h = renderBoardHtml(T);
    expect(h).toContain('data-task-id="t1"');
    expect(h).toContain('data-task-id="t2"');
  });

  test('done 任务带可区分的状态标记', () => {
    expect(renderBoardHtml(T)).toMatch(/data-task-id="t2"[^>]*data-status="done"/);
  });

  test('空列表渲染 empty state 而不是空白页', () => {
    const h = renderBoardHtml([]);
    expect(h).toContain('data-state="empty"');
    expect(h.length).toBeGreaterThan(200);
  });

  test('error 态可渲染', () => {
    expect(renderBoardHtml([], { error: '加载失败' })).toContain('data-state="error"');
  });

  test('loading 态可渲染', () => {
    expect(renderBoardHtml([], { loading: true })).toContain('data-state="loading"');
  });

  test('转义 HTML (防注入)', () => {
    const h = renderBoardHtml([{ id: 'x', title: '<img src=x onerror=alert(1)>', status: 'open' }]);
    expect(h).not.toContain('<img src=x');
    expect(h).toContain('&lt;img');
  });

  test('标题出现在输出里 (真渲染了内容)', () => {
    expect(renderBoardHtml(T)).toContain('写文档');
  });
});
`;


/**
 * **故意做坏的参考页** (2026-07-26 owner: "让多模态审核来检测到 ui 崩坏")。
 *
 * 四个缺陷是刻意挑的 —— 两个 OCR 级 (看得见字才发现)、两个布局级 (看得懂空间关系才发现),
 * 一起测才知道视觉模型是"能读字"还是"真能看图":
 *   D1 占位文案没删      TODO_PLACEHOLDER 明晃晃留在页面上   → OCR 级
 *   D2 文字溢出被裁切    固定宽 + overflow:hidden 切在词中间  → 布局级
 *   D3 对比度不可读      #eeeeee 文字压在白底上               → 布局/色彩级
 *   D4 状态视觉不可分    done 与 open 两行长得一模一样        → 语义/视觉级
 *
 * 判据是**召回**: 审查节点的输出提到了几个。关键词匹配是代理指标, 不是完美 oracle ——
 * 但这四个缺陷是我们亲手种的、无歧义的, 看见了几乎不可能不说, 没看见也编不出来。
 */
const BROKEN_PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>Task board (reference)</title><style>
body{font-family:system-ui;margin:0;background:#fff;color:#222}
.wrap{max-width:520px;margin:32px auto}
h1{font-size:22px;margin:0 0 4px}
.sub{color:#eeeeee;font-size:13px;margin:0 0 18px}
.row{display:flex;gap:8px;padding:9px 10px;border-bottom:1px solid #eee}
.title{width:120px;overflow:hidden;white-space:nowrap}
.badge{font-size:12px;color:#888}
</style></head><body><div class="wrap">
<h1>Task board</h1>
<p class="sub">共 3 项 · 1 项已完成 · 最近更新 2 分钟前</p>
<div class="row" data-task-id="t1" data-status="open"><div class="title">把发布流程整理成一份可执行的清单</div><div class="badge">open</div></div>
<div class="row" data-task-id="t2" data-status="done"><div class="title">写 changelog</div><div class="badge">done</div></div>
<div class="row" data-task-id="t3" data-status="open"><div class="title">TODO_PLACEHOLDER</div><div class="badge">open</div></div>
</div></body></html>
`;

/** 种下的缺陷清单 (eval 侧按它算召回; 与页面同源, 改页面必须同步改这里)。 */
export const PLANTED_DEFECTS = [
  { id: 'D1', what: '占位文案 TODO_PLACEHOLDER 留在页面上', hints: ['todo', 'placeholder', '占位'] },
  { id: 'D2', what: '标题被固定宽容器裁切 (overflow hidden, 切在词中间)', hints: ['溢出', '裁切', '截断', 'overflow', 'clip', 'truncat', 'cut off', 'cut-off'] },
  { id: 'D3', what: '副标题 #eeeeee 压白底, 对比度不可读', hints: ['对比度', '读不清', '看不清', '太浅', 'contrast', 'illegible', 'unreadable', 'faint'] },
  { id: 'D4', what: 'done 与 open 两行视觉上无法区分', hints: ['无法区分', '不可分', '区分不开', '一样', 'indistinguish', 'no visual difference', 'same style'] },
] as const;

function spec(renderCli: string): string {
  return `# Fullstack 任务: 从零建一个任务板 (后端 + API + 前端 + 像素证据)

在 \`${APP}/\` 下建三个模块, 让 \`${APP}/src/*.test.ts\` 三份**预写测试**全绿、且 whole-project tsc 无错。
**测试就是契约, 不许改测试**; 三个模块的公开 API 面由测试的 import 与断言钉死。

## 要建的东西

1. \`${APP}/src/board.ts\` — 内存任务板
   导出 \`createBoard()\`, 返回带 \`add({id,title})\` / \`complete(id)\` / \`list(status?)\` 的对象。
   Task = \`{ id: string; title: string; status: 'open' | 'done' }\`。
   不变量: id 唯一 (重复抛错) · title 非空 (空白抛错) · complete 幂等 · complete 未知 id 抛错 ·
   list 保插入序 · list 返回副本 (外部改动不污染内部)。

2. \`${APP}/src/api.ts\` — 纯请求映射 (**不起服务器**)
   导出 \`handle(board, req)\`, req = \`{ method, path, query?, body? }\` → \`{ status, body }\`。
   路由: \`GET /tasks\` (支持 \`?status=\`) → 200 \`{tasks}\` · \`POST /tasks\` → 201 ·
   \`POST /tasks/:id/complete\` → 200 · 未知路径 404 · 已知路径错方法 405 ·
   入参不合法 → **400 + \`{error}\`**, 不许把异常漏成 500。

3. \`${APP}/src/render-board.ts\` — 前端渲染
   导出 \`renderBoardHtml(tasks, opts?)\` → **完整独立 HTML 页面字符串** (含 \`<!doctype html>\`、
   内联 \`<style>\`, 不依赖任何外部资源)。
   必须渲染**四个状态**: 有数据 / 空 (\`data-state="empty"\`) / 加载中 (\`data-state="loading"\`) /
   出错 (\`data-state="error"\`)。每行带 \`data-task-id\` 与 \`data-status\`。**必须转义 HTML** (防注入)。
   视觉要求 (会被真像素审查, 不只看代码): 清晰的视觉层级 (标题 > 任务 > 元信息) · 一致的间距节奏 ·
   done 与 open 有可分辨的视觉差异 · 没有溢出/裁切/挤在一起的元素。

## 像素证据 (硬要求, **两层**)

前端做完后必须有一个 command 节点把页面渲染成截图并**打印图片路径**, 然后接**两层**审查:

**第一层 —— 崩坏检测**: 一个 \`attach_media\` 的审查 leaf, 同时看**两张图**:
你自己产出的页面, 以及仓库里已有的参考页 \`${APP}/fixtures/broken-board.html\` (它是**故意做坏的**)。
逐条列出你在**像素上**看到的视觉缺陷 —— 占位文案、被裁切的文字、读不清的低对比度文字、
状态之间无法区分, 等等。只说图上看得见的, 不要从代码推断。

**第二层 —— 设计质量**: 再接一个 \`attach_media\` 的审查 leaf, \`depends_on\` 第一层,
并设 \`template: "ui-reviewer"\` (用仓库里那张审查卡的六个维度: 层级/布局/可读性/状态/一致性/slop)。
它评的是**整页的 UX 与视觉设计质量**, 不是找崩坏 —— 给出按严重度排序的改进项。

渲染这样调 (omd-render 住在本仓, 不在本 worktree 里, 用绝对路径):

\`\`\`
bun run ${renderCli} <生成的 html 绝对路径> --out ${APP}/shots
\`\`\`

生成待截图页面的办法: 写一个小脚本 \`${APP}/build-page.ts\`, 调 \`renderBoardHtml\` 把示例数据渲染成
\`${APP}/dist/index.html\` (\`bun run ${APP}/build-page.ts\`), 再对它截图。空态也值得单独截一张。
参考页 \`${APP}/fixtures/broken-board.html\` 已经在仓库里, 直接对它截图即可 (别改它, 它是对照物)。

## oracle

\`bun run tsc --noEmit && bun test ${APP}/\` 全绿。截图必须真的存在且非空。
`;
}

/**
 * 建 fullstack fixture: worktree (拿 bun/tsc/node_modules) + 写入三份契约测试 + SPEC。
 * targetPaths 传空 —— 这是**绿地**任务, 没有"被清空的既有实现", 三个模块由 fleet 从零建。
 */
export async function createFullstackFixture(opts: { repoRoot?: string } = {}): Promise<WorktreeFixture> {
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());
  const renderCli = join(repoRoot, 'scripts', 'omd-render.ts');
  const fx = await createWorktreeFixture({
    id: 'fullstack-board',
    ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}),
    targetPaths: [],
    testPaths: [`${APP}/src/board.test.ts`, `${APP}/src/api.test.ts`, `${APP}/src/render-board.test.ts`],
    spec: spec(renderCli),
  });
  await mkdir(join(fx.root, APP, 'src'), { recursive: true });
  await writeFile(join(fx.root, APP, 'src', 'board.test.ts'), BOARD_TEST, 'utf8');
  await writeFile(join(fx.root, APP, 'src', 'api.test.ts'), API_TEST, 'utf8');
  await writeFile(join(fx.root, APP, 'src', 'render-board.test.ts'), RENDER_TEST, 'utf8');
  await mkdir(join(fx.root, APP, 'fixtures'), { recursive: true });
  await writeFile(join(fx.root, APP, 'fixtures', 'broken-board.html'), BROKEN_PAGE, 'utf8');
  return {
    ...fx,
    // 只跑 eval-app 的测试 (本仓自己的 1000+ 测试与本任务无关, 跑它们纯烧墙钟)。
    oracleCmd: `bun run tsc --noEmit && bun test ${APP}/`,
  };
}
