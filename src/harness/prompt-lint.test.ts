/**
 * src/harness/prompt-lint.test.ts —— INV-8 / D8 组合判定教化段编译期闸的机械对账
 *
 * 起因 (S1 契约 §C-2 / D8, 2026-08-24): conductor 在无预设组合方案的任务里三病同根 —— 不主动 fanout+judge /
 * 幻觉工具路径 / skill 散文禁令不内化。治法 = 把"组合判定四分支"逐字写进 L2 教化段 + 钉 ≤350 Unicode 字符
 * 上限, 模块顶层 throw = 任何 import 触发, 永不运行期截断。
 *
 * 本测试只验 INV-8 / D8 这一条闸, 不验装配路由 (那在 conductor-prompt-snapshot.test.ts)。验五件事:
 *  ① canonical 教化段文本 → lint 绿
 *  ② 同一文本双倍复制 → lint 红 (必红样本), 判词含上限值
 *  ③ 上限判定用 Array.from(str).length (Unicode 码点), 不是 .length (UTF-16 单位)
 *  ④ 上限数值来自 LINT_MAX_DECISION_EDUCATION_CHARS 配置常量, 非函数内硬编码
 *  ⑤ 作用域 = 仅教化段: 编译期闸只查 canonical, lintDecisionEducation 是 content-blind 计数器
 *  ⑥ 永不运行期截断: 超限返错误结构, 不返被截断的字符串
 *
 * owner 可调: LINT_MAX_DECISION_EDUCATION_CHARS (改值 = 闸放宽/收紧)。其它改动必须保持"≤350 Unicode 字符"。
 */
import { describe, expect, test } from 'bun:test';
import {
  DECISION_EDUCATION_CANONICAL,
  DECISION_EDUCATION_CANONICAL_CHARS,
  LINT_MAX_DECISION_EDUCATION_CHARS,
  lintDecisionEducation,
} from './prompt-lint';

describe('prompt-lint (INV-8 / D8) — 组合判定教化段编译期闸', () => {
  // ────────────────────────────────────────────────────────────────────
  // ① canonical 教化段文本 → lint 绿
  // ────────────────────────────────────────────────────────────────────
  test('canonical 教化段 (SDD §C-2 / D8 逐字 6 行) → ok:true', () => {
    const result = lintDecisionEducation(DECISION_EDUCATION_CANONICAL);
    expect(result.ok).toBe(true);
  });

  test('canonical 教化段 6 行结构自证 (字符串含 SDD 钉死的关键判定位)', () => {
    // 6 行: 行内 line break 区分, 不是字面 \n —— canonical 是模板字符串, 行间由 \n 分隔
    const lines = DECISION_EDUCATION_CANONICAL.split('\n');
    expect(lines.length).toBe(6);
    // 6 行逐字 (与 prompt-lint.ts L29-34 一字不差, 改即漂)
    expect(lines[0]).toBe('你产 DAG。能力 = 引擎原语(常驻) + ext/skill(用 ToolSearch 发现)。');
    expect(lines[1]).toBe('组合判定四分支——廉价 oracle 过滤 / 视觉产出接 render / 宽解空间 persona fanout+judge /');
    expect(lines[2]).toBe('缺工具则 bootstrap 自建或声明缺口——请在 ConductorPlan 字段里显式表达:');
    expect(lines[3]).toBe('oracleKind、whyNoFanout、toolRefs、budgetBasis。');
    expect(lines[4]).toBe('plan-critic 在编译期做 schema 校验,缺字段直接打回,不接受自然语言申辩。');
    expect(lines[5]).toBe('不要臆造工具路径:ToolSearch 未命中即视为不存在。');
    // 关键判定位不能丢 (改一字即不内化)
    expect(DECISION_EDUCATION_CANONICAL).toContain('oracleKind');
    expect(DECISION_EDUCATION_CANONICAL).toContain('whyNoFanout');
    expect(DECISION_EDUCATION_CANONICAL).toContain('budgetBasis');
    expect(DECISION_EDUCATION_CANONICAL).toContain('plan-critic');
    expect(DECISION_EDUCATION_CANONICAL).toContain('ToolSearch');
  });

  test('canonical 字符数自证 = 290 (实装钉死, 反锁无声膨胀)', () => {
    // DECISION_EDUCATION_CANONICAL_CHARS 是固定导出, 等于 Array.from(canonical).length
    expect(DECISION_EDUCATION_CANONICAL_CHARS).toBe(Array.from(DECISION_EDUCATION_CANONICAL).length);
    expect(DECISION_EDUCATION_CANONICAL_CHARS).toBeLessThanOrEqual(LINT_MAX_DECISION_EDUCATION_CHARS);
    // 显式锁 290 (留 60 headroom): 改了必须意识到是"放宽上限", 不能让数自己漂走
    expect(DECISION_EDUCATION_CANONICAL_CHARS).toBe(290);
  });

  // ────────────────────────────────────────────────────────────────────
  // ② 同一文本双倍复制 → lint 红 (必红样本), 判词含上限
  // ────────────────────────────────────────────────────────────────────
  test('canonical 双倍 → ok:false, 判词含上限数值 (必红样本)', () => {
    const doubled = DECISION_EDUCATION_CANONICAL + DECISION_EDUCATION_CANONICAL;
    const result = lintDecisionEducation(doubled);
    // 必红
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 判词含字符上限数值 — 调用方据此决策 (不截断)
      expect(result.reason).toContain(String(LINT_MAX_DECISION_EDUCATION_CHARS));
      // 判词含"超限"信号 — 实装措辞: "is X Unicode chars; limit is Y"
      expect(result.reason).toMatch(/is \d+ Unicode chars/);
      expect(result.reason).toContain(`limit is ${LINT_MAX_DECISION_EDUCATION_CHARS}`);
      // 超限字符数 = 580 (290 × 2)
      expect(result.length).toBe(2 * DECISION_EDUCATION_CANONICAL_CHARS);
      expect(result.length).toBeGreaterThan(LINT_MAX_DECISION_EDUCATION_CHARS);
      // limit 字段 = 配置常量
      expect(result.limit).toBe(LINT_MAX_DECISION_EDUCATION_CHARS);
    }
  });

  test('canonical 双倍前还绿, 双倍后必红 (临界断言, 证明绿/红判定有判别力)', () => {
    const one = DECISION_EDUCATION_CANONICAL;
    const two = DECISION_EDUCATION_CANONICAL + DECISION_EDUCATION_CANONICAL;
    expect(lintDecisionEducation(one).ok).toBe(true);
    expect(lintDecisionEducation(two).ok).toBe(false);
    // 中间值: 三倍也红
    expect(lintDecisionEducation(DECISION_EDUCATION_CANONICAL.repeat(3)).ok).toBe(false);
  });

  // ────────────────────────────────────────────────────────────────────
  // ③ 上限 = 350 Unicode 字符, 用 Array.from(str).length (码点) 不是 .length (UTF-16)
  // ────────────────────────────────────────────────────────────────────
  test('字符计数用码点 (Array.from) 不是 UTF-16: 349 个 emoji 仍绿 (反证)', () => {
    // 349 个 😀 = 349 codepoints, 698 UTF-16 单位 (surrogate pair × 349)
    const within349 = '😀'.repeat(349);
    // 自证 UTF-16 长度 ≠ 码点长度 (本测试的反向基础)
    expect(within349.length).toBe(698); // UTF-16 单位
    expect(Array.from(within349).length).toBe(349); // 码点
    // 若函数用 .length (UTF-16), 698 > 350 必红; 用码点, 349 ≤ 350 绿
    // → 绿 = 反证函数用的是码点计数
    const result = lintDecisionEducation(within349);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 双保险: 若用 .length, 会落入 else 分支; 此处 ok:true 锁定码点判定
    } else {
      throw new Error('emoji 349 码点应绿; 红 = 函数用了 UTF-16 而非码点');
    }
  });

  test('中文字符按码点计 1: 350 个中文字符 → ok:true (边界值)', () => {
    const chars350 = '中'.repeat(350);
    // 中文 BMP 内, UTF-16 = 码点; 这里两者都是 350
    expect(Array.from(chars350).length).toBe(350);
    expect(chars350.length).toBe(350);
    // 边界: 等于上限 → 绿 (> 才是红)
    expect(lintDecisionEducation(chars350).ok).toBe(true);
    // 351 → 红
    expect(lintDecisionEducation('中'.repeat(351)).ok).toBe(false);
  });

  test('码点超限: 351 个 emoji → ok:false, length = 351 (不是 UTF-16 的 702)', () => {
    const chars351 = '😀'.repeat(351);
    expect(chars351.length).toBe(702); // UTF-16 单位
    expect(Array.from(chars351).length).toBe(351); // 码点
    const result = lintDecisionEducation(chars351);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // length 字段必 = 码点数 (351), 不是 UTF-16 单位 (702) — 双重反证码点计数
      expect(result.length).toBe(351);
      expect(result.length).not.toBe(702);
    }
  });

  test('混合 emoji + 中文: 码点计数判定', () => {
    // 200 emoji + 150 中文 = 350 码点 → 绿
    const mixed = '😀'.repeat(200) + '中'.repeat(150);
    expect(Array.from(mixed).length).toBe(350);
    expect(mixed.length).toBe(200 * 2 + 150); // 550 UTF-16 单位 (emoji 占 2)
    expect(lintDecisionEducation(mixed).ok).toBe(true);
    // +1 中文 = 351 码点 → 红
    expect(lintDecisionEducation(mixed + '中').ok).toBe(false);
  });

  // ────────────────────────────────────────────────────────────────────
  // ④ 上限数值来自 LINT_MAX_DECISION_EDUCATION_CHARS (可配置) 而非硬编码常量
  // ────────────────────────────────────────────────────────────────────
  test('上限由 LINT_MAX_DECISION_EDUCATION_CHARS 提供, 函数的 limit 字段 = 该常量', () => {
    const overLong = 'x'.repeat(LINT_MAX_DECISION_EDUCATION_CHARS + 1);
    const result = lintDecisionEducation(overLong);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 函数返的 limit 字段必等于配置常量 (不是 magic 350 字面量)
      expect(result.limit).toBe(LINT_MAX_DECISION_EDUCATION_CHARS);
    }
  });

  test('LINT_MAX_DECISION_EDUCATION_CHARS 是 number 且 > 0 (可调配置存在)', () => {
    expect(typeof LINT_MAX_DECISION_EDUCATION_CHARS).toBe('number');
    expect(LINT_MAX_DECISION_EDUCATION_CHARS).toBeGreaterThan(0);
    expect(Number.isFinite(LINT_MAX_DECISION_EDUCATION_CHARS)).toBe(true);
  });

  test('LINT_MAX_DECISION_EDUCATION_CHARS 默认值 = 350 (S1 契约钉死, owner 改即知)', () => {
    expect(LINT_MAX_DECISION_EDUCATION_CHARS).toBe(350);
  });

  test('lintDecisionEducation 不内嵌 magic 350: 用长 351 字符串探针 (length 字段映射)', () => {
    // 无论配置怎么改, result.length 必 = Array.from(input).length, limit 必 = LINT_MAX_DECISION_EDUCATION_CHARS
    const text = 'a'.repeat(351);
    const result = lintDecisionEducation(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.length).toBe(351);
      expect(result.limit).toBe(LINT_MAX_DECISION_EDUCATION_CHARS);
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // ⑤ 作用域 = 仅教化段: 编译期闸只查 canonical, lintDecisionEducation 是 content-blind 计数器
  // ────────────────────────────────────────────────────────────────────
  test('编译期闸只查 DECISION_EDUCATION_CANONICAL: 模块加载成功即 canonical 合规', () => {
    // 本文件 import './prompt-lint' 成功 = 模块顶层 throw (L46) 没触发 = canonical ≤ 阈值
    // 这里再显式断言一次
    expect(DECISION_EDUCATION_CANONICAL_CHARS).toBeLessThanOrEqual(LINT_MAX_DECISION_EDUCATION_CHARS);
    // canonical 存在且非空
    expect(DECISION_EDUCATION_CANONICAL.length).toBeGreaterThan(0);
  });

  test('作用域: lintDecisionEducation 是 content-blind 计数器 (不读内容, 不分类别)', () => {
    // 模拟 PLAN-1 冻结提示段 (远超 350 字符)
    const fakePlan1Frozen = '[TRUST_FENCE_RULE] ' + 'placeholder '.repeat(200);
    const result = lintDecisionEducation(fakePlan1Frozen);
    // 机械地: 超长 → ok:false (函数不分类别)
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 判词不含 PLAN-1 / TRUST_FENCE / inventory 字眼 — 证明函数不做分类,
      //   分类由调用方 (conductor-plan.ts) 负责: 它只把 DECISION_EDUCATION_CANONICAL 喂进来
      expect(result.reason).not.toContain('TRUST_FENCE');
      expect(result.reason).not.toContain('inventory');
      expect(result.reason).not.toContain('PLAN-1');
      // 判词字段说明本函数意图只用于教化段 (即使机械上也接任何 text)
      expect(result.reason).toMatch(/decision education/i);
    }
  });

  test('作用域: 模拟 inventory 渲染段超长 — 同计数器, 同 reason 模板', () => {
    const fakeInventory = '{ "skill": "x", "entries": [' + '0,'.repeat(400) + '] }';
    const result = lintDecisionEducation(fakeInventory);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 同模板, 不带 inventory 专属字眼
      expect(result.reason).toContain('decision education');
      expect(result.reason).not.toContain('inventory');
    }
  });

  test('作用域: 调用方传空字符串 → 绿 (无内容则无门检)', () => {
    // 验证: 0 字符永绿, 不抛
    expect(lintDecisionEducation('').ok).toBe(true);
    // 1 字符也绿
    expect(lintDecisionEducation('x').ok).toBe(true);
    // 临界: limit 字符恰好
    expect(lintDecisionEducation('a'.repeat(LINT_MAX_DECISION_EDUCATION_CHARS)).ok).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────
  // ⑥ 永不运行期截断: 超限返错误结构, 不返被截断的字符串
  // ────────────────────────────────────────────────────────────────────
  test('超限返错误结构 {ok:false, reason, length, limit}, 不是被截断的字符串', () => {
    const overLong = 'A'.repeat(LINT_MAX_DECISION_EDUCATION_CHARS + 100);
    const result = lintDecisionEducation(overLong);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 类型 = object, 不是 string
      expect(typeof result).toBe('object');
      expect(typeof result.reason).toBe('string');
      expect(typeof result.length).toBe('number');
      expect(typeof result.limit).toBe('number');
      // 判词断言 D8 不变量: "never runtime truncate" (承诺不截断)
      expect(result.reason).toMatch(/never runtime truncate/i);
      // length = 原文字符数 (未截断 — 函数纯只读, input 没被动)
      expect(result.length).toBe(overLong.length);
      // input 自身长度未变 (纯函数)
      expect(overLong.length).toBe(LINT_MAX_DECISION_EDUCATION_CHARS + 100);
    }
  });

  test('超限 length = 原文码点数, 不是某个被截断后的数 (中文字符)', () => {
    const text = '中'.repeat(LINT_MAX_DECISION_EDUCATION_CHARS + 50);
    const result = lintDecisionEducation(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.length).toBe(LINT_MAX_DECISION_EDUCATION_CHARS + 50);
      expect(result.length).toBeGreaterThan(result.limit);
    }
  });

  test('永不抛 — 即使超限也只是返 ok:false, 调用方可处理 (与 module-top throw 区别)', () => {
    // lintDecisionEducation 是普通函数, 不抛 (D8 设计: 模块顶层抛 = fail-fast 在 import,
    //   函数本身返错误结构让调用方在装配期拒)
    const overLong = 'x'.repeat(LINT_MAX_DECISION_EDUCATION_CHARS + 1);
    expect(() => lintDecisionEducation(overLong)).not.toThrow();
    const result = lintDecisionEducation(overLong);
    expect(result.ok).toBe(false);
  });

  // ────────────────────────────────────────────────────────────────────
  // 综合: 返回形状契约锁
  // ────────────────────────────────────────────────────────────────────
  test('ok:true 分支只有 ok 字段 (无 length/limit/reason)', () => {
    const result = lintDecisionEducation('short');
    expect(result).toEqual({ ok: true });
    expect(Object.keys(result)).toEqual(['ok']);
  });

  test('ok:false 分支必含 ok/reason/length/limit 四字段', () => {
    const result = lintDecisionEducation('x'.repeat(LINT_MAX_DECISION_EDUCATION_CHARS + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result).sort()).toEqual(['length', 'limit', 'ok', 'reason']);
    }
  });
});
