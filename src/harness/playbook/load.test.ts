/**
 * playbook/load.test.ts —— T-1..T-5(转录自 S5 任务书 + design fan-in 冻结决策,不自造格式)。
 *
 * 每条闸的反向自检就是测试本身:构造一个刚好踩线的坏 playbook,证明 loadPlaybooks 真的拒收它,
 * 而不是只会 parse 的加载器。错误信息断言逐字用 design 冻结的格式字符串(与实装同源)。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlaybooks } from './load';
import type { Playbook } from './types';

/** 项目层叠加目录名(design 冻结:`.omd/playbooks`,与 `.omd/agents` 同规)。 */
const PROJECT_PLAYBOOK_DIR = '.omd/playbooks';

/** 每条测试独立的临时 cwd;afterEach 兜底删除(design:每项独立 mkdtemp + finally 删)。 */
let tmpDirs: string[] = [];
function makeTempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omd-playbook-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

/** 项目层写一个 playbook 目录:`<cwd>/.omd/playbooks/<name>/playbook.json` + 若干 md 文档。 */
function writeProjectPlaybook(cwd: string, name: string, config: unknown, docs: Record<string, string> = {}): void {
  const dir = join(cwd, PROJECT_PLAYBOOK_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'playbook.json'), JSON.stringify(config, null, 2));
  for (const [file, content] of Object.entries(docs)) writeFileSync(join(dir, file), content);
}

/** A-3 会真的在这份错样本上失败的验收 —— 内置那份的同一形状,复用不重造。 */
const REAL_ACCEPTANCE = {
  command: 'grep -qx "PLAYBOOK_COMPLETE" PLAYBOOK_STATUS.md',
  negativeSample: { path: 'PLAYBOOK_STATUS.md', content: 'INCOMPLETE' },
};

describe('loadPlaybooks', () => {
  // T-1:内置与 `.omd/playbooks` 同名 → 项目层胜。
  // 怎么让它红:去掉项目层覆盖或让 loadPlaybooks 只并内置层不再叠加项目层,map 里就会是内置的
  // 5 步版本而非这里的 1 步版本,下面的 steps.length 断言会失败。
  test('T-1 项目层同名 playbook 覆盖内置层', () => {
    const cwd = makeTempCwd();
    writeProjectPlaybook(
      cwd,
      'documentation-coverage',
      {
        name: 'documentation-coverage',
        steps: [{ doc: '1_ANALYZE.md' }],
        acceptance: REAL_ACCEPTANCE,
      },
      { '1_ANALYZE.md': '# 项目层覆盖版\n' },
    );
    const playbooks = loadPlaybooks(cwd);
    const pb = playbooks.get('documentation-coverage') as Playbook;
    expect(pb).toBeDefined();
    // 内置那份是 5 步(1_ANALYZE..5_PROGRESS);项目层这份只有 1 步 —— 只有项目层胜时才会是 1。
    expect(pb.steps.length).toBe(1);
    expect(pb.steps[0]?.doc).toBe('1_ANALYZE.md');
  });

  // T-2:A-1 —— maxRounds:11 被拒,错误信息带 playbook 名。
  // 怎么让它红:把校验里的 `> 10` 改成 `> 11`(或删掉这条校验),这条测试会因为 loadPlaybooks
  // 不再 throw 而失败。
  test('T-2 loop.maxRounds 超过 10 被拒', () => {
    const cwd = makeTempCwd();
    writeProjectPlaybook(
      cwd,
      'bad-max-rounds',
      {
        name: 'bad-max-rounds',
        steps: [{ doc: 'ONLY.md' }],
        loop: { maxRounds: 11 },
        acceptance: REAL_ACCEPTANCE,
      },
      { 'ONLY.md': '# 唯一步骤\n' },
    );
    expect(() => loadPlaybooks(cwd)).toThrow(
      '[playbook:bad-max-rounds] loop.maxRounds 超过上限 10: 11',
    );
  });

  // T-3:A-2 —— steps 引用不存在的 md → 拒,错误信息带那个路径。
  // 怎么让它红:把「doc 必须在 playbook 目录下真实存在」这条 existsSync 检查删掉,
  // loadPlaybooks 就不再 throw,测试失败。
  test('T-3 steps 引用不存在的文档被拒', () => {
    const cwd = makeTempCwd();
    writeProjectPlaybook(cwd, 'missing-doc', {
      name: 'missing-doc',
      steps: [{ doc: 'nope.md' }],
      acceptance: REAL_ACCEPTANCE,
    });
    expect(() => loadPlaybooks(cwd)).toThrow('[playbook:missing-doc] 步骤文档不存在: nope.md');
  });

  // T-3b:A-2 路径逃逸 —— `../evil.md` 解析后落在 playbook 目录外, 即便那个文件真实存在也要拒收
  // (不能只判"文件存不存在", 必须先判"落没落在目录内")。
  // 怎么让它红:把 A-2 检查换回 `join(playbookDir, doc)` + `existsSync` 的字符串前缀版
  // (不做 `relative().startsWith('..')` 的目录内判断), 这条测试会因为 loadPlaybooks 不再 throw 而失败
  // —— 因为 `../evil.md` 指向的文件是真实存在的。
  test('T-3b steps 路径逃逸出 playbook 目录被拒(即便目标文件真实存在)', () => {
    const cwd = makeTempCwd();
    // 逃逸目标: 放在 `.omd/playbooks/` 下 (playbook 目录的父目录), `../evil.md` 从 playbook 目录
    // 出发正好落在这里 —— 是"目录外但真实存在"的文件, 专门用来证伪字符串前缀判断。
    mkdirSync(join(cwd, PROJECT_PLAYBOOK_DIR), { recursive: true });
    writeFileSync(join(cwd, PROJECT_PLAYBOOK_DIR, 'evil.md'), '# 目录外的文件\n');
    writeProjectPlaybook(cwd, 'escape-doc', {
      name: 'escape-doc',
      steps: [{ doc: '../evil.md' }],
      acceptance: REAL_ACCEPTANCE,
    });
    expect(() => loadPlaybooks(cwd)).toThrow('[playbook:escape-doc] 步骤文档不存在: ../evil.md');
  });

  // T-4(反向自检就是本条):A-3 —— acceptance.command 在任何样本上都不失败(用 `echo` 而非 `true`,
  // `true` 不在 command-leaf 白名单里,用它会被闸拒当成"跑不起来"而不是"判据是虚的" —— 两件事不同,
  // 这里要测的是后者) → 必须被拒;一条真会在错样本上失败的 → 收。
  // 怎么让它红:把 probeAcceptanceSync 的判定从 `status === 'ok'` 松成"跑起来就算过",
  // 这条测试的第一个 expect 会失败(虚判据被放行)。
  test('T-4 恒真的 acceptance.command 被拒,真会失败的被收', () => {
    const cwd = makeTempCwd();
    writeProjectPlaybook(
      cwd,
      'vacuous-accept',
      {
        name: 'vacuous-accept',
        steps: [{ doc: 'ONLY.md' }],
        acceptance: {
          command: 'echo ok',
          negativeSample: { path: 'STATUS.md', content: 'anything' },
        },
      },
      { 'ONLY.md': '# 唯一步骤\n' },
    );
    expect(() => loadPlaybooks(cwd)).toThrow(
      '[playbook:vacuous-accept] acceptance.command 必须在 negativeSample 上以非零退出',
    );

    // 正对照:同形状但换一条真的会在错样本上失败的命令 —— 不该被拒。
    const cwd2 = makeTempCwd();
    writeProjectPlaybook(
      cwd2,
      'real-accept',
      {
        name: 'real-accept',
        steps: [{ doc: 'ONLY.md' }],
        acceptance: REAL_ACCEPTANCE,
      },
      { 'ONLY.md': '# 唯一步骤\n' },
    );
    const playbooks = loadPlaybooks(cwd2);
    expect(playbooks.get('real-accept')).toBeDefined();
  });

  // T-4b:A-3 基础设施错误(命令不在 command-leaf 白名单里, 相当于"命令不存在")必须拒收,
  // 且不得与"判据合格"折叠成一件事 —— 这正是上一版被打回的地方: 旧实现用
  // `execFileSync(...).catch { return true }`, 命令跑不起来时抛出的异常和"命令真的非零退出"
  // 走的是同一个 catch, 结果不可执行的判据被当成合格判据放行。
  // 怎么让它红:把 probeAcceptanceSync 对 `verdict.status === 'fail_open'` 的分支也判成 true
  // (与 'ok' 折叠),这条测试会因为不可执行的判据被放行而失败。
  test('T-4b 命令不在白名单(跑不起来)的 acceptance.command 被拒, 不与合格非零折叠', () => {
    const cwd = makeTempCwd();
    writeProjectPlaybook(
      cwd,
      'unrunnable-accept',
      {
        name: 'unrunnable-accept',
        steps: [{ doc: 'ONLY.md' }],
        acceptance: {
          // 首 token 不在 DEFAULT_COMMAND_ALLOWLIST 里 —— command-leaf 直接闸拒, 命令根本没跑,
          // 与"跑了但非零退出"是两件事, 必须走拒收路径而不是被当成"合格非零"放行。
          command: 'this-binary-does-not-exist-xyz --version',
          negativeSample: { path: 'STATUS.md', content: 'anything' },
        },
      },
      { 'ONLY.md': '# 唯一步骤\n' },
    );
    expect(() => loadPlaybooks(cwd)).toThrow(
      '[playbook:unrunnable-accept] acceptance.command 必须在 negativeSample 上以非零退出',
    );
  });

  // T-5:内置那份 playbook 自己过全部闸 —— loadPlaybooks 在干净(无 `.omd/playbooks` 覆盖)的
  // 仓库根 cwd 上不抛,且含内置的 `documentation-coverage`。
  // 怎么让它红:把内置 `templates/playbooks/documentation-coverage/playbook.json` 里的
  // maxRounds 改成 11(或删掉某个引用文档),这条测试会因 loadPlaybooks 抛错而失败。
  test('T-5 内置 playbook 在干净 cwd 上加载成功', () => {
    const playbooks = loadPlaybooks(process.cwd());
    expect(() => playbooks).not.toThrow();
    expect(playbooks.get('documentation-coverage')).toBeDefined();
  });
});
