import { expect, it } from 'vitest';
import { loadLabels, loadPairs, parseOptions } from '../src/evals/judge-experiment.ts';
import { jevQuestions } from '../src/evals/jev.ts';

it('keeps calibration and validation source groups separate, balanced, and free of answer keys', async () => {
  const train = await loadPairs(parseOptions(['--dataset=jev']));
  const validation = await loadPairs(parseOptions(['--dataset=jev', '--validation']));
  const groups = new Set(train.pairs.map((p) => p.sourceGroup));
  expect(groups.size).toBeGreaterThanOrEqual(7);
  expect(validation.pairs.every((p) => !groups.has(p.sourceGroup))).toBe(true);
  expect(validation.pairs.every((p) => !train.pairs.some((t) => t.report === p.report))).toBe(true);
  for (const [dataset, file] of [
    [train, 'examples/jev-provisional-labels.json'],
    [validation, 'examples/jev-validation-provisional-labels.json'],
  ] as const) {
    const labels = await loadLabels(file, dataset.pairs, {});
    expect(Object.keys(labels).sort()).toEqual(dataset.pairs.map((p) => p.id).sort());
    expect(Object.values(labels).filter((l) => l === 'pass')).toHaveLength(
      dataset.pairs.length / 2,
    );
    for (const pair of dataset.pairs) {
      expect(pair.sourceGroup).toBeTruthy();
      expect(pair.slice).toBeTruthy();
      expect(pair.claim).toBeTruthy();
      expect(Object.keys(jevQuestions(pair))).toHaveLength(7);
      expect(pair).not.toHaveProperty('human');
      expect(pair).not.toHaveProperty('expected');
    }
  }
});
