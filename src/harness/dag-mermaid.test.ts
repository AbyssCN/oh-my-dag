import { describe, expect, test } from 'bun:test';
import { planToMermaid } from './dag-mermaid';
import type { ConductorPlan } from './conductor-plan';

const plan: ConductorPlan = {
  name: 'demo',
  nodes: {
    'fetch-a': { executor: 'command', command: 'curl a', goal: 'fetch source A' },
    'fetch-b': { executor: 'command', command: 'curl b', goal: 'fetch source B' },
    synth: { executor: 'leaf', goal: 'merge findings', depends_on: ['fetch-a', 'fetch-b'] },
    review: { executor: 'agent', goal: 'verify merged doc', depends_on: ['synth', 'ghost'] },
  },
};

describe('planToMermaid', () => {
  test('declares every node with executor-specific shape', () => {
    const src = planToMermaid(plan);
    expect(src.startsWith('flowchart TD')).toBe(true);
    expect(src).toContain('fetch_a[["fetch-a: fetch source A"]]'); // command → double box
    expect(src).toContain('synth["synth: merge findings"]'); // inproc leaf → box
    expect(src).toContain('review(["review: verify merged doc"])'); // agent → rounded
  });

  test('draws edges only for known deps (tolerates bad refs)', () => {
    const src = planToMermaid(plan);
    expect(src).toContain('fetch_a --> synth');
    expect(src).toContain('fetch_b --> synth');
    expect(src).toContain('synth --> review');
    expect(src).not.toContain('ghost');
  });

  test('marks failed nodes when status provided', () => {
    const src = planToMermaid(plan, { status: { synth: 'failed', 'fetch-a': 'done' } });
    expect(src).toContain('classDef failed');
    expect(src).toContain('class synth failed');
  });

  test('LR direction and quote escaping', () => {
    const p: ConductorPlan = { name: 'q', nodes: { n1: { goal: 'say "hi"' } } };
    const src = planToMermaid(p, { direction: 'LR' });
    expect(src.startsWith('flowchart LR')).toBe(true);
    expect(src).toContain('#quot;hi#quot;');
  });
});
