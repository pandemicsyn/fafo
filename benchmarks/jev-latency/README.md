# Jev route latency benchmark

Compares client-observed latency and completion for TypeSafe direct, OpenRouter, and Vercel AI Gateway.

## Run

Set `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, and `AI_GATEWAY_API_KEY`, then run from this directory:

```sh
go run . dry-run -out results/run -primitives noul,choice,score,mixed -sample-tag my-run
go run . run -out results/run -session 1 -primitives noul,choice,score,mixed -sample-tag my-run
go run . run -out results/run -session 2 -primitives noul,choice,score,mixed -sample-tag my-run
go run . report -out results/run -primitives noul,choice,score,mixed -sample-tag my-run
```

Use the same flags throughout. Give each independent run a new sample tag.

## Latest run

The [3,000-request report](runs/2026-09-22-mixed/report.md), [SVG chart](runs/2026-09-22-mixed/jev-latency-reliability.svg), [PNG chart](runs/2026-09-22-mixed/jev-latency-reliability.png), and raw data are in [`runs/2026-09-22-mixed/`](runs/2026-09-22-mixed/). Requests ran serially in balanced provider order. Failures count as DNFs; latency comparisons use successful matched requests.
