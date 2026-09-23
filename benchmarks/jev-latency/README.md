# Jev route latency benchmark

Standalone Go benchmark of direct TypeSafe, Vercel AI Gateway, and OpenRouter. It measures full client-observed request latency, not isolated gateway processing. Go 1.22+; no SDK or paid calls in tests.

## Run

Export `TYPESAFE_API_KEY`, `AI_GATEWAY_API_KEY`, and `OPENROUTER_API_KEY` in your shell. From this directory:

```sh
go run . dry-run -out results/run -primitives noul,choice,score,mixed -sample-tag my-run
go run . run -out results/run -session 1 -primitives noul,choice,score,mixed -sample-tag my-run
go run . run -out results/run -session 2 -primitives noul,choice,score,mixed -sample-tag my-run
go run . report -out results/run -primitives noul,choice,score,mixed -sample-tag my-run
```

Use the same flags for all four commands and a new `-sample-tag` for each independent run. Credentials and `results/` are ignored by Git. `-reps 2 -batches 1` gives a short local check. Run `go test ./...` for the small mock-server suite.

## Method

The full matrix has 10 workloads: Noul, Choice, and Score at 1, 4, and 16 questions, plus one mixed 16-question batch (6 Noul, 5 Choice, 5 Score). Each workload runs 100 times per route, split into two sessions: 3,000 requests total. Requests run one at a time. Provider order is seeded and balanced within matched trials. A 250 ms pause applies only when crossing an OpenRouter-to-Vercel or workload-section boundary. There are no application retries or discarded warmups.

The sample tag adds a fixed-width `state.benchmark_sample_id` that changes by repetition but matches across routes. This avoids identical bodies within a workload without changing the report evidence or question meanings. It cannot rule out internal caching. Non-2xx and invalid answers remain DNFs; Vercel 429s do not stop the run.

`report` writes `report.md`, `summary.csv`, `pairs.csv`, and itemized `dnf.csv`. Raw JSONL, the exact schedule, and a manifest are retained for audit and resume. The 95% bootstrap interval applies to the **difference of route medians**; the report also gives the **median paired delay**, a separate statistic. Vercel latency uses successful matched requests only when failures occur.

## Latest run and chart

[`runs/2026-09-22-mixed/`](runs/2026-09-22-mixed/) contains the full 3,000-request run, including the [report](runs/2026-09-22-mixed/report.md), compressed `raw.jsonl.gz` and `schedule.json.gz`, CSVs, [SVG chart](runs/2026-09-22-mixed/jev-latency-reliability.svg), and [PNG chart](runs/2026-09-22-mixed/jev-latency-reliability.png). Decompress the raw and schedule files in a copied run directory to regenerate the report. Regenerate the chart from `summary.csv` and `pairs.csv` with `plot_latency_reliability.py` (PNG export needs Pillow).

Results reflect one Mac, time window, fixture, and route configuration. Different returned model identifiers do not establish identical underlying versions. High Vercel DNF rates under its reported 30-request limit are completion rates for this run, not general service uptime. Answer payload differences include probability rounding and are not an accuracy result.

API contracts: [TypeSafe](https://docs.typesafe.ai/api), [Vercel Jev endpoint](https://vercel.com/changelog/ai-gateway-now-supports-typesafe-clients-and-http-api-for-jev), [OpenRouter Decisions](https://github.com/OpenRouterTeam/ai-sdk-provider).
