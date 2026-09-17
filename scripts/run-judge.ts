import { loadEnv } from '../src/config.ts';
import { errorMessage } from '../src/json.ts';
import {
  loadLabels,
  loadPairs,
  parseOptions,
  runExperiment,
} from '../src/evals/judge-experiment.ts';

const args = process.argv.slice(2);
// Preserve the original lesson-7 command, artifacts and reference-label behavior.
if (args.includes('--examples')) {
  await import('./run-jev-examples.ts');
} else if (
  !args.some(
    (arg) =>
      /^--(judge|compare|dataset|pairs|accept|reject|label-source)=/.test(arg) ||
      ['--batching', '--dry-run', '--help'].includes(arg),
  )
) {
  await import('./run-judge-legacy.ts');
} else if (args.includes('--help')) {
  console.log(`Jev experiments (no app server required):
  --examples [--dry-run] [--repeat=1..3]
  --examples --run=run-ID [--sample=0.05 --seed=blog-demo]
  --judge=jev|jev-single|deepseek OR --compare=deepseek,jev-single,jev
  --dataset=teaching|jev [--validation] OR --pairs=path.json
  --labels=path.json --label-source=human|provisional --repeat=1..5
  --batching --accept=0.1 --reject=0.9 --dry-run
No new options: original lesson-7 runner. Jev dataset has no supplied labels.
Key: TYPESAFE_API_KEY in .dev.vars. --dry-run needs no key.
Thresholds are illustrative; review human-labeled results before trusting automatic decisions.`);
} else {
  loadEnv();
  try {
    const options = parseOptions(args);
    const { pairs, referenceLabels, source } = await loadPairs(options);
    const labels = await loadLabels(options.labels, pairs, referenceLabels);
    const result = await runExperiment(pairs, labels, options, {
      kind: 'synthetic-pairs',
      source,
      labels: options.labels
        ? options.labelSource
        : Object.keys(referenceLabels).length
          ? 'reference author labels; teaching data'
          : 'unlabeled',
    });
    if (result?.errors) process.exitCode = 1;
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
