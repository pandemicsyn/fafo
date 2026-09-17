import { loadEnv } from '../src/config.ts';
import { errorMessage } from '../src/json.ts';
import { loadLabels, parseOptions, runExperiment } from '../src/evals/judge-experiment.ts';
import { loadSavedRun } from '../src/evals/judge-saved-run.ts';

loadEnv();
try {
  if (process.argv.includes('--help')) {
    console.log(`Judge saved issue outputs without rerunning the agent:
  npm run evals:judge-run -- --run=<run-id> --judge=jev
  --sample=0.05 --seed=my-sample --dry-run
  Also supports --compare, --labels, --repeat, --batching, --accept, --reject.
Only trials with a required, unambiguous new issue are sampled. Other outcomes remain in the manifest.
Labels use trial IDs. This is saved-run replay, not a deployed live monitor.`);
  } else {
    const options = parseOptions(process.argv.slice(2), true);
    if (!options.run) throw new Error('Missing run ID.');
    const { pairs, provenance, evidenceErrors } = await loadSavedRun(
      'artifacts',
      options.run,
      options.sample,
      options.seed,
    );
    console.log({
      run: options.run,
      ...provenance.counts,
      plannedTrials: provenance.plan.planned,
      missingArtifacts: provenance.missingArtifacts,
      extraArtifacts: provenance.extraArtifacts,
      evidenceErrors,
    });
    const labels = await loadLabels(options.labels, pairs, {});
    const result = await runExperiment(pairs, labels, options, provenance);
    if (evidenceErrors || result?.errors) process.exitCode = 1;
  }
} catch (error) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}
