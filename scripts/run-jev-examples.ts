import { randomUUID } from 'node:crypto';
import { workedExamples, checksForRecordedMessages } from '../examples/jev-worked-examples.ts';
import { loadEnv } from '../src/config.ts';
import { errorMessage } from '../src/json.ts';
import {
  assessFocused,
  focusedPolicy,
  planFocusedExample,
  type FocusedExample,
} from '../src/evals/jev-focused.ts';
import { loadSavedRun } from '../src/evals/judge-saved-run.ts';
import { saveArtifact } from '../src/evals/artifacts.ts';

try {
  const options = new Map<string, string>();
  let dryRun = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === '--examples') continue;
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    const match = /^--(repeat|run|sample|seed)=(.+)$/.exec(arg);
    if (!match || options.has(match[1]))
      throw new Error(`Unknown or duplicate example option: ${arg}`);
    options.set(match[1], match[2]);
  }
  const repetitions = Number(options.get('repeat') ?? '1');
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3)
    throw new Error('--repeat must be 1..3.');
  const fraction = Number(options.get('sample') ?? '1');
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1)
    throw new Error('--sample must be 0..1.');
  if (!options.has('run') && (options.has('sample') || options.has('seed')))
    throw new Error('Sampling requires --run.');
  let examples: FocusedExample[] = workedExamples;
  let provenance: unknown = {
    kind: 'authored worked examples',
    labels: 'provisional author expectations, not human validation',
  };
  let evidenceErrors = 0;
  if (options.has('run')) {
    const saved = await loadSavedRun(
      'artifacts',
      options.get('run') ?? '',
      fraction,
      options.get('seed') ?? 'jev-post',
    );
    const ungraded: string[] = [];
    examples = saved.samples.flatMap((sample) => {
      const checks = checksForRecordedMessages(sample.messages);
      if (!checks) {
        ungraded.push(sample.id);
        return [];
      }
      return [{ ...sample, checks, claims: [], score: true }];
    });
    provenance = {
      ...saved.provenance,
      ungraded,
      scope:
        'Known FAFO source profiles only; other reports need their own source-grounded questions.',
    };
    evidenceErrors = saved.evidenceErrors;
  }
  const plans = examples.map((example) => ({ example, packets: planFocusedExample(example) }));
  const plannedRequests = plans.reduce((n, p) => n + p.packets.length, 0) * repetitions;
  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          policy: focusedPolicy,
          provenance,
          repetitions,
          plannedRequests,
          plans,
        },
        null,
        2,
      ),
    );
  } else {
    loadEnv();
    const id = `jev-examples-${randomUUID()}`;
    const results: Awaited<ReturnType<typeof assessFocused>>[] = [];
    const artifact = {
      id,
      startedAt: new Date().toISOString(),
      status: 'running',
      rubric: 'focused-field-checks',
      policy: focusedPolicy,
      provenance,
      plans,
      repetitions,
      plannedRequests,
      concurrency: 'up to four packets per example; examples sequential',
      evidenceErrors,
      model: 'jev-latest',
      results,
      summary: {} as Record<string, unknown>,
    };
    const file = await saveArtifact(id, artifact);
    console.log(
      `Recording ${plannedRequests} requests across ${examples.length} examples: ${file}`,
    );
    for (let repetition = 0; repetition < repetitions; repetition++) {
      for (const example of examples) {
        const result = await assessFocused(example);
        results.push(result);
        await saveArtifact(id, artifact);
        console.log(
          `${example.id}: ${result.decision.disposition}; ${result.durationMs.toFixed(0)} ms; ${JSON.stringify(Object.assign({}, ...result.records.map((r) => r.response?.answers)))}`,
        );
      }
    }
    const records = results.flatMap((r) => r.records);
    const latency = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted.length
        ? {
            n: sorted.length,
            minMs: sorted[0],
            medianMs:
              sorted.length % 2
                ? sorted[Math.floor(sorted.length / 2)]
                : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2,
            maxMs: sorted.at(-1),
          }
        : null;
    };
    artifact.status = 'completed';
    artifact.summary = {
      returnedModels: [...new Set(records.flatMap((r) => (r.response ? [r.response.model] : [])))],
      completedRequests: records.filter((r) => r.response).length,
      errors: results.filter((r) => r.decision.disposition === 'error').length,
      dispositions: Object.fromEntries(
        ['checks_clear', 'flag', 'review', 'quality_only', 'error'].map((d) => [
          d,
          results.filter((r) => r.decision.disposition === d).length,
        ]),
      ),
      allRequestLatency: latency(records.map((r) => r.durationMs)),
      successfulRequestLatency: latency(records.filter((r) => r.response).map((r) => r.durationMs)),
      exampleWallLatency: latency(results.map((r) => r.durationMs)),
      inputTokens: records.every((r) => r.response)
        ? records.reduce((n, r) => n + (r.response?.usage.input_tokens ?? 0), 0)
        : null,
      note: 'Every request included; actual HTTP plus parsing/validation, not model-only time. Small local sample; not a throughput or accuracy benchmark. Inspect expected versus actual answers individually.',
    };
    await saveArtifact(id, artifact);
    console.log(JSON.stringify(artifact.summary, null, 2));
    if (evidenceErrors || results.some((r) => r.decision.disposition === 'error'))
      process.exitCode = 1;
  }
} catch (error) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}
