# Performance audit and budgets

This project measures performance in two layers:

- `npm run perf:audit` measures cold plugin import time and memory, the published package, and the production dependency closure. It is fast, emits JSON, and does not launch Chrome.
- `npm run bench -- --iterations 10 --json` launches the complete headless Chrome + MCP stack and measures startup, process-tree RSS, and representative tool calls against a fixed local fixture.

Code Foundry runs `npm test` and `npm run perf:check` in separate unit and performance jobs, so the stable artifact, dependency, and normalized cold-import budgets remain required in CI without coupling them to the unit command. The audit reports raw time but compares it with a same-run `typebox` import to account for runner CPU variance. Browser timing and process-tree memory are reported rather than enforced because shared-runner and Chrome variance would make a wall-clock budget flaky.

## M0 baseline and result

Measured on Apple Silicon, macOS, Node 22.23.1, using seven fresh Node processes for cold import and ten iterations for browser operations. The baseline is `317a3aa` (`main` before M0).

| Metric                                     |    Baseline |  M0 result | Change |
| ------------------------------------------ | ----------: | ---------: | -----: |
| Cold plugin import p50                     |    123.5 ms |    70.5 ms | -42.9% |
| Cold import maximum RSS delta              |     49.9 MB |    33.8 MB | -32.3% |
| npm tarball                                |    107.9 KB |    79.7 KB | -26.1% |
| npm unpacked package                       |    406.0 KB |   270.1 KB | -33.5% |
| Published files                            |         106 |         63 | -40.6% |
| Clean production install package manifests |         373 |        113 | -69.7% |
| Clean production install size              | 292,012 KiB | 46,728 KiB | -84.0% |

The cold-import gain comes from loading the MCP SDK only when a browser connection is opened. The package gains come from cleaning `dist` before every build, publishing executable JavaScript and declarations without build maps, and marking Pi host packages as optional peers so npm does not install a second host runtime for standalone package inspection.

Five M0 headless startup samples had a 383 ms median and 256,360,448 byte (244.5 MiB) median process-tree RSS. Ten-iteration means were 0.9 ms navigate, 2.4 ms snapshot, 39.8 ms screenshot, 205.8 ms evaluate, 207.2 ms fill, and 433.0 ms agent loop. These numbers are hardware snapshots, not portable guarantees.

Build and test baselines were captured with `/usr/bin/time -l`: `npm run build` took 1.79 seconds and the original 158-test `npm test` took 2.17 seconds. The final clean build took 1.51 seconds; the 161-test command plus its new performance gate took 4.06 seconds. Re-run the same commands for local build/test comparisons; the extra test time is the intentional CI regression audit.

## Regression budgets

Budgets live in [`performance-budgets.json`](../performance-budgets.json). They intentionally leave headroom for CI variance while failing meaningful regressions:

| Metric                            |        Budget |
| --------------------------------- | ------------: |
| Cold import / `typebox` p50 ratio |           3.0 |
| Cold import maximum RSS delta     |        48 MiB |
| npm tarball                       |  90,000 bytes |
| npm unpacked package              | 300,000 bytes |
| Published files                   |            70 |
| Published map files               |             0 |
| Production dependency closure     |  140 packages |

## Reproduce locally and in CI

```sh
npm ci
npm run build
npm run format:check
npm run lint
npm run typecheck
npm test
npm run perf:check
npm run perf:audit
npm run bench -- --iterations 10 --json
npm run bench -- --startup-only --json
```

`perf:audit` and `bench --json` are suitable for machine capture. Use at least seven cold imports and ten runtime iterations when updating the table. Record Node, OS, architecture, commit, and whether Chrome was headless; do not compare results collected with different modes or iteration counts.

## Task-level evaluation

`npm run eval -- --json` runs deterministic browser tasks against fixed DOM fixtures in a fresh isolated session. Each task attempt gets its own runtime and records objective checks, startup/task/step timings, bounded failure text, and artifact paths in `eval-results/result.json`. Failed attempts save a screenshot by default; use `--evidence all` to capture evidence after every successful step or `--evidence none` to disable it.

```sh
npm run eval -- --iterations 3 --json
npm run eval -- --task form-submit,extract-list --evidence all
npm run eval -- --list
```

These tasks evaluate runtime and browser-tool behavior, not model quality. Keep them deterministic and network-free for local/CI regression checks. Model-agent evaluations should use the same task IDs and metadata but run in a separate harness, with the model, prompt, reasoning budget, dependency hash, and retry policy recorded. Do not silently truncate normal browser results; bounded evidence is only for judge-facing output.
