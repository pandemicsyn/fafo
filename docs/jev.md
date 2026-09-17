# Jev judge experiments

The original `npm run evals:judge` still runs lesson 7's OpenRouter judge. New options add Jev through its documented HTTP API, with no extra SDK or app server required.

## Worked examples for the Jev post

```sh
npm run evals:judge -- --examples --dry-run
npm run evals:judge -- --examples
```

This is the focused path used by the post. Eleven examples make 23 requests. Every call uses `jev-latest`, and every request counts toward timing and token totals. `--repeat=2` repeats every example, rather than selecting favorable results. Dry-run prints the exact evidence packets and question definitions without loading a key or calling a model.

[Example definitions](../examples/jev-worked-examples.ts) contain original user messages, structured candidate issues, source excerpts, individual requirements and explicit candidate claims. These annotations are authored teaching material, not an automatic extractor for arbitrary reports. Before calling Jev, code verifies that source excerpts occur in the report and that candidate claims occur in the saved issue. This proves provenance of the text, not the correctness or completeness of our interpretation. Expected labels stay outside the requests.

The [focused judge](../src/evals/jev-focused.ts) builds three kinds of evidence:

- **Noul:** one source excerpt and one candidate field. Each question checks one named requirement. Questions share a request only when they need the same source excerpt and candidate field.
- **Choice:** one candidate claim and its source context. Other candidate assertions are not supplied as corroborating evidence.
- **Score:** the structured issue alone, graded for apparent usefulness on concrete 0–3 levels. This does not establish whether its details are true.

Code composes the factual answers. A Noul error probability at least 0.8 flags that check; at most 0.2 clears it; intermediate values go to review. Choice results below 0.8 confidence go to review; otherwise contradicted or unsupported claims are flagged. These illustrative thresholds were fixed before this run. Quality never cancels a factual failure. `checks_clear` means only the explicitly listed checks cleared, not that the whole issue is correct. A missing response, mismatched evidence, or inconsistent model produces an error, not a pass.

[All captured results](../examples/jev-worked-capture.json) requested `jev-latest`; the API returned `jev-1.13.0`. They include every example and every response, including uncertainty:

- Second Escape missing: error probability 0.98; preserved: 0.05.
- Muted condition missing: 0.97; the faithful version still received 0.36 and went to review.
- Invented Redis cause: unsupported probability 1.00. Reversed observation: contradicted probability 0.99.
- Usefulness: 1.00 for feature detail without steps/environment; 1.99 for steps; 3.00 for steps plus environment.
- Authored run: 23/23 requests completed; 5 flagged examples, 2 with listed checks clear, 1 review, 3 quality-only examples. Median request latency 336 ms, range 160–708 ms. The four-request notification examples took 479–709 ms end to end. These are small local observations, not an accuracy or throughput benchmark.

The runners checkpoint exact requests, raw responses, timing and errors in `artifacts/trials/jev-examples-*.json`. Authorization headers are not saved.

### Recorded agent outputs and sampling

```sh
npm run evals:judge -- --examples --run=run-REPLACE-ME --dry-run
npm run evals:judge -- --examples --run=run-REPLACE-ME
npm run evals:judge -- --examples --run=run-REPLACE-ME --sample=0.05 --seed=blog-demo --dry-run
```

The focused replay preserves user-turn boundaries and the actual stored issue object. Source profiles currently cover the original search and export tasks; unfamiliar reports are listed as ungraded, never silently assigned generic checks. Claims are not automatically extracted, so the replay checks the specified reproduction/observation facts plus usefulness, not every assertion in the issue. It is not a deployed production monitor.

The captured replay selected six real agent outputs from eleven authored FAFO scenarios. Five cleared the listed checks and one went to review; four other scenarios were not applicable and one had an outcome failure. All 18 Jev requests completed. Median complete evaluation time was 542 ms with three focused requests per issue. The review concerned whether “until refresh” sufficiently preserved recovery; its error probability was 0.28. These examples do not establish an accuracy estimate for production traffic.

For live sampling, capture the relevant evidence at run completion and judge selected records asynchronously. Dynamic reports need their own reliable context/requirement construction; preserve corrections and uncertainty. A verbatim substring check does not detect omitted context that reverses a claim. Keep source context sufficient to judge the relationship, and retain the original messages for review.

## Earlier broad experiments

The commands below remain available for inspecting the earlier whole-issue rubrics. They are not the focused examples used by the post.

## Store the key

Append these settings to the checkout's ignored `.dev.vars`. Do not overwrite existing keys or put credentials in chat:

```dotenv
TYPESAFE_API_KEY=your-key-here
```

Jev-only experiments need no OpenRouter key. Comparisons with `deepseek` also need `OPENROUTER_API_KEY`. That name selects our existing adapter, respecting `JUDGE_MODEL` and `JUDGE_PROVIDER`; actual model/provider metadata is recorded.

## Inspect and label the data

```sh
npm run evals:judge -- --judge=jev --dataset=jev --dry-run
```

Dry runs make no network calls and print the inputs and exact request count. The Jev calibration batch has **18 synthetic pairs: 9 provisional passes and 9 provisional failures across 8 source groups**. The validation batch has **10 pairs: 5/5 across four different source groups**. These are authored teaching examples, not production samples or independent human validation.

| Contrast                                                                  | What it tests                                  |
| ------------------------------------------------------------------------- | ---------------------------------------------- |
| Faithful paraphrases and terse summaries vs missing conditions            | Meaning rather than exact wording or verbosity |
| First vs second Escape press                                              | Order and repetition of actions                |
| Supported root cause vs invented cause/fix                                | Evidence, not a blanket ban on causal language |
| Unmuted vs muted; one vs two alerts                                       | Negation and quantities                        |
| Suspected cause vs confirmed cause                                        | Preservation of uncertainty                    |
| Explicit browser correction; untested vs unaffected browser               | Scope and corrections                          |
| Literal instruction-like search text vs an instruction aimed at the judge | Contextual interpretation of untrusted data    |
| Correct rows but wrong columns; blank file vs no download                 | Distinguishing related failures                |

`sourceGroup` and `slice` describe dataset organization. They, IDs and labels are never sent to Jev. Each request contains only report, issue and optional claim. Claims are explicitly supplied descriptions of candidate-issue content, not extracted by Jev. Source groups never cross the splits. Related variants within a split are intentionally correlated; don't count them as independent production observations.

Read the pairs and create your own label file before inspecting model answers or provisional keys. Its shape is an object mapping every selected pair ID to `"pass"` or `"fail"`. Use lesson 7's criterion: preserve feature, trigger, expected behavior and observed behavior without inventing facts.

```sh
npm run evals:judge -- --judge=jev --dataset=jev --labels=.learn-evals/jev-labels.json
```

The `examples/jev-provisional-labels.json` and `examples/jev-validation-provisional-labels.json` keys were **authored by the coding agent before the expanded dataset was evaluated**. They are candidate labels for review, not human ground truth. To use them explicitly:

```sh
npm run evals:judge -- --judge=jev --dataset=jev --labels=examples/jev-provisional-labels.json --label-source=provisional
```

Without labels, accuracy is unknown. With provisional labels, agreement only means agreement with those proposed labels. The artifact records the label source. The first calibration example was used for an API smoke test before expansion; it is already development data. The validation batch is kept out of initial live testing. Once inspected or used for tuning it is no longer unseen, and a repository is not a secure holdout from a coding agent.

Use `--validation` for the separate batch and its corresponding label file. Use `--pairs=path.json` for your own array of `{ id, report, issue, claim?, sourceGroup?, slice? }` objects. Don't combine `--pairs` with `--dataset` or `--validation`. Review ambiguous evidence and label disagreements before treating them as judge failures.

## Three primitives, separate meanings

The `jev` configuration asks five **Noul** failure questions: missing/changed feature, trigger, expected behavior, observed behavior, or invented facts. It also asks a **Score** about reproduction coverage on a 0–2 scale, and a **Choice** about a supplied claim: supported, contradicted, or unsupported.

Only failure Nouls affect the verdict. Choice and Score stay diagnostic. The initial **uncalibrated** thresholds are pass if every failure probability is at most 0.1; fail if any is at least 0.9; review otherwise. Adjust `--accept` and `--reject` after calibration. A score isn't a percentage of correct facts, and no probability guarantees truth. Do not multiply independently evaluated answers into a joint probability: their errors can correlate.

## Compare configurations

```sh
npm run evals:judge -- --compare=deepseek,jev-single,jev --repeat=3
```

The default teaching dataset has three pairs, so this makes 27 requests: 3 pairs × 3 repetitions × 3 judges. `jev-single` asks one holistic fidelity question; `jev` decomposes it. The agent is not rerun between judges. Rubrics differ intentionally, so this does not isolate model quality alone. Teaching pairs lack a supplied claim, so Choice is omitted. Configuration order rotates across pair/repetition blocks.

Every call uses `jev-latest`. The actual model returned by the API is saved with each response. Split requests returning different versions are an error. Exit zero means execution completed without errors, not agreement with labels.

## Measure batching and speed

```sh
npm run evals:judge -- --judge=jev --dataset=jev --batching --repeat=3 --dry-run
```

Remove `--dry-run` to run it. This compares one batched request, sequential individual requests, and concurrent individual requests over the same questions. With 18 pairs it plans **810 requests**; use a smaller custom pair file for a cheap smoke test.

Every request is included in the totals. There are no automatic retries. Assessment latency includes HTTP, reading and validation; concurrent latency is wall-clock time, not a sum. Individual request times are retained. Reports show all-attempt and completed-only latency. Small-sample p95 is descriptive, not a service guarantee. Connection reuse, input size, concurrency and network location affect results.

## Judge actual saved outputs

Take a run ID from `artifacts/latest-run.json` or `artifacts/runs/`:

```sh
npm run evals:judge-run -- --run=run-REPLACE-ME --judge=jev --dry-run
npm run evals:judge-run -- --run=run-REPLACE-ME --judge=jev
```

The loader reads the user report and independently captured stored issue, not the assistant's success claim. New trials include the case ID and expectation. Older artifacts require an exact, unique match against archived case IDs and current inputs/fixture/fault. That inference is labeled for review because old expectations may have changed.

The manifest distinguishes missing/ambiguous required issues (outcome failure); no new issue required (not applicable); application/cleanup errors (no semantic grade); and eligible issues. Structural grades remain visible alongside semantic verdicts. Comment fidelity is outside this judge's scope. Missing, invalid, duplicate or unreadable evidence produces explicit accounting and nonzero exit status. Unreadable files are conservatively reported even if run membership cannot be determined.

Original live/scripted-provider provenance is retained. Accuracy on actual agent outputs is unknown without labels keyed by trial ID.

## Sample saved runs

```sh
npm run evals:judge-run -- --run=run-REPLACE-ME --judge=jev --sample=0.05 --seed=blog-demo --dry-run
```

The seed and run/trial ID determine inclusion via SHA-256. The same arguments select the same trials regardless of directory ordering. `0.05` is a 5% inclusion probability, not exactly 5% of a small run; it may select none. Use `--sample=1` for all eligible outputs. Selected/unselected trials, missing writes and errors stay visible. This is **saved-evidence replay**, not a deployed queue or production-throughput measurement.

## Evidence and interpretation

Each `artifacts/trials/judge-*.json` contains the plan, inputs, questions, raw/parsed answers, labels, rubric/threshold versions, actual models, usage, timing and errors. Authorization headers are never saved. A manifest precedes calls; each assessment checkpoints progress. Interrupted runs can have fewer results than planned; missing results aren't passes.

Coverage includes reviews/errors in its denominator. Accuracy uses only labeled automatic decisions and is null when none exist. Slice summaries locate disagreements. Repeated judgments are not independently labeled examples.

Jev cost is a published-rate estimate ($0.042 per million input tokens, zero output-token cost as of September 2026), not an invoice. Verify pricing for the selected model. Missing usage produces unknown cost. OpenRouter usage is retained without inventing a cost. Jev generates no prose explanation or source quotes: inspect the evidence and individual answers, and retain any subsequent human/explanatory-model review separately.
