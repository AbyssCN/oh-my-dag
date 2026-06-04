/**
 * plan/ledger —— 代码维护的审议台账 (PlanLedger)。
 *
 * "每个新 turn 重审之前规划" 的**模型外硬化**: 决策/目标/参考源不靠模型记忆, 由代码持久 + 每轮
 * before_agent_start 重注入。P1 真实写路径 = \`/note\` 命令 (decisions) + (P2) \`/ref\` (refs)。
 */
import type { ComplexityLevel } from './complexity';

/** 摄取的参考源 (P2/D 链接摄取填; P1 仅占位结构)。 */
export interface PlanRef {
  url: string;
  title?: string;
  /** valar 标注"为何与本方案相关" (D 子系统)。 */
  relevance?: string;
}

export interface PlanLedgerInit {
  goal?: string;
  complexity?: ComplexityLevel | null;
}

/** 一次 plan 会话的审议台账。可变 (随讨论累积), 单一真理源, 可单测。 */
export class PlanLedger {
  goal: string;
  complexity: ComplexityLevel | null;
  turnCount: number;
  readonly decisions: string[];
  readonly refs: PlanRef[];
  /** 待一次性注入的全文 (D: 抓到的 ref 正文 / 搜索结果)。drainPending 取走清空, 不每轮重注 (防膨胀)。 */
  private pending: string[];

  constructor(init: PlanLedgerInit = {}) {
    this.goal = init.goal ?? '';
    this.complexity = init.complexity ?? null;
    this.turnCount = 0;
    this.decisions = [];
    this.refs = [];
    this.pending = [];
  }

  /** 记一条已定决策。 */
  note(decision: string): void {
    const t = decision.trim();
    if (t) this.decisions.push(t);
  }

  /** 已摄取过此 url? (dedup, 防重复抓取/重复注入)。 */
  hasRef(url: string): boolean {
    return this.refs.some((r) => r.url === url);
  }

  /**
   * 摄取一条参考源 (P2/D)。ref 摘要 (url/title/relevance) 持久进 refs (每轮注 summary);
   * fullContent (抓到的正文) 进 pending, **仅下一轮一次性注入** (drainPending), 不每轮重注 (防 context 膨胀)。
   * 已存在 (hasRef) → 跳过 (dedup)。
   */
  addRef(ref: PlanRef, fullContent?: string): void {
    if (this.hasRef(ref.url)) return;
    this.refs.push(ref);
    if (fullContent && fullContent.trim()) {
      const label = ref.title ? ` title="${ref.title.replace(/"/g, "'")}"` : '';
      this.pending.push(`<ref url="${ref.url}"${label}>\n${fullContent.trim()}\n</ref>`);
    }
  }

  /** 推一段待一次性注入的全文 (如 /search 的元搜索结果)。 */
  pushPending(content: string): void {
    const t = content.trim();
    if (t) this.pending.push(t);
  }

  /** 取走并清空待注入全文 (before_agent_start 调, 仅注一次)。 */
  drainPending(): string[] {
    const p = this.pending;
    this.pending = [];
    return p;
  }

  /**
   * 落盘文档内容 (F crystallize): 把台账固化成结构化 **SDD + TDD 骨架**。
   *
   * 写已固化的态 (目标/决策/refs) + 钉出 SDD+TDD 骨架段 (Contracts/红测/落点) 供 valar 续写填充。
   * **骨架非全行为** (Core Principle 3): Contracts 钉不变量, 不展开完整行为; 完整实装 = 退出后的代码+测试。
   * 用于 `/crystallize` (→ .valar/sessions 纪要) 与 `/sdd` (→ docs/plan canonical plan) 两路, 同一骨架。
   */
  crystallize(title: string, dateStr: string): string {
    const lines: string[] = [
      `# ${title}`,
      '',
      `> valar plan mode crystallize · ${dateStr} · turn ${this.turnCount}`,
      '',
      '## 目标',
      this.goal || '(未记录 — 讨论中明确)',
      '',
      '## 已定决策 (台账)',
    ];
    if (this.decisions.length > 0) {
      this.decisions.forEach((d, i) => lines.push(`${i + 1}. ${d}`));
    } else {
      lines.push('(无)');
    }
    lines.push('', '## 参考源');
    if (this.refs.length > 0) {
      this.refs.forEach((r) =>
        lines.push(`- [${r.title ?? r.url}](${r.url})${r.relevance ? ` — ${r.relevance}` : ''}`),
      );
    } else {
      lines.push('(无)');
    }
    // SDD+TDD 骨架 (钉不变量, 非全行为 — Core Principle 3)。valar 在此续写填充。
    lines.push(
      '',
      '## Contracts (钉不变量, 非全行为)',
      '',
      '### Types',
      '(数据/接口类型 — 从上方决策展开)',
      '',
      '### Validation',
      '(校验规则 / 前置后置条件 / 不变式)',
      '',
      '### State Machine',
      '(状态 + 合法迁移; 非法迁移即 bug)',
      '',
      '### 验收 (GWT)',
      '(Given / When / Then — 可证伪验收点)',
      '',
      '## TDD 红测清单',
      '(先写的红测: 高风险接缝逐条; 绿≠正确, 高风险走对抗证伪)',
      '',
      '## 落点 (files / seams)',
      '(改哪些文件 / 接缝; 命名不变量)',
      '',
    );
    return lines.join('\n');
  }

  /** turn 计数 +1, 返回新值 (每轮 before_agent_start 调)。 */
  bumpTurn(): number {
    this.turnCount += 1;
    return this.turnCount;
  }

  /** 渲染注入块 (每轮 plan mode 注 systemPrompt, 让模型确定性重审)。 */
  render(): string {
    const lines: string[] = [`<plan-ledger turn="${this.turnCount}">`];
    if (this.goal) lines.push(`目标: ${this.goal}`);
    if (this.complexity) lines.push(`复杂度: ${this.complexity}`);
    if (this.decisions.length > 0) {
      lines.push(`已定决策 (${this.decisions.length}):`);
      this.decisions.forEach((d, i) => lines.push(`  ${i + 1}. ${d}`));
    } else {
      lines.push('已定决策: (无 — 用 /note 记)');
    }
    if (this.refs.length > 0) {
      lines.push(`参考源 (${this.refs.length}):`);
      this.refs.forEach((r, i) =>
        lines.push(`  ${i + 1}. ${r.title ?? r.url}${r.relevance ? ` — ${r.relevance}` : ''}`),
      );
    }
    lines.push('</plan-ledger>');
    return lines.join('\n');
  }
}
