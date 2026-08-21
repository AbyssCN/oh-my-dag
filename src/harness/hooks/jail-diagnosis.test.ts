/**
 * jail 自检层③ 的反向自检(owner 裁 2026-08-21)。
 *
 * 每条用例注明"怎么让它红" —— **一条永远绿的闸不是闸**。
 * 样本取自本仓真实付过钱的五笔 jail 次生事故,不是编的:
 *   · `3f8e366` 隔离档下 agent leaf 一个都起不来(9 节点全灭,产物零)
 *   · **S-34** 沙箱拿走 git → 尺子同场失真,读数被写成「叶子空转」
 *   · `86e6cdb` `findNodeModules` 未返 realpath → jail 内依赖解析悬空
 */
import { describe, expect, test } from 'bun:test';
import { describeJailDiagnosis, diagnoseJailFailure } from './jail-diagnosis';

const ROOT = '/repo/.omd/runs/abc';
/** 宿主上什么都有 —— 于是"jail 里没有"必然是挂载面的问题。 */
const hostHasAll = { existsOnHost: () => true };
/** 宿主上什么都没有 —— 于是"jail 里没有"不是 jail 的锅。 */
const hostHasNone = { existsOnHost: () => false };

describe('diagnoseJailFailure —— 认挂载面, 不认模型好坏', () => {
  test('★ `Module not found` + 宿主有 node_modules → 判挂载面缺依赖', () => {
    // 3f8e366 的真实 stderr 形状。怎么让它红: 删掉那条 node_modules 规则 → 返 null, 断言红。
    const d = diagnoseJailFailure('error: Module not found "src/harness/leaf-worker.ts"\n', ROOT, hostHasAll);
    expect(d?.missing).toContain('node_modules');
    expect(d?.fix).toContain('realpath'); // 86e6cdb 那笔的具体修法要写进判词, 不是泛泛"检查挂载"
  });

  test('★★ 同一条 stderr, 宿主上**也没有** node_modules → 不抢答, 返 null', () => {
    // 这是整个模块最重要的一条。两种成因的下一步**相反**:
    //   挂载面缺 → 修部署;  真的没装 → 装依赖。
    // 编成一句话就等于把唯一能定方向的证据扔了 —— 而那正是 S-12 那一族的形状。
    // 怎么让它红: 把 hostPath 那段 `if (!p || !exists(p)) continue` 删掉 → 这条判成"挂载面缺", 红。
    expect(diagnoseJailFailure('error: Module not found "x"\n', ROOT, hostHasNone)).toBeNull();
  });

  test('★ `not a git repository` + 宿主有 .git → 判 gitBinds 缺席, 且判词点名"尺子失真"', () => {
    // S-34 的代价不是跑挂, 是**读数被写成「叶子空转」**。判词必须说出这一层,
    // 否则下一个人会把它当成一次普通的失败重跑掉。
    // 怎么让它红: 把 fix 里 S-34 那句删掉 → 断言红。
    const d = diagnoseJailFailure('fatal: not a git repository (or any of the parent directories): .git\n', ROOT, hostHasAll);
    expect(d?.missing).toContain('git');
    expect(d?.fix).toContain('尺子');
    expect(d?.fix).toContain('S-34');
  });

  test('★ `bwrap:` 开头的错误排在最前 —— 它一响, 后面所有症状都是它的下游', () => {
    // 怎么让它红: 把 bwrap 那条规则挪到 node_modules 之后 → 这条会判成"缺 node_modules", 红。
    const stderr = 'bwrap: Can\'t find source path /home/nick/.ssh: No such file or directory\nerror: Cannot find module "x"\n';
    const d = diagnoseJailFailure(stderr, ROOT, hostHasAll);
    expect(d?.missing).toContain('bwrap');
  });

  test('★ 认不出来 → null, 原判词原样出去(不许瞎猜)', () => {
    // 边界: 这个模块**不判模型好坏**。一条正常的任务失败不该被扣上"jail 有问题"的帽子 ——
    // 那会让人去修一个没坏的东西。怎么让它红: 给 RULES 加一条兜底 catch-all → 这条红。
    expect(diagnoseJailFailure('The model produced an incomplete answer.\n', ROOT, hostHasAll)).toBeNull();
    expect(diagnoseJailFailure('', ROOT, hostHasAll)).toBeNull();
  });

  test('判词渲染必须明说"不是模型不行" —— 这条闸的全部价值在于把方向指对', () => {
    const d = diagnoseJailFailure('fatal: not a git repository\n', ROOT, hostHasAll)!;
    const line = describeJailDiagnosis(d);
    expect(line).toContain('不是');
    expect(line).toContain('模型');
    expect(line).toContain('加时间/换池没用');
  });

  test('证据原文进判词(留证): 命中的那一句要能在 stderr 里找回来', () => {
    const d = diagnoseJailFailure('fatal: not a git repository (or any of the parent directories): .git\n', ROOT, hostHasAll)!;
    expect(d.evidence).toContain('not a git repository');
  });
});
