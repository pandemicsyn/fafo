import { expect, it } from 'vitest';
import {
  loadPairs,
  parseOptions,
  summarizeJudges,
  workload,
  type Evaluation,
} from '../src/evals/judge-experiment.ts';

it('rejects ambiguous options and invalid budgets before calling a model', () => {
  for (const args of [
    ['--repeat=0'],
    ['--repeat=6'],
    ['--accept=.9', '--reject=.1'],
    ['--judge=jev', '--compare=deepseek,jev'],
    ['--judge=jev,deepseek'],
    ['--compare=jev,jev'],
    ['--pairs=x', '--validation'],
    ['--dataset=unknown'],
    ['--wat'],
    ['--repeat=1', '--repeat=2'],
  ])
    expect(() => parseOptions(args)).toThrow();
  expect(() => parseOptions([], true)).toThrow('--run');
  expect(() => parseOptions(['--run=test', '--sample=2'], true)).toThrow('--sample');
});
it('accounts for batching requests, repeat grades', async () => {
  const options = parseOptions(['--judge=jev', '--dataset=jev', '--batching', '--repeat=2']);
  const { pairs, referenceLabels } = await loadPairs(options);
  expect(pairs).toHaveLength(18);
  expect(referenceLabels).toEqual({});
  expect(workload(pairs, options)).toEqual({
    pairs: 18,
    measuredGrades: 108,
    measuredRequests: 540,
  });
});
it('keeps review and error cases in coverage and includes every request in latency', () => {
  const base: Evaluation = {
    id: 'a',
    trial: 1,
    judge: 'jev',
    strategy: 'batched',
    referenceLabel: 'fail',
    status: 'completed',
    verdict: 'fail',
    durationMs: 100,
    evidence: null,
  };
  const [summary] = summarizeJudges([
    base,
    { ...base, id: 'b', referenceLabel: 'pass', verdict: 'review', durationMs: 200 },
    { ...base, id: 'c', status: 'error', verdict: null, durationMs: 300 },
  ]);
  expect(summary).toMatchObject({
    planned: 3,
    completed: 2,
    reviews: 1,
    errors: 1,
    automaticCoverage: 1 / 3,
    automaticAccuracy: 1,
    agreements: 1,
    falseAccepts: 0,
    allAttemptLatency: { medianMs: 200, maxMs: 300 },
    completedLatency: { medianMs: 150 },
  });
  expect(summarizeJudges([{ ...base, referenceLabel: null }])[0].automaticAccuracy).toBeNull();
});
