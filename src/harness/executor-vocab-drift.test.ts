/**
 * src/harness/executor-vocab-drift.test —— **executor 词表漂移闸**。
 *
 * ## 拆的是什么
 *
 * `executor` 的值域真源是 zod(`conductor-plan.ts:156`)。但模型看不见 zod ——
 * 它只看见**各个 prompt 里手写的那一行枚举**。两边是两份独立的字符串,谁也不认识谁。
 *
 * 后果实测过, 而且**不是理论风险**:
 *   · `26895234`(W1)修默认三档时发现 `research`/`await` 在词表里一个字都没有 ⇒
 *     两个 100% 建成的执行器(engine `runResearch` / `runAwaitNode`)在 **114 份存档 plan
 *     里产出 0 次**;
 *   · `runs/2026-08-30-归因信号基线.md` 又在三批 **237 trial** 上量到同一个 0
 *     (节点 kind 只见 agent/command/inproc/conductor);
 *   · 2026-08-30 本次: 同一个缺口在 `execute-slice.ts` 的定稿档**还在**, 而那条路正是
 *     CLAUDE.md 写的默认夜批路(`solve` + `sddPath`)。
 *
 * **同一个缺陷在三个 prompt 上各犯一次**, 因为没有任何东西把它们绑在一起。这条闸就是那个东西。
 *
 * ## 判据
 *
 * 每个 prompt 里的 executor 枚举必须是 zod 值域的**子集**(写了 zod 不认的值 = 教模型写非法 plan),
 * 且缺的每一个都必须在 {@link DELIBERATE_OMISSIONS} 里**具名写清为什么**。
 * 「漏了」与「想清楚了不给」在字符串上长得一模一样 —— 这张表就是把两者分开的那一列
 * (同 `seat-usage.ts` 的 `KNOWN_UNATTRIBUTABLE` 与 `traceIsClassified`)。
 *
 * ## 反向自检(当场证伪过)
 *
 *  - 把 `execute-slice.ts` 那行的 `|"research"` 删掉 → 本闸红(research 既不在词表也不在豁免表)。
 *  - 往任一 prompt 的枚举里加一个 zod 不认的值(如 `|"sorcery"`)→ 本闸红。
 *  - 把 `DELIBERATE_OMISSIONS` 里 `execute-slice` 的 `await` 那条删掉 → 本闸红。
 *  - 扫到 0 个 prompt(判据锚点漂了)→ 本闸红, 不静默变成"永远绿"。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';


const HERE = import.meta.dir;

/**
 * zod 值域 = 唯一真源。**从 `conductor-plan.ts` 的 `executor: z.enum([...])` 那一行读**,
 * 不在本文件再抄一份字符串。
 *
 * 刻意读源码文本而不是反射 zod 内部结构: 内部形状随 zod 版本变(`.options` / `.def.innerType.options`
 * / `.def.values` 各版本不同), 一个只在升级 zod 时才炸、且炸法是"反射到 undefined ⇒ 集合为空
 * ⇒ 闸永远绿"的判据, 比它要防的漂移更危险。读文本至少炸得响(下面有前置断言)。
 */
function zodEnums(): Set<string>[] {
  const src = readFileSync(join(HERE, 'conductor-plan.ts'), 'utf8');
  return [...src.matchAll(/executor:\s*z\.enum\(\[([^\]]+)\]\)/g)].map(
    (m) => new Set([...(m[1] ?? '').matchAll(/'([a-z-]+)'/g)].map((x) => x[1] as string)),
  );
}

/**
 * 想清楚了不给的 —— 每条必须写为什么。空着的位置比写错的位置危险,所以这张表是**必填**的。
 */
const DELIBERATE_OMISSIONS: Record<string, Record<string, string>> = {
  'execute-slice.ts': {
    await:
      'await 与 spec 互为 required (conductor-plan.ts:376) —— 词表明示了就必须给 spec 形状, ' +
      '否则模型写出的 await 节点让整张 plan 判 INVALID。而它的语义是「等另一个 run 发布产物」, ' +
      '一张编译出来的 slice 里没有别的 run 能解锁它。',
    conductor:
      'conductor = 运行时再规划, 多一次规划发 + 一层间接。本档指令是「只补足与修形, 不重新发明结构」, ' +
      '给它等于邀请定稿器把已经排好的图再拆一遍。',
  },
};

/** 被扫的 prompt 文件。每个文件里可以有多行枚举, 各自算一条。 */
const PROMPT_FILES = ['conductor-plan.ts', 'execute-slice.ts'] as const;

/**
 * 一行枚举的**豁免键**。同一个文件里可以有语义不同的多行(如 map 的 lister 子 schema),
 * 它们该给的词表本来就不一样 —— 按文件做键会把两种意图混成一个, 那正是本闸要防的抹平。
 * 今天只需要区分 lister 一种; 再出现别的就在这里加一个标记, 别把它们并进同一个桶。
 */
const keyOf = (file: string, line: string): string => (line.includes('"lister"') ? `${file}#lister` : file);

function enumsIn(file: string): { key: string; vals: string[]; isLister: boolean }[] {
  const src = readFileSync(join(HERE, file), 'utf8');
  const out: { key: string; vals: string[]; isLister: boolean }[] = [];
  for (const line of src.split('\n')) {
    if (!line.includes('"executor"?:')) continue;
    // 只取 executor 那一段(到同行下一个字段之前), 免得把后面 output_type 的值也吃进来。
    const seg = line.slice(line.indexOf('"executor"?:'));
    const cut = seg.indexOf('", "');
    const upto = cut >= 0 ? seg.slice(0, cut + 1) : seg;
    const vals = [...upto.matchAll(/"([a-z-]+)"/g)].map((m) => m[1] as string).filter((v) => v !== 'executor');
    if (vals.length) out.push({ key: keyOf(file, line), vals, isLister: line.includes('"lister"') });
  }
  return out;
}

describe('executor 词表漂移闸 (prompt ↔ zod 真源)', () => {
  const [listerZod, nodeZod] = zodEnums();

  test('★0 前置: 两个 zod 值域都读得出来, 且确实是宽窄两个 —— 读不出来这条闸就是空的', () => {
    expect(listerZod, '读不到第一个 executor z.enum (lister, :57) —— 判据锚点漂了').toBeDefined();
    expect(nodeZod, '读不到第二个 executor z.enum (节点, :156) —— 判据锚点漂了').toBeDefined();
    // 窄的是 lister(3 个), 宽的是节点(6 个; 'conductor' 随 v1 于 2026-09-03 退役)。顺序反了下面全错, 所以在这里钉死。
    expect([...(listerZod as Set<string>)].sort()).toEqual(['agent', 'command', 'leaf']);
    for (const v of ['leaf', 'agent', 'command', 'map', 'research', 'await'])
      expect((nodeZod as Set<string>).has(v), `节点 zod 值域少了 ${v}`).toBe(true);
  });

  test('★ 每个 prompt 的枚举 ⊆ zod 值域 (教模型写 zod 不认的值 = 教它写非法 plan)', () => {
    let scanned = 0;
    const bad: string[] = [];
    for (const file of PROMPT_FILES) {
      for (const { key, vals, isLister } of enumsIn(file)) {
        scanned += 1;
        const zod = (isLister ? listerZod : nodeZod) as Set<string>;
        for (const v of vals) if (!zod.has(v)) bad.push(`${key}: "${v}" 不在对应的 zod 值域`);
      }
    }
    expect(scanned, '一行 executor 枚举都没扫到 —— 判据锚点漂了').toBeGreaterThan(0);
    expect(bad, bad.join('\n')).toEqual([]);
  });

  test('★ 缺的每一个都必须在豁免表里具名写清为什么 (「漏了」与「不给」要分得开)', () => {
    const bad: string[] = [];
    for (const file of PROMPT_FILES) {
      for (const { key, vals, isLister } of enumsIn(file)) {
        const zod = (isLister ? listerZod : nodeZod) as Set<string>;
        const exempt = DELIBERATE_OMISSIONS[key] ?? {};
        const have = new Set(vals);
        for (const v of zod) {
          if (have.has(v)) continue;
          if (!exempt[v]) bad.push(`${key} 的词表缺 "${v}", 而豁免表里没有它 —— 是漏了还是不给? 写进 DELIBERATE_OMISSIONS。`);
        }
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });
});
