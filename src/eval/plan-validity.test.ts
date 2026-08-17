import { describe, expect, test } from 'bun:test';
import { parsePlan } from '../harness/conductor-plan';
import { measurePlanValidity } from './plan-validity';
import { renderRepeatLine } from './repeat';

const VALID_PLAN = JSON.stringify({
  name: 'valid-plan',
  nodes: { only: { goal: 'Do task' } },
});
const BAD_SHAPE_PLAN = JSON.stringify({ name: 'bad-shape', nodes: {} });

function collectSink(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line) => lines.push(line) };
}

describe('measurePlanValidity', () => {
  test('GWT 4: aggregates 2 tasks × 3 runs and renders every readout with frozen format', async () => {
    const calls = new Map<string, number>();
    const { lines: sinkLines, sink } = collectSink();
    const result = await measurePlanValidity({
      tasks: [
        { id: 'task-a', text: 'task A' },
        { id: 'task-b', text: 'task B' },
      ],
      n: 3,
      generate: async (task) => {
        const attempt = (calls.get(task) ?? 0) + 1;
        calls.set(task, attempt);
        return task === 'task B' && attempt === 2 ? 'Here is a prose answer, not JSON.' : VALID_PLAN;
      },
      sink,
    });

    expect(result.perTask).toHaveLength(2);
    expect(result.perTask[0]).toMatchObject({ id: 'task-a', agg: { n: 3, pass: 3, rate: 1 } });
    expect(result.perTask[1]).toMatchObject({ id: 'task-b', agg: { n: 3, pass: 2, rate: 2 / 3 } });
    expect(result.overall).toMatchObject({ n: 6, pass: 5, rate: 5 / 6 });
    expect(sinkLines).toHaveLength(6);

    expect(result.lines).toEqual([
      renderRepeatLine('plan-validity/task-a', result.perTask[0]!.agg),
      renderRepeatLine('plan-validity/task-b', result.perTask[1]!.agg),
      renderRepeatLine('plan-validity/_overall', result.overall),
    ]);
    expect(result.lines[0]).toContain('plan-validity/task-a');
    expect(result.lines[0]).toContain('n=3');
    expect(result.lines[0]).toContain('Wilson95');
    expect(result.lines[1]).toContain('plan-validity/task-b');
    expect(result.lines[1]).toContain('n=3');
    expect(result.lines[1]).toContain('Wilson95');
    expect(result.lines[2]).toContain('plan-validity/_overall');
    expect(result.lines[2]).toContain('n=6');
    expect(result.lines[2]).toContain('Wilson95');
  });

  test('GWT 5: thrown generate is error, while returned non-plan is invalid', async () => {
    let attempt = 0;
    const { lines: sinkLines, sink } = collectSink();
    const result = await measurePlanValidity({
      tasks: [{ id: 'mixed', text: 'task' }],
      n: 3,
      generate: async () => {
        attempt++;
        if (attempt === 2) throw new Error('model did not reply');
        return attempt === 3 ? 'This is not a plan.' : VALID_PLAN;
      },
      sink,
    });

    expect(attempt).toBe(3);
    expect(sinkLines.map((line) => JSON.parse(line).value)).toEqual([
      true,
      { error: 'model did not reply' },
      false,
    ]);
    expect(result.perTask[0]).toMatchObject({ id: 'mixed', agg: { n: 2, pass: 1, rate: 0.5 } });
    expect(result.overall).toMatchObject({ n: 2, pass: 1, rate: 0.5 });
    expect(result.lines).toEqual([
      renderRepeatLine('plan-validity/mixed', result.perTask[0]!.agg, 1),
      renderRepeatLine('plan-validity/_overall', result.overall, 1),
    ]);
    expect(result.lines[0]).toContain('n=2');
    expect(result.lines[0]).toContain('err=1');
    expect(result.lines[1]).toContain('err=1');
  });

  test('uses parsePlan validity: legal plan passes and bad-shape JSON fails', async () => {
    const parseOpts = { knownServers: new Set<string>() };
    expect(parsePlan(VALID_PLAN, parseOpts).ok).toBe(true);
    expect(parsePlan(BAD_SHAPE_PLAN, parseOpts).ok).toBe(false);

    const replies = [VALID_PLAN, BAD_SHAPE_PLAN];
    const { lines: sinkLines, sink } = collectSink();
    const result = await measurePlanValidity({
      tasks: [{ id: 'criterion', text: 'task' }],
      n: 2,
      generate: async () => replies.shift()!,
      sink,
    });

    expect(sinkLines.map((line) => JSON.parse(line).value)).toEqual([true, false]);
    expect(result.perTask[0]).toMatchObject({ id: 'criterion', agg: { n: 2, pass: 1, rate: 0.5 } });
    expect(result.overall).toMatchObject({ n: 2, pass: 1, rate: 0.5 });
  });
});