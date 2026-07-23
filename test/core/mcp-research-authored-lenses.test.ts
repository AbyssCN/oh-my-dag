/**
 * test/core/mcp-research-authored-lenses.test.ts — A① 领域自适应镜头。
 *
 * dag_research 主路径的分解器 = conductor (author-spec): 按 question 自适应出领域专家镜头,
 * 判领域本就是 conductor 职责。author 失败/超时 → fail-open 回落固定 DEFAULT_COUNCIL_DEEP_LENSES。
 * 经 createDefaultResearchFanout 的 _authorFanoutSpec / _researchFanout 注入口测,不打 live 模型。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultResearchFanout } from '../../src/mcp/assemble';
import { DEFAULT_COUNCIL_DEEP_LENSES } from '../../src/harness/plan/best-of-n';
import type { ResearchFanoutConfig, ResearchFanoutResult } from '../../src/harness/research/fanout';

const fakeResult = (): ResearchFanoutResult =>
  ({
    final: 'answer',
    lensChampions: [],
    synthCandidates: [],
    judgeCritiques: [],
    fusionAnalysis: '',
    leafCount: 1,
    costStats: { totalUsd: 0, totalSavingsUsd: 0 },
  }) as unknown as ResearchFanoutResult;

describe('dag_research A① 领域自适应镜头', () => {
  test('conductor (author-spec) 出的领域镜头透传给 fanout', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-research-'));
    let captured: ResearchFanoutConfig | undefined;
    const authored = {
      question: 'x',
      groundTruth: 'x',
      lenses: [{ key: 'cpa', persona: '注册会计师', subAngles: ['税务合规'] }],
      synthesisFramings: [{ key: 'f', framing: 'g' }],
      judgeCriteria: [{ key: 'c', criterion: 'd' }],
      lensModel: 'm',
      reasonModel: 'm',
    } as unknown as ResearchFanoutConfig;
    const fanout = createDefaultResearchFanout({
      cwd,
      env: {} as NodeJS.ProcessEnv,
      _authorFanoutSpec: async () => authored,
      _researchFanout: async (cfg) => {
        captured = cfg;
        return fakeResult();
      },
    });

    await fanout({ question: '会计问题 X' });
    // 领域镜头(注册会计师)透传,未走固定 mvp/risk/first-principles。
    expect(captured?.lenses.map((l) => l.key)).toEqual(['cpa']);
  });

  test('author 抛错 → fail-open 回落固定 DEFAULT_COUNCIL_DEEP_LENSES', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-research-'));
    let captured: ResearchFanoutConfig | undefined;
    const fanout = createDefaultResearchFanout({
      cwd,
      env: {} as NodeJS.ProcessEnv,
      _authorFanoutSpec: async () => {
        throw new Error('author 挂了');
      },
      _researchFanout: async (cfg) => {
        captured = cfg;
        return fakeResult();
      },
    });

    await fanout({ question: '泛化设计问题' });
    // author 失败不崩,回落固定镜头集(零回归)。
    expect(captured?.lenses.map((l) => l.key)).toEqual(DEFAULT_COUNCIL_DEEP_LENSES.map((l) => l.key));
  });
});
