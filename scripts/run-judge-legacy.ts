import * as v from 'valibot';
import { parseJson, errorMessage } from '../src/json.ts';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DEFAULT_JUDGE_MODEL, loadEnv, requireKey, modelId } from '../src/config.ts';
import { calibrationExamples } from '../src/evals/recordings.ts';
import {
  assessPair,
  openRouterJudgeHarness,
  RUBRIC_VERSION,
  judgeProviderRouting,
  type JudgeResponseMetadata,
} from '../src/evals/judge.ts';
import { saveArtifact } from '../src/evals/artifacts.ts';
loadEnv();
// LESSON 7: these inputs are fixed so disagreements isolate the judge, not a changing app output.
// Supply your labels with --labels=.learn-evals/labels.json after doing the unlabeled exercise.
// Completion means reviewing evidence and false accepts/rejects; a zero exit only means this
// command completed without an execution error, not that the judge agreed or is ready for CI.
try {
  requireKey();
  const args = process.argv.slice(2);
  const split = args.includes('--validation') ? 'validation' : 'calibration';
  const repetitions = Number(args.find((a) => a.startsWith('--repeat='))?.slice(9) ?? 1);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5)
    throw new Error('--repeat must be 1–5.');
  if (
    args.some(
      (a) => a !== '--validation' && !a.startsWith('--repeat=') && !a.startsWith('--labels='),
    )
  )
    throw new Error('Use --validation, --repeat=1..5, and/or --labels=path.json.');
  const labelPath = args.find((a) => a.startsWith('--labels='))?.slice(9);
  const labels: Record<string, 'pass' | 'fail'> = labelPath
    ? v.parse(
        v.record(v.string(), v.picklist(['pass', 'fail'])),
        parseJson(await readFile(labelPath, 'utf8')),
      )
    : {};
  const examples = calibrationExamples.filter((e) => e.split === split);
  if (labelPath && examples.some((e) => !['pass', 'fail'].includes(labels[e.id])))
    throw new Error('Labels file needs a pass/fail label for every example in this split.');
  console.log(
    `${examples.length * repetitions} judge calls on fixed synthetic outputs, model ${modelId(process.env.JUDGE_MODEL?.trim() || DEFAULT_JUDGE_MODEL)}. No application calls. Preferred provider: ${process.env.JUDGE_PROVIDER?.trim() || 'automatic'}. Labels: ${labelPath ? 'learner-supplied' : 'reference author labels'}.`,
  );
  const results = [];
  for (const example of examples)
    for (let trial = 1; trial <= repetitions; trial++) {
      let metadata: JudgeResponseMetadata | null = null;
      const human = labels[example.id] ?? example.human;
      try {
        const verdict = await assessPair(
          { report: example.report, issue: example.issue },
          openRouterJudgeHarness({
            onResponse: (value) => {
              metadata = value;
            },
          }),
        );
        results.push({
          id: example.id,
          trial,
          human,
          status: 'completed' as const,
          ...verdict,
          metadata,
        });
      } catch (error) {
        results.push({
          id: example.id,
          trial,
          human,
          status: 'error' as const,
          error: errorMessage(error),
          metadata,
        });
      }
    }
  const completed = results.filter((r) => r.status === 'completed');
  const summary = {
    planned: examples.length * repetitions,
    completed: completed.length,
    errors: results.length - completed.length,
    agreements: completed.filter((r) => r.verdict === r.human).length,
    falseAccepts: completed.filter((r) => r.human === 'fail' && r.verdict === 'pass').length,
    falseRejects: completed.filter((r) => r.human === 'pass' && r.verdict === 'fail').length,
  };
  const file = await saveArtifact(`judge-${randomUUID()}`, {
    evidence: 'live-judge-on-synthetic-outputs',
    rubricVersion: RUBRIC_VERSION,
    providerRouting: judgeProviderRouting(),
    model: modelId(process.env.JUDGE_MODEL?.trim() || DEFAULT_JUDGE_MODEL),
    split,
    summary,
    results,
  });
  console.table(summary);
  console.log(
    `Agreement denominator: ${completed.length} completed grades. Errors remain visible. Evidence: ${file}`,
  );
  if (summary.errors) process.exitCode = 1;
} catch (error) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}
