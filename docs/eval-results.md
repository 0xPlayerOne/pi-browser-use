# Eval result schema

`npm run eval` writes `eval-results/result.json` after every run. This document is
the contract for that file; `schemaVersion` increments on breaking changes, so
tooling can pin to the shape it parses.

## Report (top level)

| Field            | Type     | Description                                                                                                                   |
| ---------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`  | `1`      | Bumps on breaking shape changes.                                                                                              |
| `harness`        | `string` | Always `pi-browser-use-task-eval`.                                                                                            |
| `generatedAt`    | ISO time | When the run finished.                                                                                                        |
| `revision`       | `string` | `GIT_COMMIT` or `GITHUB_SHA` when set, else `git rev-parse HEAD`, else `unknown`. Compare revisions before comparing results. |
| `dependencyHash` | `string` | SHA-256 of `package-lock.json`; `unknown` when unreadable.                                                                    |
| `node`           | `string` | Node version, e.g. `v22.12.0`.                                                                                                |
| `platform`       | `string` | `process.platform-process.arch`.                                                                                              |
| `config`         | `object` | Effective run settings: `mode`, `headed`, `fixture`, `evidence`, `timeoutMs`.                                                 |
| `iterations`     | `number` | Attempts per task.                                                                                                            |
| `tasks`          | `array`  | One entry per selected task (see Task).                                                                                       |
| `summary`        | `object` | Aggregate over all attempts (see Summary).                                                                                    |
| `resultPath`     | `string` | Absolute path of the file itself.                                                                                             |

## Task

| Field         | Type     | Description                                          |
| ------------- | -------- | ---------------------------------------------------- |
| `id`          | `string` | Task ID (`form-submit`, `navigate`, …).              |
| `description` | `string` | Human-readable task intent.                          |
| `attempts`    | `array`  | One entry per iteration (see Attempt).               |
| `summary`     | `object` | Same shape as the top-level Summary, this task only. |

## Attempt

| Field            | Type              | Description                                                                                                                   |
| ---------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `iteration`      | `number`          | 1-based attempt number.                                                                                                       |
| `status`         | `passed`/`failed` | Cleanup failures flip a passed task to `failed`.                                                                              |
| `durationMs`     | `number`          | Wall time including startup and teardown.                                                                                     |
| `startupMs`      | `number?`         | `runtime.start()` duration; absent when startup itself failed.                                                                |
| `steps`          | `array`           | Ordered tool calls (see Step).                                                                                                |
| `artifacts`      | `array`           | Files the task deliberately saved: `{ kind, path, sizeBytes }`.                                                               |
| `evidenceErrors` | `number`          | Failed evidence-capture attempts (screenshots). Task failures are never caused by these.                                      |
| `cleanup`        | `object`          | `{ status }` or `{ status: 'failed', failure }` for `runtime.stop()`.                                                         |
| `checks`         | `string[]`        | Objective assertions that passed.                                                                                             |
| `metrics`        | `object`          | Task-defined counters (e.g. `itemCount`).                                                                                     |
| `failure`        | `object?`         | Bounded `{ name, message }` (at most 1000 characters).                                                                        |
| `failureClass`   | `harness`/`task`  | `harness`: browser never became usable (startup failed, zero steps succeeded, cleanup broke). `task`: the scenario regressed. |

## Step

| Field        | Type                        | Description                                    |
| ------------ | --------------------------- | ---------------------------------------------- |
| `index`      | `number`                    | 1-based call order.                            |
| `tool`       | `string`                    | Short tool name (e.g. `fill_form`).            |
| `status`     | `running`/`passed`/`failed` | Terminal states are written before the report. |
| `durationMs` | `number`                    | Tool call duration.                            |
| `error`      | `string?`                   | Bounded failure text (at most 500 characters). |

## Summary

| Field             | Type     | Description                                                                                |
| ----------------- | -------- | ------------------------------------------------------------------------------------------ |
| `taskCount`       | `number` | Number of selected tasks.                                                                  |
| `attempts`        | `number` | Total attempts run.                                                                        |
| `passed`/`failed` | `number` | Attempt outcomes.                                                                          |
| `harnessFailures` | `number` | Failures where the browser environment broke; fix the environment, do not chase the tasks. |
| `successRate`     | `number` | `passed / attempts` rounded to 2 places.                                                   |
| `toolCalls`       | `number` | Total tool calls across steps.                                                             |
| `evidenceErrors`  | `number` | Failed evidence captures.                                                                  |
| `taskDurationMs`  | `Stats`  | Attempt durations.                                                                         |
| `startupMs`       | `Stats`  | Browser startup durations.                                                                 |
| `stepDurationMs`  | `Stats`  | Tool call durations.                                                                       |

`Stats` is `{ count, mean, p50, p95, max }` (rounded to 2 places), or `{ count: 0 }` with no samples.

## Layout on disk

```text
eval-results/
  result.json
  <task-id>/
    iteration-<n>/
      profile/          isolated browser profile (throwaway)
      artifacts/        runtime default artifact dir
      deliverables/     files tasks deliberately save
      evidence/         failure and per-step screenshots (evidence modes)
```

`eval-results/` is gitignored. Delete it freely; every run rewrites its own tree.
