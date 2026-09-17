import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as v from 'valibot';
import { DEFAULT_JUDGE_MODEL, modelId, requireKey } from '../config.ts';
import { errorMessage, parseJson, toJsonValue } from '../json.ts';
import {
  assessPair,
  openRouterJudgeHarness,
  rubric,
  RUBRIC_VERSION,
  type JudgeResponseMetadata,
} from './judge.ts';
import {
  assessJev,
  DEFAULT_THRESHOLDS,
  jevQuestions,
  validateThresholds,
  type JudgeInput,
  type Strategy,
  type Thresholds,
} from './jev.ts';
import { calibrationExamples } from './recordings.ts';
import { saveArtifact } from './artifacts.ts';

const nonempty = v.pipe(v.string(), v.trim(), v.minLength(1));
export const PairSchema = v.object({
  id: nonempty,
  report: nonempty,
  issue: nonempty,
  claim: v.optional(nonempty),
  sourceGroup: v.optional(nonempty),
  slice: v.optional(nonempty),
});
export type Pair = v.InferOutput<typeof PairSchema>;
export type JudgeName = 'deepseek' | 'jev' | 'jev-single';
export type Options = {
  judges: JudgeName[];
  repetitions: number;
  batching: boolean;
  thresholds: Thresholds;
  labels?: string;
  labelSource: 'human' | 'provisional';
  pairs?: string;
  dataset: 'teaching' | 'jev';
  validation: boolean;
  dryRun: boolean;
  run?: string;
  sample: number;
  seed: string;
};
export function parseOptions(args: string[], saved = false): Options {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const names = [
    'judge',
    'compare',
    'repeat',
    'accept',
    'reject',
    'labels',
    'label-source',
    ...(saved ? ['run', 'sample', 'seed'] : ['pairs', 'dataset']),
  ];
  for (const arg of args) {
    if (['--batching', '--dry-run', ...(!saved ? ['--validation'] : [])].includes(arg)) {
      if (flags.has(arg)) throw new Error(`Duplicate option ${arg}.`);
      flags.add(arg);
      continue;
    }
    const match = /^--([^=]+)=(.+)$/.exec(arg);
    if (!match || !names.includes(match[1]) || values.has(match[1]))
      throw new Error(`Unknown, empty or duplicate option: ${arg}`);
    values.set(match[1], match[2]);
  }
  if (values.has('judge') && values.has('compare')) throw new Error('Choose --judge or --compare.');
  const rawJudges = (values.get('compare') ?? values.get('judge') ?? 'jev').split(',');
  const judges = rawJudges.map((name) =>
    v.parse(v.picklist(['deepseek', 'jev', 'jev-single']), name),
  );
  if (
    new Set(judges).size !== judges.length ||
    (values.has('judge') && judges.length !== 1) ||
    (values.has('compare') && judges.length < 2)
  )
    throw new Error('Select distinct judges; --compare requires at least two.');
  const repetitions = Number(values.get('repeat') ?? 1);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5)
    throw new Error('--repeat must be 1–5.');
  const thresholds = {
    accept: Number(values.get('accept') ?? DEFAULT_THRESHOLDS.accept),
    reject: Number(values.get('reject') ?? DEFAULT_THRESHOLDS.reject),
  };
  validateThresholds(thresholds);
  const sample = Number(values.get('sample') ?? 1);
  if (!Number.isFinite(sample) || sample < 0 || sample > 1)
    throw new Error('--sample must be between 0 and 1.');
  if (saved && !values.has('run')) throw new Error('Supply --run=<saved-run-id>.');
  if (values.has('pairs') && (values.has('dataset') || flags.has('--validation')))
    throw new Error(
      '--pairs supplies its own dataset; do not combine with --dataset or --validation.',
    );
  if (flags.has('--batching') && !judges.some((j) => j !== 'deepseek'))
    throw new Error('--batching needs a Jev judge.');
  return {
    judges,
    repetitions,
    thresholds,
    sample,
    seed: values.get('seed') ?? 'fafo-v1',
    dataset: v.parse(v.picklist(['teaching', 'jev']), values.get('dataset') ?? 'teaching'),
    labels: values.get('labels'),
    labelSource: v.parse(
      v.picklist(['human', 'provisional']),
      values.get('label-source') ?? 'human',
    ),
    pairs: values.get('pairs'),
    run: values.get('run'),
    validation: flags.has('--validation'),
    batching: flags.has('--batching'),
    dryRun: flags.has('--dry-run'),
  };
}
export async function loadPairs(
  options: Options,
): Promise<{ pairs: Pair[]; referenceLabels: Record<string, 'pass' | 'fail'>; source: string }> {
  if (options.pairs || options.dataset === 'jev') {
    const source =
      options.pairs ?? `examples/jev-${options.validation ? 'validation-' : ''}pairs.json`;
    const pairs = v.parse(
      v.pipe(v.array(PairSchema), v.minLength(1)),
      parseJson(await readFile(source, 'utf8')),
    );
    if (new Set(pairs.map((p) => p.id)).size !== pairs.length)
      throw new Error('Duplicate pair IDs.');
    return { pairs, referenceLabels: {}, source };
  }
  const selected = calibrationExamples.filter(
    (p) => p.split === (options.validation ? 'validation' : 'calibration'),
  );
  return {
    pairs: selected.map((p) => v.parse(PairSchema, p)),
    referenceLabels: Object.fromEntries(selected.map((p) => [p.id, p.human])),
    source: 'existing synthetic teaching pairs',
  };
}
export async function loadLabels(
  path: string | undefined,
  pairs: Pair[],
  fallback: Record<string, 'pass' | 'fail'>,
) {
  if (!path) return fallback;
  const labels = v.parse(
    v.record(v.string(), v.picklist(['pass', 'fail'])),
    parseJson(await readFile(path, 'utf8')),
  );
  if (pairs.some((p) => !(p.id in labels)))
    throw new Error('Labels file needs pass/fail for every selected pair.');
  return labels;
}
export type Evaluation = {
  sourceGroup?: string;
  slice?: string;
  id: string;
  trial: number;
  judge: JudgeName;
  strategy: Strategy;
  referenceLabel: 'pass' | 'fail' | null;
  status: 'completed' | 'error';
  verdict: 'pass' | 'fail' | 'review' | null;
  durationMs: number;
  evidence: ReturnType<typeof toJsonValue>;
};
export async function evaluate(
  input: JudgeInput,
  judge: JudgeName,
  strategy: Strategy,
  thresholds: Thresholds,
) {
  if (judge !== 'deepseek')
    return assessJev(input, { single: judge === 'jev-single', strategy, thresholds });
  const started = performance.now();
  let metadata: JudgeResponseMetadata | null = null;
  const pair = { report: input.report, issue: input.issue };
  try {
    const verdict = await assessPair(
      pair,
      openRouterJudgeHarness({
        onResponse: (response) => {
          metadata = response;
        },
      }),
    );
    return {
      status: 'completed' as const,
      verdict: verdict.verdict,
      durationMs: performance.now() - started,
      request: { state: pair, rubric },
      rubricVersion: RUBRIC_VERSION,
      metadata,
      assessment: verdict,
      retries: 0,
    };
  } catch (error) {
    return {
      status: 'error' as const,
      verdict: null,
      durationMs: performance.now() - started,
      request: { state: pair, rubric },
      rubricVersion: RUBRIC_VERSION,
      metadata,
      error: errorMessage(error),
      retries: 0,
    };
  }
}
export function configurations(options: Options) {
  return options.judges.flatMap((judge) => {
    const strategies: Strategy[] =
      options.batching && judge !== 'deepseek'
        ? ['batched', 'sequential', 'concurrent']
        : ['batched'];
    return strategies.map((strategy) => ({ judge, strategy }));
  });
}
export function workload(pairs: Pair[], options: Options) {
  const configs = configurations(options);
  const calls = (input: Pair) =>
    configs.reduce(
      (n, config) =>
        n +
        (config.judge === 'deepseek' || config.strategy === 'batched'
          ? 1
          : Object.keys(jevQuestions(input, config.judge === 'jev-single')).length),
      0,
    );
  return {
    pairs: pairs.length,
    measuredGrades: pairs.length * options.repetitions * configs.length,
    measuredRequests: pairs.reduce((n, pair) => n + calls(pair), 0) * options.repetitions,
  };
}
function latency(values: number[]) {
  if (!values.length) return { count: 0, minMs: null, medianMs: null, p95Ms: null, maxMs: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    minMs: sorted[0],
    medianMs:
      sorted.length % 2
        ? sorted[Math.floor(sorted.length / 2)]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxMs: sorted.at(-1),
  };
}
export function summarizeJudges(rows: Evaluation[]) {
  const groups = [...new Set(rows.map((r) => `${r.judge}/${r.strategy}`))];
  return groups.map((group) => {
    const selected = rows.filter((r) => `${r.judge}/${r.strategy}` === group);
    const completed = selected.filter((r) => r.status === 'completed');
    const automatic = completed.filter((r) => r.verdict !== 'review');
    const labeled = automatic.filter((r) => r.referenceLabel !== null);
    return {
      configuration: group,
      planned: selected.length,
      completed: completed.length,
      errors: selected.length - completed.length,
      reviews: completed.length - automatic.length,
      automaticCoverage: selected.length ? automatic.length / selected.length : null,
      labeledAutomatic: labeled.length,
      agreements: labeled.filter((r) => r.verdict === r.referenceLabel).length,
      falseAccepts: labeled.filter((r) => r.verdict === 'pass' && r.referenceLabel === 'fail')
        .length,
      falseRejects: labeled.filter((r) => r.verdict === 'fail' && r.referenceLabel === 'pass')
        .length,
      automaticAccuracy: labeled.length
        ? labeled.filter((r) => r.verdict === r.referenceLabel).length / labeled.length
        : null,
      allAttemptLatency: latency(selected.map((r) => r.durationMs)),
      completedLatency: latency(completed.map((r) => r.durationMs)),
    };
  });
}
export async function runExperiment(
  pairs: Pair[],
  labels: Record<string, 'pass' | 'fail'>,
  options: Options,
  provenance: unknown,
  assess: typeof evaluate = evaluate,
) {
  const plan = workload(pairs, options);
  console.log(JSON.stringify({ ...plan, options }, null, 2));
  if (options.dryRun) {
    console.log('Dry run: no network calls. Selected inputs (no labels):');
    console.log(JSON.stringify(pairs, null, 2));
    return null;
  }
  if (pairs.length) {
    if (options.judges.includes('deepseek')) requireKey();
    if (options.judges.some((j) => j !== 'deepseek') && !process.env.TYPESAFE_API_KEY?.trim())
      throw new Error(
        'Set TYPESAFE_API_KEY in fafo-evals/.dev.vars. Jev-only runs do not need OpenRouter.',
      );
  }
  const id = `judge-${randomUUID()}`;
  const rows: Evaluation[] = [];
  const config = configurations(options);
  const snapshot = () => ({
    schemaVersion: 2,
    evidence: 'live-judge-evaluation',
    createdAt,
    options,
    plan,
    provenance,
    inputs: pairs,
    labels,
    results: rows,
    summary: summarizeJudges(rows),
    sliceSummary: [
      ...new Set(rows.map((row) => row.slice).filter((slice) => slice !== undefined)),
    ].map((slice) => ({
      slice,
      results: summarizeJudges(rows.filter((row) => row.slice === slice)),
    })),
    notes: [
      'Default Jev thresholds are illustrative, not calibrated.',
      'Every request is included in summaries. No application reruns or automatic request retries.',
      'Latency includes HTTP, response reading and validation. Small-sample p95 is descriptive, not a service guarantee.',
      'Choice and Score are diagnostic; only failure Nouls determine the Jev verdict.',
      'Separate question evaluations may have correlated errors. No joint correctness probability is inferred.',
    ],
    configuredModels: {
      jev: 'jev-latest',
      openrouter: options.judges.includes('deepseek')
        ? modelId(process.env.JUDGE_MODEL || DEFAULT_JUDGE_MODEL)
        : null,
    },
  });
  const createdAt = new Date().toISOString();
  // A manifest precedes paid requests; a checkpoint follows every assessment.
  const file = await saveArtifact(id, snapshot());
  console.log(`Evidence: ${file}`);
  let ordinal = 0;
  for (let trial = 1; trial <= options.repetitions; trial++)
    for (const pair of pairs) {
      // Rotate execution order to avoid always giving one configuration the cold connection.
      const offset = ordinal++ % config.length;
      const ordered = [...config.slice(offset), ...config.slice(0, offset)];
      for (const { judge, strategy } of ordered) {
        const input: JudgeInput = {
          report: pair.report,
          issue: pair.issue,
          ...(pair.claim === undefined ? {} : { claim: pair.claim }),
        };
        const started = performance.now();
        let result: Awaited<ReturnType<typeof evaluate>>;
        try {
          result = await assess(input, judge, strategy, options.thresholds);
        } catch (error) {
          result = {
            status: 'error',
            verdict: null,
            durationMs: performance.now() - started,
            request: { state: { report: pair.report, issue: pair.issue }, rubric },
            rubricVersion: RUBRIC_VERSION,
            metadata: null,
            error: errorMessage(error),
            retries: 0,
          };
        }
        rows.push({
          sourceGroup: pair.sourceGroup,
          slice: pair.slice,
          id: pair.id,
          trial,
          judge,
          strategy,
          referenceLabel: labels[pair.id] ?? null,
          status: result.status,
          verdict: result.verdict,
          durationMs: result.durationMs,
          evidence: toJsonValue(result),
        });
        await saveArtifact(id, snapshot());
        console.log(
          `${pair.id} #${trial} ${judge}/${strategy}: ${result.verdict ?? 'error'} (${Math.round(result.durationMs)} ms)`,
        );
      }
    }
  console.table(
    summarizeJudges(rows).map((summary) => ({
      configuration: summary.configuration,
      planned: summary.planned,
      completed: summary.completed,
      errors: summary.errors,
      reviews: summary.reviews,
      automaticCoverage: summary.automaticCoverage,
      labeledAutomatic: summary.labeledAutomatic,
      agreements: summary.agreements,
      falseAccepts: summary.falseAccepts,
      falseRejects: summary.falseRejects,
      automaticAccuracy: summary.automaticAccuracy,
      medianMs: summary.allAttemptLatency.medianMs,
      p95Ms: summary.allAttemptLatency.p95Ms,
    })),
  );
  console.log(`Reviews and errors stay in the planned denominator. Evidence: ${file}`);
  return { file, rows, errors: rows.filter((r) => r.status === 'error').length };
}
