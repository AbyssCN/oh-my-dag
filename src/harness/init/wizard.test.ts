/**
 * wizard preset 流测试: 脚本化 WizardIO 驱动 "基础档" (档① base-opencode-go),
 * 断言写入的 env key 矩阵 + persistMultimodalPool(Premium) / persistRoleModel 落 config 调用。
 */
import { describe, expect, test } from 'bun:test';
import type { WizardIO, PresetPersistDeps } from './wizard';
import { runInitWizard, applyRolePreset, upsertEnv } from './wizard';
import { ROLE_PRESETS } from './role-presets';

/** 脚本化 IO: select/ask/confirm 按队列出答案, note 收集。 */
function scriptedIO(script: {
  selects: Array<string | undefined>;
  asks: string[];
  confirms: boolean[];
}): { io: WizardIO; notes: string[]; askLog: string[] } {
  const notes: string[] = [];
  const askLog: string[] = [];
  const io: WizardIO = {
    select: async () => script.selects.shift(),
    ask: async (question, opts) => {
      askLog.push(question);
      const v = script.asks.shift() ?? '';
      return v || opts?.defaultValue || '';
    },
    confirm: async () => script.confirms.shift() ?? false,
    note: (m) => {
      notes.push(m);
    },
  };
  return { io, notes, askLog };
}

function fakePersist(): {
  persist: PresetPersistDeps;
  calls: {
    apis: string[];
    pools: string[][];
    premiums: string[][];
    roles: Array<[string, string]>;
  };
} {
  const calls = {
    apis: [] as string[],
    pools: [] as string[][],
    premiums: [] as string[][],
    roles: [] as Array<[string, string]>,
  };
  return {
    calls,
    persist: {
      persistCustomApi: (def) => calls.apis.push(def.id),
      persistMultimodalPool: (coords) => calls.pools.push(coords),
      persistMultimodalPoolPremium: (coords) => calls.premiums.push(coords),
      persistRoleModel: (role, coord) => calls.roles.push([role, coord]),
    },
  };
}

const okFetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;

describe('runInitWizard · preset 档① (base-opencode-go)', () => {
  test('写全套角色矩阵 env + 网关双层多模态池 + verifier config 角色', async () => {
    const base = ROLE_PRESETS[0]!;
    expect(base.id).toBe('base-opencode-go');
    const { io, notes } = scriptedIO({
      // ① provider=deepseek → ④ model 选 → ⑥ preset 档①
      selects: ['deepseek', 'deepseek-v4-pro', base.id],
      // ② key → ③ base(回车默认) → keyPrompt: OPENCODE_API_KEY
      asks: ['ds-key', '', 'oc-key'],
      confirms: [false], // ⑤ web 搜索跳过
    });
    const { persist, calls } = fakePersist();
    let written = '';
    const env: Record<string, string | undefined> = {};

    const result = await runInitWizard({
      io,
      env,
      cwd: '/tmp/fake',
      writeEnv: (_p, c) => {
        written = c;
      },
      fetchImpl: okFetch,
      persist,
    });

    expect(result).not.toBeNull();
    // 角色矩阵 env 全写入
    for (const key of Object.keys(base.env)) expect(result!.writtenKeys).toContain(key);
    expect(result!.writtenKeys).toContain('OPENCODE_API_KEY');
    // .env 内容含 preset 值 (一把网关 key, 多家族坐标)
    expect(written).toContain('OMD_CG_CONDUCTOR_MODEL=opencode-go:deepseek-v4-flash');
    expect(written).toContain('OMD_PLAN_MODEL=opencode-go:deepseek-v4-pro');
    expect(written).toContain('OMD_CG_AGENT_MODEL=opencode-go:qwen3.7-plus');
    expect(written).toContain('OMD_REDUCE_MODEL=opencode-go:glm-5.2');
    expect(written).toContain('OPENCODE_API_KEY=oc-key');
    // config.json 写入口: 双层多模态池 + verifier 跨家族 + opencode-go 端点注册
    expect(calls.pools).toEqual([['opencode-go:qwen3.7-plus']]);
    expect(calls.premiums).toEqual([['opencode-go:glm-5.2']]);
    expect(calls.roles).toEqual([['verifier', 'opencode-go:glm-5.2']]);
    expect(calls.apis).toEqual(['opencode-go']);
    // 汇总表出现
    expect(notes.some((n) => n.includes('角色矩阵'))).toBe(true);
    expect(notes.some((n) => n.includes('multimodalPoolPremium'))).toBe(true);
  });
});

describe('applyRolePreset · key 跳过闸', () => {
  test('档① OPENCODE key 回车跳过 → 双层池 / verifier config 均不写', async () => {
    const base = ROLE_PRESETS[0]!;
    const { io } = scriptedIO({ selects: [], asks: [''], confirms: [] }); // OPENCODE 提示回车跳过
    const { persist, calls } = fakePersist();
    const updates: Record<string, string> = {};

    await applyRolePreset(base, updates, io, {}, persist);

    for (const [k, v] of Object.entries(base.env)) expect(updates[k]).toBe(v);
    expect(updates.OPENCODE_API_KEY).toBeUndefined();
    expect(calls.pools).toEqual([]);
    expect(calls.premiums).toEqual([]);
    expect(calls.roles).toEqual([]);
  });

  test('档② (cn-standard) 无贵层池 → premium 不调用, mimo 池 + verifier 写入', async () => {
    const standard = ROLE_PRESETS[1]!;
    expect(standard.id).toBe('cn-standard');
    const { io } = scriptedIO({ selects: [], asks: ['mimo-key'], confirms: [] });
    const { persist, calls } = fakePersist();
    const updates: Record<string, string> = { DEEPSEEK_API_KEY: 'ds' };

    await applyRolePreset(standard, updates, io, {}, persist);

    expect(updates.OMD_PLAN_MODEL).toBe('deepseek:deepseek-v4-pro');
    expect(updates.OMD_LENS_MODEL).toBe('deepseek:deepseek-v4-flash');
    expect(calls.apis).toEqual([]); // 档②无自定 API
    expect(calls.pools).toEqual([['mimo:mimo-2.5']]);
    expect(calls.premiums).toEqual([]); // premium 空 → 不写
    expect(calls.roles).toEqual([['verifier', 'mimo:mimo-2.5']]);
  });

  test('档③ (cn-ultimate) 注册 kimi/qwen/zhipu + ZHIPU key 跳过 → premium 剔除 zhipu 剩 kimi', async () => {
    const ultimate = ROLE_PRESETS[2]!;
    expect(ultimate.id).toBe('cn-ultimate');
    // keyPrompts 顺序: KIMI / QWEN / ZHIPU / DEEPSEEK / MIMO — ZHIPU 回车跳过
    const { io } = scriptedIO({
      selects: [],
      asks: ['kimi-key', 'qwen-key', '', 'ds-key', 'mimo-key'],
      confirms: [],
    });
    const { persist, calls } = fakePersist();
    const updates: Record<string, string> = {};

    await applyRolePreset(ultimate, updates, io, {}, persist);

    expect(calls.apis).toEqual(['kimi', 'qwen', 'zhipu']);
    // env 不受 key 闸影响: review Spec 轴坐标 + router 池照写
    expect(updates.OMD_REVIEW_SPEC_MODEL).toBe('zhipu:glm-5.2');
    expect(updates.OMD_ROUTER_POOL_INPROC).toBe('qwen:qwen3.7-plus,mimo:mimo-2.5-pro-ultraspeed');
    expect(updates.OMD_ROUTER_POOL_AGENT).toBe('qwen:qwen3.7-plus,qwen:qwen3.7-max');
    // 便宜层全保留; 贵层剔除 zhipu (key 跳过) 剩 kimi
    expect(calls.pools).toEqual([['qwen:qwen3.7-plus', 'mimo:mimo-2.5-pro-ultraspeed']]);
    expect(calls.premiums).toEqual([['kimi:kimi-k3']]);
    expect(calls.roles).toEqual([['verifier', 'qwen:qwen3.7-max']]);
  });
});

describe('upsertEnv 与 preset 值', () => {
  test('preset 值 upsert 进已有 .env 不破坏其余行', () => {
    const before = '# comment\nDEEPSEEK_API_KEY=old\nOMD_PLAN_MODEL=x:y\n';
    const after = upsertEnv(before, { OMD_PLAN_MODEL: 'deepseek:deepseek-v4-pro', OMD_JUDGE_MODEL: 'deepseek:deepseek-v4-pro' });
    expect(after).toContain('# comment');
    expect(after).toContain('DEEPSEEK_API_KEY=old');
    expect(after).toContain('OMD_PLAN_MODEL=deepseek:deepseek-v4-pro');
    expect(after).toContain('OMD_JUDGE_MODEL=deepseek:deepseek-v4-pro');
  });
});
