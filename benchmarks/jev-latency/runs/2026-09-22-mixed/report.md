# Jev client-observed latency

Run created 2026-09-22T21:37:40-05:00 at Mac.localdomain (Local, go1.27.1). Schedule `30ae54c76c547ab97dbf3e7774852f5996050ed7d37749fc8e5c62324296a9b5`.

Total records: 3000 / 3000 planned. Durations are full requests in ms, from this measured location.

Fixture: `fixtures/triage.json` (SHA-256 `86aa527b31bd68763dd1d3f9c7a2023edbf6797068b878d4fb963d0065edd1e3`). Each configuration has 100 repetitions split across two sessions. Requests ran one at a time, with seeded balanced provider order within each matched trial. The 16-question mixed cell contains 6 Noul, 5 Choice, and 5 Score questions.

Sample tag: `blog-20260922`. A fixed-width `state.benchmark_sample_id` varied by repetition and matched across providers; the report evidence and question meanings stayed fixed. This avoids identical request bodies within a cell but cannot rule out internal caching.

| Provider | Primitive | Batch | OK / planned | Fail rate | Timeout rate | New / reused connections | p50 ms | rough p95 ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| typesafe | noul | 1 | 100 / 100 | 0.00% | 0.00% | 2 / 98 | 189.06 | 260.92 |
| vercel | noul | 1 | 61 / 100 | 39.00% | 0.00% | 2 / 98 | 279.49 | 480.98 |
| openrouter | noul | 1 | 100 / 100 | 0.00% | 0.00% | 2 / 98 | 250.29 | 397.62 |
| typesafe | noul | 4 | 100 / 100 | 0.00% | 0.00% | 0 / 100 | 194.84 | 262.60 |
| vercel | noul | 4 | 37 / 100 | 63.00% | 0.00% | 0 / 100 | 269.71 | 362.77 |
| openrouter | noul | 4 | 100 / 100 | 0.00% | 0.00% | 0 / 100 | 239.07 | 365.63 |
| typesafe | noul | 16 | 100 / 100 | 0.00% | 0.00% | 0 / 100 | 198.55 | 308.16 |
| vercel | noul | 16 | 38 / 100 | 62.00% | 0.00% | 0 / 100 | 297.63 | 476.96 |
| openrouter | noul | 16 | 100 / 100 | 0.00% | 0.00% | 0 / 100 | 244.78 | 343.07 |
| typesafe | choice | 1 | 100 / 100 | 0.00% | 0.00% | 0 / 100 | 200.78 | 322.99 |
| vercel | choice | 1 | 25 / 100 | 75.00% | 0.00% | 0 / 100 | 265.69 | 363.44 |
| openrouter | choice | 1 | 100 / 100 | 0.00% | 0.00% | 0 / 100 | 238.80 | 334.43 |
| typesafe | choice | 4 | 100 / 100 | 0.00% | 0.00% | 0 / 100 | 201.77 | 273.86 |
| vercel | choice | 4 | 37 / 100 | 63.00% | 0.00% | 0 / 100 | 273.14 | 380.98 |
| openrouter | choice | 4 | 100 / 100 | 0.00% | 0.00% | 0 / 100 | 246.72 | 365.01 |
| typesafe | choice | 16 | 100 / 100 | 0.00% | 0.00% | 0 / 100 | 199.83 | 276.08 |
| vercel | choice | 16 | 35 / 100 | 65.00% | 0.00% | 0 / 100 | 292.65 | 406.58 |
| openrouter | choice | 16 | 100 / 100 | 0.00% | 0.00% | 0 / 100 | 235.21 | 340.37 |
| typesafe | score | 1 | 100 / 100 | 0.00% | 0.00% | 0 / 100 | 198.35 | 259.87 |
| vercel | score | 1 | 40 / 100 | 60.00% | 0.00% | 0 / 100 | 288.54 | 437.37 |
| openrouter | score | 1 | 100 / 100 | 0.00% | 0.00% | 0 / 100 | 228.97 | 332.13 |
| typesafe | score | 4 | 100 / 100 | 0.00% | 0.00% | 0 / 100 | 194.73 | 281.03 |
| vercel | score | 4 | 41 / 100 | 59.00% | 0.00% | 0 / 100 | 274.24 | 431.90 |
| openrouter | score | 4 | 100 / 100 | 0.00% | 0.00% | 0 / 100 | 229.05 | 326.04 |
| typesafe | score | 16 | 100 / 100 | 0.00% | 0.00% | 0 / 100 | 222.33 | 339.99 |
| vercel | score | 16 | 40 / 100 | 60.00% | 0.00% | 0 / 100 | 302.20 | 449.11 |
| openrouter | score | 16 | 100 / 100 | 0.00% | 0.00% | 0 / 100 | 252.55 | 355.42 |
| typesafe | mixed | 16 | 100 / 100 | 0.00% | 0.00% | 0 / 100 | 206.57 | 259.10 |
| vercel | mixed | 16 | 35 / 100 | 65.00% | 0.00% | 0 / 100 | 296.93 | 386.92 |
| openrouter | mixed | 16 | 100 / 100 | 0.00% | 0.00% | 0 / 100 | 245.02 | 335.09 |

## Matched gateway comparisons

| Gateway | Primitive | Batch | Complete pairs | Missing / failed pairs | Different answer payloads | Difference of medians ms | Median paired difference ms | Median delta % | 95% paired bootstrap CI ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| vercel | noul | 1 | 61 | 0 / 39 | 32 | 87.18 | 77.39 | 39.00 | 61.50 to 101.23 |
| openrouter | noul | 1 | 100 | 0 / 0 | 53 | 61.23 | 48.32 | 23.08 | 40.41 to 74.04 |
| vercel | noul | 4 | 37 | 0 / 63 | 27 | 64.85 | 69.43 | 33.24 | 44.16 to 89.95 |
| openrouter | noul | 4 | 100 | 0 / 0 | 85 | 44.23 | 46.41 | 21.89 | 23.48 to 61.96 |
| vercel | noul | 16 | 38 | 0 / 62 | 38 | 94.56 | 80.43 | 40.68 | 70.89 to 107.36 |
| openrouter | noul | 16 | 100 | 0 / 0 | 100 | 46.23 | 41.09 | 20.06 | 31.53 to 64.19 |
| vercel | choice | 1 | 25 | 0 / 75 | 25 | 60.83 | 59.25 | 29.03 | 49.14 to 84.84 |
| openrouter | choice | 1 | 100 | 0 / 0 | 100 | 38.02 | 32.69 | 17.59 | 22.78 to 50.30 |
| vercel | choice | 4 | 37 | 0 / 63 | 37 | 63.68 | 60.03 | 29.35 | 42.75 to 93.25 |
| openrouter | choice | 4 | 100 | 0 / 0 | 100 | 44.95 | 31.84 | 16.62 | 28.86 to 56.14 |
| vercel | choice | 16 | 35 | 0 / 65 | 35 | 87.32 | 85.47 | 42.63 | 67.25 to 102.32 |
| openrouter | choice | 16 | 100 | 0 / 0 | 100 | 35.38 | 30.73 | 15.80 | 22.36 to 53.66 |
| vercel | score | 1 | 40 | 0 / 60 | 40 | 87.83 | 89.15 | 48.45 | 71.77 to 108.63 |
| openrouter | score | 1 | 100 | 0 / 0 | 100 | 30.62 | 33.11 | 17.97 | 20.83 to 44.25 |
| vercel | score | 4 | 41 | 0 / 59 | 41 | 74.85 | 80.72 | 43.93 | 58.97 to 105.20 |
| openrouter | score | 4 | 100 | 0 / 0 | 100 | 34.33 | 33.48 | 17.37 | 20.72 to 51.48 |
| vercel | score | 16 | 40 | 0 / 60 | 40 | 82.79 | 73.88 | 37.05 | 44.80 to 100.89 |
| openrouter | score | 16 | 100 | 0 / 0 | 100 | 30.22 | 35.66 | 16.29 | 19.06 to 44.35 |
| vercel | mixed | 16 | 35 | 0 / 65 | 35 | 100.65 | 104.29 | 52.81 | 84.34 to 125.36 |
| openrouter | mixed | 16 | 100 | 0 / 0 | 100 | 38.45 | 34.71 | 17.68 | 19.95 to 52.73 |

CI is shown only for at least 20 complete matched blocks; otherwise NA means insufficient samples. Bootstrap resamples matched blocks and the interval applies to the difference of route medians, not the median paired difference. Missing and failed trials are never replaced. Percent is the median of per-pair gateway-minus-direct divided by direct. Different answer payloads include probability and confidence differences; this is not an accuracy measure.

## DNF — attempted requests without valid answers

611 DNF records. They remain in the raw results, count toward failure rates, and are excluded from latency medians and paired deltas. Unattempted scheduled requests are listed separately as missing pairs above. Every DNF is itemized in `dnf.csv`.

| Route / status | Count |
|---|---:|
| vercel/HTTP 429 | 593 |
| vercel/HTTP 503 | 17 |
| vercel/HTTP 520 | 1 |

Vercel 429 request-limit headers: 30 on 593 responses. Gateway metadata reported zero upstream provider attempts on 593 Vercel 429 responses. These identify a limit on this gateway route but do not establish which account tier or upstream allocation set it.

Successful-only latencies are conditionally selected when a route has many failures. Repeated input may be cached. Consult raw cache headers and usage; absent evidence does not prove no caching. Models may resolve differently or remain undisclosed. Gateway deltas include routing, provider service, network, and client-observed transfer and validation, and are not pure router overhead. This benchmark does not establish accuracy or a per-question latency.
