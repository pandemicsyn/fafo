import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadSavedRun, sampled } from '../src/evals/judge-saved-run.ts';
import { recordings } from '../src/evals/recordings.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup(planned = 1) {
  const root = await mkdtemp(join(tmpdir(), 'fafo-judge-'));
  roots.push(root);
  await mkdir(join(root, 'runs', 'test-run'), { recursive: true });
  await mkdir(join(root, 'trials'));
  await writeFile(
    join(root, 'runs', 'test-run', 'run.json'),
    JSON.stringify({
      runId: 'test-run',
      planned,
      cases: ['new-search'],
      repetitions: planned,
      startedAt: '2026-09-17',
      health: { ready: true, model: 'test', policyVersion: 'test', credentialsConfigured: true },
    }),
  );
  return root;
}
function artifact(recording = 'correct-paraphrase') {
  const record = recordings().find((r) => r.id === recording);
  if (!record) throw new Error('Missing fixture.');
  return {
    schemaVersion: 1,
    trialId: 'trial-one',
    experimentId: 'test-run',
    evidence: 'live',
    fixture: 'clear-new-report',
    fault: 'none',
    policyVersion: 'test',
    policyHash: 'test',
    execution: 'completed',
    input: record.input,
    output: record.output,
    scenario: { caseId: 'new-search', expected: { action: 'create', feature: 'issue-search' } },
  };
}
it('selects actual stored issue fields and retains application provenance', async () => {
  const root = await setup();
  const trial = artifact();
  await writeFile(join(root, 'trials', 'trial-one.json'), JSON.stringify(trial));
  const result = await loadSavedRun(root, 'test-run', 1, 'seed');
  expect(result.pairs).toHaveLength(1);
  expect(result.pairs[0].issue).toContain('reproduction');
  expect(result.pairs[0].issue).not.toContain('Filed ISS-1');
  expect(result.samples[0].issue.reproduction).toBe(trial.output.after.issues[0].reproduction);
  expect(result.samples[0].messages).toEqual([{ role: 'user', text: trial.input }]);
  expect(result.provenance.manifest[0]).toMatchObject({
    status: 'selected',
    evidence: 'live',
    scenarioSource: 'captured-with-trial',
  });
  expect((await loadSavedRun(root, 'test-run', 0, 'seed')).provenance.counts.not_sampled).toBe(1);
});
it('does not send missing writes, execution failures or inapplicable outputs to Jev', async () => {
  const root = await setup();
  await writeFile(
    join(root, 'trials', 'trial-one.json'),
    JSON.stringify(artifact('convincing-no-write')),
  );
  expect((await loadSavedRun(root, 'test-run', 1, 'seed')).provenance.counts.outcome_failure).toBe(
    1,
  );
  await writeFile(
    join(root, 'trials', 'trial-one.json'),
    JSON.stringify({ ...artifact(), execution: 'error' }),
  );
  const failed = await loadSavedRun(root, 'test-run', 1, 'seed');
  expect(failed.pairs).toEqual([]);
  expect(failed.evidenceErrors).toBe(1);
  await writeFile(
    join(root, 'trials', 'trial-one.json'),
    JSON.stringify({
      ...artifact('convincing-no-write'),
      scenario: { caseId: 'new-search', expected: { action: 'clarify' } },
    }),
  );
  expect((await loadSavedRun(root, 'test-run', 1, 'seed')).provenance.counts.not_applicable).toBe(
    1,
  );
});
it('accounts for absent and corrupt evidence and rejects unsafe run paths', async () => {
  const root = await setup(2);
  await writeFile(join(root, 'trials', 'trial-one.json'), JSON.stringify(artifact()));
  expect((await loadSavedRun(root, 'test-run', 1, 'seed')).provenance.missingArtifacts).toBe(1);
  await writeFile(join(root, 'trials', 'broken.json'), 'broken');
  expect(
    (await loadSavedRun(root, 'test-run', 1, 'seed')).provenance.unreadableArtifacts,
  ).toHaveLength(1);
  await expect(loadSavedRun(root, '../test-run', 1, 'seed')).rejects.toThrow();
});
it('samples reproducibly independently of ordering, including exact 0 and 1 boundaries', () => {
  const ids = Array.from({ length: 100 }, (_, i) => `run/trial-${i}`);
  const select = (values: string[]) => values.filter((id) => sampled(id, 'seed', 0.2)).sort();
  expect(select(ids)).toEqual(select([...ids].reverse()));
  expect(select(ids).length).toBeGreaterThan(0);
  expect(select(ids).length).toBeLessThan(100);
  expect(ids.every((id) => sampled(id, 'seed', 1))).toBe(true);
  expect(ids.some((id) => sampled(id, 'seed', 0))).toBe(false);
});
