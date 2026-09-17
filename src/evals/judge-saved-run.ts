import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as v from 'valibot';
import { cases, type Expected } from './cases.ts';
import { SnapshotSchema, newIssues, type IssueDraft } from '../tracker.ts';
import { gradeOutcome } from './grades.ts';
import { RunIdSchema, RunSchema } from './schemas.ts';
import { errorMessage, parseJson } from '../json.ts';
import type { Pair } from './judge-experiment.ts';

const ExpectedSchema = v.variant('action', [
  v.object({
    action: v.literal('create'),
    feature: v.picklist(['issue-search', 'saved-search-export', 'notifications']),
  }),
  v.object({ action: v.literal('comment'), issueId: v.string() }),
  v.object({ action: v.picklist(['clarify', 'no-write']) }),
]);
const TrialSchema = v.object({
  schemaVersion: v.literal(1),
  trialId: RunIdSchema,
  experimentId: RunIdSchema,
  evidence: v.picklist(['live', 'scripted-provider']),
  fixture: v.string(),
  fault: v.string(),
  policyVersion: v.string(),
  policyHash: v.string(),
  input: v.union([v.string(), v.array(v.string())]),
  execution: v.picklist(['completed', 'error']),
  scenario: v.optional(v.nullable(v.object({ caseId: v.string(), expected: ExpectedSchema }))),
  output: v.object({
    before: SnapshotSchema,
    after: SnapshotSchema,
    reply: v.string(),
    turns: v.array(v.object({ reply: v.string(), after: SnapshotSchema })),
  }),
});
export function sampled(id: string, seed: string, fraction: number) {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1)
    throw new Error('Invalid sample fraction.');
  const value = createHash('sha256')
    .update(JSON.stringify([seed, id]))
    .digest()
    .readUInt32BE(0);
  return value / 2 ** 32 < fraction;
}
type Selection = {
  file: string;
  trialId: string | null;
  caseId?: string;
  evidence?: string;
  status:
    | 'selected'
    | 'not_sampled'
    | 'not_applicable'
    | 'outcome_failure'
    | 'execution_error'
    | 'invalid';
  reason?: string;
  scenarioSource?: string;
  policyHash?: string;
  structuralGrades?: ReturnType<typeof gradeOutcome>;
};
export async function loadSavedRun(root: string, runId: string, fraction: number, seed: string) {
  v.parse(RunIdSchema, runId);
  const plan = v.parse(
    RunSchema,
    parseJson(await readFile(join(root, 'runs', runId, 'run.json'), 'utf8')),
  );
  if (plan.runId !== runId) throw new Error('Run archive ID mismatch.');
  const pairs: Pair[] = [];
  const samples: {
    id: string;
    evidence: string;
    messages: { role: 'user'; text: string }[];
    issue: IssueDraft;
  }[] = [];
  const manifest: Selection[] = [];
  const unreadableArtifacts: { file: string; error: string }[] = [];
  const seen = new Set<string>();
  let matchingArtifacts = 0;
  for (const name of (await readdir(join(root, 'trials')))
    .filter((n) => n.endsWith('.json'))
    .sort()) {
    const file = join(root, 'trials', name);
    let raw: unknown;
    try {
      raw = parseJson(await readFile(file, 'utf8'));
    } catch (error) {
      unreadableArtifacts.push({ file, error: errorMessage(error) });
      continue;
    }
    const envelope = v.safeParse(
      v.object({ experimentId: v.optional(v.nullable(v.string())) }),
      raw,
    );
    if (!envelope.success || envelope.output.experimentId !== runId) continue;
    matchingArtifacts++;
    let trial: v.InferOutput<typeof TrialSchema>;
    try {
      trial = v.parse(TrialSchema, raw);
    } catch (error) {
      manifest.push({ file, trialId: null, status: 'invalid', reason: errorMessage(error) });
      continue;
    }
    if (seen.has(trial.trialId) || name !== `${trial.trialId}.json`) {
      manifest.push({
        file,
        trialId: trial.trialId,
        status: 'invalid',
        reason: 'Duplicate trial ID or filename mismatch.',
      });
      continue;
    }
    seen.add(trial.trialId);
    const entry: Selection = {
      file,
      trialId: trial.trialId,
      evidence: trial.evidence,
      policyHash: trial.policyHash,
      status: 'invalid',
    };
    manifest.push(entry);
    if (trial.execution === 'error') {
      entry.status = 'execution_error';
      entry.reason = 'Application or cleanup failed; no semantic grade.';
      continue;
    }
    const turns = typeof trial.input === 'string' ? [trial.input] : trial.input;
    let expected: Expected;
    if (trial.scenario) {
      if (!plan.cases.includes(trial.scenario.caseId)) {
        entry.reason = 'Recorded case is absent from run plan.';
        continue;
      }
      expected = trial.scenario.expected;
      entry.caseId = trial.scenario.caseId;
      entry.scenarioSource = 'captured-with-trial';
    } else {
      // Legacy inference is explicit and requires an exact, unique match. Never guess from reply text.
      const matches = cases.filter(
        (c) =>
          plan.cases.includes(c.id) &&
          c.fixture === trial.fixture &&
          (c.fault ?? 'none') === trial.fault &&
          JSON.stringify(c.turns) === JSON.stringify(turns),
      );
      if (matches.length !== 1) {
        entry.reason = 'Legacy artifact has no unique match in current case catalog.';
        continue;
      }
      expected = matches[0].expected;
      entry.caseId = matches[0].id;
      entry.scenarioSource =
        'legacy-inference-from-current-case-catalog; verify expectations have not changed';
    }
    entry.structuralGrades = gradeOutcome(trial.output, expected);
    if (expected.action !== 'create') {
      const failed = entry.structuralGrades.some((g) => g.status === 'fail');
      entry.status = failed ? 'outcome_failure' : 'not_applicable';
      entry.reason = failed
        ? 'Stored state failed the required outcome.'
        : 'This judge evaluates newly created issues; no new issue was required.';
      continue;
    }
    const created = newIssues(trial.output.before, trial.output.after);
    if (created.length !== 1) {
      entry.status = 'outcome_failure';
      entry.reason = 'Required single new issue is missing or ambiguous.';
      continue;
    }
    const id = trial.trialId;
    entry.status = sampled(`${runId}/${id}`, seed, fraction) ? 'selected' : 'not_sampled';
    if (entry.status === 'selected') {
      const issue = created[0];
      const { title, feature, reproduction, expected: expectedText, observed } = issue;
      samples.push({
        id,
        evidence: trial.evidence,
        messages: turns.map((text) => ({ role: 'user', text })),
        issue: { title, feature, reproduction, expected: expectedText, observed },
      });
      pairs.push({
        id,
        report: turns.join('\n\n'),
        issue: JSON.stringify({
          title: issue.title,
          feature: issue.feature,
          reproduction: issue.reproduction,
          expected: issue.expected,
          observed: issue.observed,
        }),
      });
    }
  }
  const missingArtifacts = Math.max(0, plan.planned - matchingArtifacts);
  const extraArtifacts = Math.max(0, matchingArtifacts - plan.planned);
  const counts = Object.fromEntries(
    [
      'selected',
      'not_sampled',
      'not_applicable',
      'outcome_failure',
      'execution_error',
      'invalid',
    ].map((status) => [status, manifest.filter((m) => m.status === status).length]),
  );
  return {
    pairs,
    samples,
    provenance: {
      kind: 'saved-application-run',
      plan,
      manifest,
      sampling: {
        fraction,
        seed,
        algorithm: 'sha256(seed, runId/trialId), first unsigned 32 bits / 2^32',
        population: 'completed trials requiring a new issue and containing exactly one new issue',
        note: 'Replay of saved evidence; not a deployed live monitor. Scripted-provider provenance is retained.',
      },
      counts,
      matchingArtifacts,
      missingArtifacts,
      extraArtifacts,
      unreadableArtifacts,
    },
    evidenceErrors:
      missingArtifacts +
      extraArtifacts +
      unreadableArtifacts.length +
      manifest.filter((m) => ['invalid', 'execution_error'].includes(m.status)).length,
  };
}
