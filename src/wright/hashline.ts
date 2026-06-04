/**
 * src/wright/hashline —— hashline edit 接缝: 给 agent leaf 装「行锚定 patch」读改工具,
 * 治弱模型 (DeepSeek / MiMo agent leaf) 改文件时的**行号错位 / 内容腐烂**。
 *
 * 机制 (@oh-my-pi/hashline, 实读 15.7.6):
 *   - `hashline_read` 发 `¶PATH#TAG`(4-hex 文件快照标签) + 每行 `LINE:TEXT`;
 *   - `hashline_edit` 用 `replace N..M:` / `delete N` / `insert before N:` 等引用**标签 + 原始行号**
 *     → 快照绑版本 (stale 检测 + recovery) + 宽容解析 (容忍弱模型格式偏差) + 块编辑 (不用模型猜结束行)。
 *   - 标签**跨调用失效**: 每次 apply 重铸 `#TAG` + 重排行号 → 旧号作废, 强制模型重 read 接地。
 *
 * 设计不变量:
 *   1. read 与 edit **共享同一** Filesystem + SnapshotStore (经一个 Patcher), `canonicalPath` 作 key
 *      → read 录的快照, edit 一定验得到 (同 key 命中)。两工具不可各持一份 store。
 *   2. read 录快照前必**归一化** (stripBom + normalizeToLF), 与 Patcher 内部归一一致 → 标签可直接命中
 *      快路径 (live hash == section tag), 不每次走 recovery。
 *   3. **fail-soft**: parse 错 / stale 标签 / 越界锚点 → 返**文本结果**(非 throw), 文本明确指示弱模型
 *      「STOP 并重 read」→ agent loop 不中断, 模型自我纠偏。这是弱模型 edit 韧性的核心 (prompt.md <rules>)。
 *
 * 接线: createHashlineTools() → ToolDefinition[] → createAgentLeafRunner({ customTools })。
 * 新建文件仍走 pi 原生 `write` (hashline 只编辑已存在文件)。
 */
import { isAbsolute, resolve as resolvePath } from 'node:path';
import {
  Patch,
  Patcher,
  NodeFilesystem,
  InMemorySnapshotStore,
  MismatchError,
  isNotFound,
  formatHashlineHeader,
  formatNumberedLines,
  normalizeToLF,
  stripBom,
  type Filesystem,
  type SnapshotStore,
} from '@oh-my-pi/hashline';
import { type Static, Type } from 'typebox';
import { defineTool, type ExtensionFactory, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { logger } from '../logger';
import { m } from './i18n';

/** 弱模型用法守则 (prompt.md <rules> 浓缩) —— 经 promptGuidelines 自动注入 leaf 系统提示。 */
export const HASHLINE_GUIDELINES: string[] = [
  '改已存在文件用 hashline_edit (新建文件仍用 write)。改前必先 hashline_read 拿到 `¶PATH#TAG` 头与 `LINE:TEXT` 行号。',
  '每个 section 以 `¶PATH#TAG` 开头, TAG 是最近一次 read 的 4-hex 标签, 必填且无无标签形式。',
  '操作: `replace N..M:` 替换原始 N..M 行 (下接 `+新行`); `delete N..M` 删行 (无 body); `insert before N:` / `insert after N:` / `insert head:` / `insert tail:` 插入。单行用 `replace N..N:` / `delete N`。',
  'body 行只有 `+TEXT` 一种 (逐字, 含前导空格); `+` 单独 = 空行。绝不写 `-old` 或裸 context 行。保留某行 = 不放进任何 range。',
  '行号取自 read 的 `LINE:TEXT`, 指**原始文件**, 整个 patch 内不随 hunk 移动。range 要紧 — 只覆盖真正改动的行, 别吞没未变的签名/括号。',
  '标签跨调用失效: apply 后重铸 `#TAG` 并重排行号, 旧号作废。下一次编辑锚在 edit 响应回的新 `¶PATH#TAG` 与行号上, 或重 read。',
  'stale 标签被拒 (或任何你无法完全解释的结果) → STOP, 重 hashline_read 接地, 别在没重读的输出上继续叠行号编辑 (会复合腐烂)。',
];

const READ_SCHEMA = Type.Object({
  path: Type.String({ description: m({ en: 'File path to read (relative to working root, or absolute).', zh: '要读的文件路径 (相对工作根或绝对)。' }) }),
  offset: Type.Optional(
    Type.Number({ description: m({ en: 'Start line number (1-indexed). Omit = from line 1. For large files use it with limit to slice; line numbers stay the real file line numbers.', zh: '起始行号 (1-indexed)。省略 = 从第 1 行。大文件用它配 limit 切片, 行号仍是真实文件行号。' }) }),
  ),
  limit: Type.Optional(
    Type.Number({ description: m({ en: 'Max number of lines to render. Omit = render to end of file.', zh: '渲染行数上限。省略 = 渲染到文件末尾。' }) }),
  ),
});
type ReadParams = Static<typeof READ_SCHEMA>;

const EDIT_SCHEMA = Type.Object({
  patch: Type.String({
    description: m({
      en: 'hashline patch text. Begins with a `¶PATH#TAG` header (TAG = the 4-hex tag returned by the latest hashline_read), followed by operations like `replace N..M:` / `delete N` / `insert before N:`, with body lines as `+TEXT`. May contain multiple sections (each with its own `¶` header).',
      zh: 'hashline patch 文本。以 `¶PATH#TAG` 头开始 (TAG = 最近 hashline_read 回的 4-hex 标签), 下接 `replace N..M:` / `delete N` / `insert before N:` 等操作, body 行为 `+TEXT`。可含多个 section (各自一个 `¶` 头)。',
    }),
  }),
});
type EditParams = Static<typeof EDIT_SCHEMA>;

/** 把任意文本结果包成 AgentToolResult。details 留结构化字段供日志/UI。 */
function textResult(text: string, details: Record<string, unknown> = {}): {
  content: { type: 'text'; text: string }[];
  details: Record<string, unknown>;
} {
  return { content: [{ type: 'text', text }], details };
}

/**
 * cwd-scoped NodeFilesystem: 相对路径对 cwd 解析, canonicalPath 返绝对路径作 SnapshotStore key。
 * read 与 edit 共享同一实例 → 同一 key 空间, 快照跨工具命中。
 */
class ScopedNodeFilesystem extends NodeFilesystem {
  constructor(private readonly cwd: string) {
    super();
  }
  private abs(path: string): string {
    return isAbsolute(path) ? path : resolvePath(this.cwd, path);
  }
  override readText(path: string): Promise<string> {
    return super.readText(this.abs(path));
  }
  override writeText(path: string, content: string): ReturnType<NodeFilesystem['writeText']> {
    return super.writeText(this.abs(path), content);
  }
  override canonicalPath(path: string): string {
    return this.abs(path);
  }
  override exists(path: string): Promise<boolean> {
    return super.exists(this.abs(path));
  }
}

export interface HashlineToolsOpts {
  /** 工作根。相对路径对此解析。默认 process.cwd()。 */
  cwd?: string;
  /**
   * 注入的 Filesystem。默认 ScopedNodeFilesystem(cwd) (真磁盘)。
   * 测试传 InMemoryFilesystem 做往返 (无盘 IO)。
   */
  fs?: Filesystem;
  /** 注入的 SnapshotStore。默认 InMemorySnapshotStore (per-session LRU)。 */
  snapshots?: SnapshotStore;
}

export interface HashlineTools {
  /** `hashline_read` 工具定义。 */
  readTool: ToolDefinition;
  /** `hashline_edit` 工具定义。 */
  editTool: ToolDefinition;
  /** 共享的快照存储 (read 录 / edit 验)。暴露供测试断言。 */
  snapshots: SnapshotStore;
  /** 共享的文件系统。暴露供测试预置内容 (InMemoryFilesystem.set)。 */
  fs: Filesystem;
}

/**
 * 造一对共享快照 + 文件系统的 hashline 读改工具。
 *
 * read 录的快照与 edit 用的 Patcher 共享同一 fs/store → canonicalPath 命中, 标签可验。
 */
export function createHashlineTools(opts: HashlineToolsOpts = {}): HashlineTools {
  const cwd = opts.cwd ?? process.cwd();
  const fs: Filesystem = opts.fs ?? new ScopedNodeFilesystem(cwd);
  const snapshots: SnapshotStore = opts.snapshots ?? new InMemorySnapshotStore();
  const patcher = new Patcher({ fs, snapshots });

  const readTool = defineTool({
    name: 'hashline_read',
    label: 'Hashline Read',
    description: m({
      en: 'Read a file and render it in hashline format: a `¶PATH#TAG` header (4-hex snapshot tag) + each line as `LINE:TEXT`. Use it to ground before editing a file; feed the tag to hashline_edit.',
      zh: '读取文件并以 hashline 格式渲染: `¶PATH#TAG` 头 (4-hex 快照标签) + 每行 `LINE:TEXT`。改文件前用它接地, 标签喂给 hashline_edit。',
    }),
    promptSnippet: 'hashline_read(path) — 读文件返 `¶PATH#TAG` + `LINE:TEXT`, 改文件前必读。',
    promptGuidelines: HASHLINE_GUIDELINES,
    parameters: READ_SCHEMA,
    executionMode: 'parallel', // TR-INV-4: 只读 → 可并发 (对齐 04b isConcurrencySafe)

    async execute(_id: string, params: ReadParams) {
      const { path, offset, limit } = params;
      let raw: string;
      try {
        raw = await fs.readText(path);
      } catch (err) {
        if (isNotFound(err)) {
          return textResult(`ERROR: 文件不存在: ${path} (新建用 write 工具, hashline 只编辑已存在文件)`, {
            ok: false,
            path,
            reason: 'not_found',
          });
        }
        return textResult(`ERROR: 读取失败: ${path}: ${err instanceof Error ? err.message : String(err)}`, {
          ok: false,
          path,
          reason: 'read_error',
        });
      }

      // 归一与 Patcher 内部一致 (stripBom + LF), 录快照 → 标签可命中编辑快路径。
      const normalized = normalizeToLF(stripBom(raw).text);
      const key = fs.canonicalPath(path);
      const tag = snapshots.record(key, normalized);
      const header = formatHashlineHeader(path, tag);

      const lines = normalized.split('\n');
      const start = offset && offset > 0 ? offset : 1;
      const end = limit && limit > 0 ? Math.min(lines.length, start - 1 + limit) : lines.length;
      const sliced = lines.slice(start - 1, end).join('\n');
      const body = formatNumberedLines(sliced, start);

      logger.debug({ path, tag, lines: lines.length, start, end }, '[wright/hashline] read');
      return textResult(`${header}\n${body}`, {
        ok: true,
        path,
        tag,
        totalLines: lines.length,
        renderedFrom: start,
        renderedTo: end,
      });
    },
  });

  const editTool = defineTool({
    name: 'hashline_edit',
    label: 'Hashline Edit',
    description: m({
      en: 'Apply a hashline patch to an existing file. The patch must include a `¶PATH#TAG` header (TAG from the latest hashline_read) + operation lines. On success returns each section\'s new `¶PATH#TAG` header + the first changed line number, which you chain to keep editing.',
      zh: '对已存在文件应用 hashline patch。patch 须含 `¶PATH#TAG` 头 (TAG 来自最近 hashline_read) + 操作行。成功返每个 section 的新 `¶PATH#TAG` 头 + 首个改动行号, 凭它链式继续编辑。',
    }),
    promptSnippet: 'hashline_edit(patch) — 应用 `¶PATH#TAG` + 操作行的 patch, 改已存在文件。',
    promptGuidelines: HASHLINE_GUIDELINES,
    parameters: EDIT_SCHEMA,
    executionMode: 'sequential', // TR-INV-4: 写文件 → 串行 (对齐 04b isConcurrencySafe)

    async execute(_id: string, params: EditParams) {
      const { patch } = params;

      let parsed: Patch;
      try {
        parsed = Patch.parse(patch, { cwd });
      } catch (err) {
        return textResult(`ERROR: hashline patch 解析失败: ${err instanceof Error ? err.message : String(err)}`, {
          ok: false,
          reason: 'parse_error',
        });
      }
      if (parsed.sections.length === 0) {
        return textResult(
          'ERROR: patch 无可识别的 hashline section。每个 section 须以 `¶PATH#TAG` 头开始 (TAG 来自 hashline_read)。',
          { ok: false, reason: 'empty_patch' },
        );
      }

      try {
        const result = await patcher.apply(parsed);
        const summary = result.sections
          .map((s) => {
            if (s.op === 'noop') return `${s.path}: noop (无改动)`;
            const warn = s.warnings.length > 0 ? `\n  ⚠ ${s.warnings.join('; ')}` : '';
            return `${s.header}  [${s.op} @ line ${s.firstChangedLine ?? '?'}]${warn}`;
          })
          .join('\n');
        logger.debug(
          { sections: result.sections.map((s) => ({ path: s.path, op: s.op, hash: s.fileHash })) },
          '[wright/hashline] edit applied',
        );
        return textResult(`✓ 应用 ${result.sections.length} 个 section (新标签如下, 继续编辑请锚在新标签上):\n${summary}`, {
          ok: true,
          sections: result.sections.map((s) => ({
            path: s.path,
            op: s.op,
            fileHash: s.fileHash,
            header: s.header,
            firstChangedLine: s.firstChangedLine,
            warnings: s.warnings,
          })),
        });
      } catch (err) {
        // stale 标签 / 越界锚点 → fail-soft 文本, 指示模型重 read (不 throw 中断 loop)。
        if (err instanceof MismatchError) {
          return textResult(`STALE: 标签与文件当前内容不符, 已拒绝。STOP 并重 hashline_read 接地后再编辑。\n${err.displayMessage}`, {
            ok: false,
            reason: 'stale_tag',
            path: err.path,
            expected: err.expectedFileHash,
            actual: err.actualFileHash,
          });
        }
        return textResult(`ERROR: hashline apply 失败 (可能越界锚点或缺 block resolver): ${err instanceof Error ? err.message : String(err)}`, {
          ok: false,
          reason: 'apply_error',
        });
      }
    },
  }) as unknown as ToolDefinition;

  return { readTool: readTool as unknown as ToolDefinition, editTool, snapshots, fs };
}

/** 便捷: 返 customTools 数组直接喂 createAgentLeafRunner({ customTools })。 */
export function createHashlineCustomTools(opts: HashlineToolsOpts = {}): ToolDefinition[] {
  const { readTool, editTool } = createHashlineTools(opts);
  return [readTool, editTool];
}

/** block 原生 edit 时给模型的理由 (指向 hashline_edit 行锚定路径)。 */
export const HASHLINE_BLOCK_NATIVE_EDIT_REASON =
  '原生 edit 已禁用 (弱模型用它易行错位/腐烂)。改已存在文件请用 hashline_edit: 先 hashline_read ' +
  '拿 `¶PATH#TAG` 头与 `LINE:TEXT` 行号, 再发行锚定 patch (replace/delete/insert before)。新建文件仍用 write。';

/**
 * 造 hashline 的**交互-TUI extension** —— 把 agent-leaf 的
 * `createAgentSession({ customTools: hashline, excludeTools: ['edit'] })` 等价搬到 pi `main()` 路径。
 *
 * 为什么经 extension: 交互 TUI 走 pi `main(args, { extensionFactories })`, **不暴露 customTools/
 * excludeTools** (那是 createAgentSession 才有的)。两侧各补一招:
 *   - 注入侧 → `pi.registerTool(hashline_read/hashline_edit)` (ExtensionAPI 原生支持)。
 *   - 排除侧 → `on('tool_call')` block 原生 `edit` (复用 readonly-gate/tool-gate 同一 fail-closed 形态)。
 *     `write` 不拦 (整文件覆写不易行错位, 新建文件还需它) —— 与 agent-leaf `excludeTools:['edit']` 一致。
 *
 * 默认只在驱动**弱 executor** 时挂 (tui.ts 的 resolveHashlineEdit 门控): 弱 MiMo 原生 edit 易错位,
 * hashline 行锚定治它; 强模型 (用户 --model 选 Opus) 原生 edit 够好, 拦它反添摩擦。此工厂只管"挂了即生效"。
 *
 * tool_call handler 与 plan readonly-gate 正交叠加: plan mode 下 readonly-gate 已拦全部写工具
 * (含 hashline_edit), 此 handler 额外拦 native edit — 二者对 edit 都 block, 一致无冲突。
 */
export function createHashlineExtension(opts: HashlineToolsOpts = {}): ExtensionFactory {
  // 共享快照: 建一次, 整 session 复用 (hashline_read 写标签 → hashline_edit 校验同一 store)。
  const tools = createHashlineCustomTools(opts);
  return (pi) => {
    for (const tool of tools) pi.registerTool(tool);
    pi.on('tool_call', (event) => {
      if (event.toolName === 'edit') {
        return { block: true, reason: HASHLINE_BLOCK_NATIVE_EDIT_REASON };
      }
      return {};
    });
  };
}
