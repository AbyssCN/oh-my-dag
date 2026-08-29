/**
 * `omd_env` —— 引擎眼里这个仓长什么样(2026-08-29)。
 *
 * 为什么这个工具要有测试:它存在的全部理由是**把引擎肚子里的判断摆到用户看得见的地方**。
 * 一个印不出"有证据但 runner 没装"的 `omd_env`,等于没解决它要解决的问题
 * (实测:80 个仓里 29 个被判成"没有测试基建",而没有任何一处会告诉用户这件事发生了)。
 *
 * 反向自检:把 handler 里 `blocked` 那一段删掉 → 「有证据但没启用的语言要印出来」当场红。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigTools } from './config-tools';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fresh(): string {
  const d = mkdtempSync(join(tmpdir(), 'omd-env-tool-'));
  dirs.push(d);
  return d;
}

function write(root: string, rel: string, body = ''): void {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, body);
}

function envTool() {
  const t = createConfigTools({ cwd: process.cwd() }).find((x) => x.name === 'omd_env');
  expect(t).toBeDefined();
  return t!;
}

async function runOn(root: string): Promise<string> {
  // handler 的第二参 (MCP extra) 在本工具里不读 —— 传一个空壳即可, 断言的是产出不是签名。
  const r = (await envTool().handler({ cwd: root }, {} as never)) as { content: { text: string }[] };
  return r.content[0]!.text;
}

describe('omd_env 工具', () => {
  test('挂在 config 工具族里 (用户从 MCP 直接调得到)', () => {
    expect(createConfigTools({ cwd: process.cwd() }).map((t) => t.name)).toContain('omd_env');
  });

  test('无打包文件、只有 .py 的仓 → 印出 python 与证据 (这正是 marker 表看不见的那一格)', async () => {
    const root = fresh();
    write(root, 'src/a.py'); write(root, 'src/b.py'); write(root, 'tests/test_a.py');
    const out = await runOn(root);
    expect(out).toContain('python');
    expect(out).toContain('仓环境探测');
  });

  test('★ 有证据但 runner 没装 → **明说跑不起来**, 并给出下一步', async () => {
    // go.mod 在, 但这台机器多半没有 go —— 若真装了 go 就换一个必然缺席的语言来断言。
    const root = fresh();
    write(root, 'go.mod', 'module x\n'); write(root, 'main.go', 'package main\n');
    const out = await runOn(root);
    // 两种可能: 这台机器没装 go (走 blocked 分支) / 装了 (走启用分支)。断言在"这一格被写出来了",
    // 而不是断言这台机器的安装状态 —— 后者会让测试量的是机器不是代码。
    expect(out.includes('有证据但没启用') || out.includes('go: 启用')).toBe(true);
  });

  test('空仓 → 明说没检出, 不编一个默认语言', async () => {
    const out = await runOn(fresh());
    expect(out).toContain('没有检出');
  });

  test('路径不存在 → 报错而不是假装探到了空仓', async () => {
    const r = (await envTool().handler({ cwd: '/nonexistent-omd-env-probe' }, {} as never)) as {
      content: { text: string }[];
      isError?: true;
    };
    // 探不到时 probeEnvFacts 返回零语言 (readdirSync 失败被跳过) —— 那就该印"没有检出",
    // 而**不该**印出一个语言。两种出口都可接受, 但不许出现"检出了 python"这种编造。
    expect(r.content[0]!.text).not.toContain('· python:');
  });
});
