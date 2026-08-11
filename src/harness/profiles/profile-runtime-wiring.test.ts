import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createAgentLeafRunner } from '../agent-leaf';
import { leafWorkerPayload } from '../hooks/sandboxed-leaf';
import { runLeafWorkerPayload } from '../leaf-worker';
import { defaultSkillRoots, loadSkillSourceByName, skillsRoot } from '../skills/skills';
import { type LeafProfile } from './profile';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const profile: LeafProfile = {
  name: 'runtime-reviewer',
  seat: 'claude-code:claude-fable-5',
  persona: 'PROFILE PERSONA SENTINEL',
  skills: ['runtime-review-skill'],
  tools: ['read'],
};

const asst = (text: string): SDKMessage => ({
  type: 'assistant',
  session_id: 's',
  message: {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 10, output_tokens: 2 },
    stop_reason: 'end_turn',
  },
}) as unknown as SDKMessage;
const success = (): SDKMessage =>
  ({ type: 'result', subtype: 'success', result: 'done', session_id: 's', usage: {} }) as unknown as SDKMessage;

describe('profile 调用期接缝', () => {
  test('sandbox JSON → leaf-worker → runner: input.profile 原样透传, 不烤进 opts', async () => {
    const input = { prompt: 'review', model: 'explicit:model', profile };
    const encoded = JSON.stringify(leafWorkerPayload({ hashlineEdit: true }, input));
    const decoded = JSON.parse(encoded) as ReturnType<typeof leafWorkerPayload>;
    let seenInput: typeof input | undefined;
    let seenOpts: Record<string, unknown> | undefined;

    const result = await runLeafWorkerPayload(decoded, {
      createRunner: (opts) => {
        seenOpts = opts as unknown as Record<string, unknown>;
        return async (actual) => {
          seenInput = actual as typeof input;
          return { text: 'ok', usage: { in: 1, out: 1 } };
        };
      },
    });

    expect(result.text).toBe('ok');
    expect(decoded.input.profile).toEqual(profile);
    expect(decoded.opts.profile).toBeUndefined();
    expect(seenInput?.profile).toEqual(profile);
    expect(seenInput?.model).toBe('explicit:model');
    expect(seenOpts?.profile).toBeUndefined();
  });

  test('agent-leaf 按调用注入 persona/skill/tools, 显式 model 胜 seat, promptVersion 不含 profile 内容', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-profile-runtime-'));
    roots.push(cwd);
    const skillRoot = join(cwd, 'skills');
    mkdirSync(join(skillRoot, 'runtime-review-skill'), { recursive: true });
    writeFileSync(
      join(skillRoot, 'runtime-review-skill', 'SKILL.md'),
      '---\nname: runtime-review-skill\ndescription: runtime test\n---\nSKILL BODY SENTINEL\n',
    );
    const prompts: string[] = [];
    const options: Options[] = [];
    const sdkQueryFn = (props: { prompt: string; options: Options }) => {
      prompts.push(props.prompt);
      options.push(props.options);
      return (async function* () {
        yield asst('ok');
        yield success();
      })();
    };
    const run = createAgentLeafRunner({
      cwd,
      skillDeps: { roots: [skillRoot] },
      driftDetector: false,
      sdkQueryFn,
    });
    const explicitModel = 'claude-code:claude-sonnet-5';
    const baseline = await run({ prompt: 'same task', model: explicitModel });
    const profiled = await run({ prompt: 'same task', model: explicitModel, profile });

    expect(prompts[0]).not.toContain('PROFILE PERSONA SENTINEL');
    expect(prompts[1]).toContain('PROFILE PERSONA SENTINEL');
    expect(prompts[1]).toContain('[skill runtime-review-skill]\nSKILL BODY SENTINEL');
    expect(options[1]?.model).toBe('claude-sonnet-5');
    expect(options[0]?.allowedTools).toContain('mcp__omd__write');
    expect(options[1]?.allowedTools).toContain('mcp__omd__read');
    expect(options[1]?.allowedTools).not.toContain('mcp__omd__write');
    expect(profiled.promptVersion).toBe(baseline.promptVersion);
  });

  test('ui-reviewer 在包内 skill root 可解析 (可移植兜底审核 skill)', () => {
    // 2026-08-11 集成修正: design-review 已换装 impeccable/huashu-design/taste-skill (f7a4c38,
    // vendor 于机器本地 .omd/skills, 测试环境不可断言); ui-reviewer 保留为包内可分发兜底
    // (task-profile-portability), 本测试钉的是包 skill root 的解析链本身。
    const cwd = mkdtempSync(join(tmpdir(), 'omd-profile-skill-root-'));
    roots.push(cwd);
    const source = loadSkillSourceByName('omd-ui-reviewer', defaultSkillRoots(cwd));
    expect(source).not.toBeNull();
    expect(source?.dir).toBe(join(skillsRoot(), 'omd-ui-reviewer'));
    expect(source?.files).toContain('SKILL.md');
    expect(source?.body).toContain('Judge rendered screenshots');
  });
});
