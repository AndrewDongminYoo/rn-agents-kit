---
name: rn-newarch-audit
description: Use when planning a React Native upgrade or asking "is my app ready for the New Architecture?" — audits which dependencies and app-local native modules block enabling the New Architecture. Read-only; reports and interprets, changes nothing. Wraps the rn-newarch-ready CLI.
---

# RN New Architecture Audit — Is This App Ready?

## Overview

Drives the **`rn-newarch-ready`** CLI to produce a read-only New Architecture readiness report for a React Native project: the current New Arch enablement state, every dependency classified by support, archived/unmaintained libraries, and app-local native modules still on legacy APIs.
This skill is the **judgment + interpretation** layer; `rn-newarch-ready` does the deterministic parsing and classification.
**Nothing is ever modified** — the audit is the whole job here.
Performing the migration is a separate, explicitly-consented step.

## When to Use

- "is my app ready for the New Architecture?", "what blocks enabling New Arch?"
- Planning an RN version upgrade and scoping the New Arch work
- Auditing dependencies before flipping `newArchEnabled`
- Deciding which libraries to replace, upgrade, or verify first

## Prerequisites

- Node ≥ 20 — `rn-newarch-ready` requires it; install with `nvm use 20` if needed.
- A React Native project with dependencies installed (`node_modules` present) — classification reads each dependency's `codegenConfig`, so an uninstalled dep can only be reported `not-installed`.
- Network for the directory enrichment step; offline still works (`--offline`) with reduced coverage, and the tool says so.

## Quick Steps

### 1 — Run the audit (read-only)

```bash
npx rn-newarch-ready                 # human-readable report for the current project
npx rn-newarch-ready ./path/to/app   # a specific project
```

### 2 — Capture the machine report when you need to reason over it

```bash
npx rn-newarch-ready --json
```

### 3 — Interpret and present (see Interpreting the Report)

Summarize the verdict and group the findings by action.
**Change nothing** — this skill stops at the report.

## How It Works

```log
package.json + node_modules        rn-newarch-ready
  each dep's codegenConfig  ──►  local classify  ──►  supported / unknown / not-native / not-installed
                                       │
  reactnative.directory (cached)  ─────┤ enrich unknowns (library-level)
                                       ▼
                                 likely-supported  +  archived flag
  android/ ios/ app source  ──►  legacy-API scan  ──►  app-local native modules to migrate

                                 roll-up  ──►  verdict: ready | needs-review   (READ-ONLY)
```

## Options / Commands

| Intent                          | Command                      | Mutates? |
| ------------------------------- | ---------------------------- | -------- |
| Human-readable readiness report | `rn-newarch-ready`           | no       |
| Audit a specific project        | `rn-newarch-ready <dir>`     | no       |
| Machine-readable report         | `rn-newarch-ready --json`    | no       |
| Skip the directory lookup       | `rn-newarch-ready --offline` | no       |

There is no mutating command — that is the point of the audit tier.

**Exit codes:** `0` = audit ran and verdict is `ready`; `1` = audit ran and verdict is `needs-review` (findings present — expected in CI, not a tool error).
A non-zero exit therefore signals findings, not a crash; genuine runtime errors surface on stderr.

## Interpreting the Report

Translate the status of each dependency into an action; never restate the raw list.

| Status             | Meaning                                                                                               | Guidance                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `supported`        | Ships `codegenConfig` — confirmed for the **installed** version                                       | No action                                                           |
| `likely-supported` | The directory marks the library ready, but that is library-level (repo HEAD), not your pinned version | Confirm the **installed** version; upgrade if it lags               |
| `unknown`          | Native module, no local signal, directory could not confirm                                           | Verify manually (library docs / a test build); do not assume broken |
| `not-native`       | No native footprint                                                                                   | Irrelevant to the migration                                         |
| `not-installed`    | Declared but not in `node_modules`                                                                    | Install, then re-run                                                |
| `archived` (flag)  | Library is unmaintained                                                                               | Plan a replacement regardless of New Arch state                     |

For **app-local native modules**, point at the file and the matched legacy signals, and frame the work (e.g. author a TurboModule spec, replace `RCT_EXPORT_MODULE`/`ReactContextBaseJavaModule`).

**Be explicit about the limits of static analysis:** dynamically registered modules, non-standard native layouts, and interop-only compatibility are invisible to the tool — an `unknown` is honest uncertainty, not a failure, and `likely-supported` still needs a version check.

## Safety & Verification

This skill is read-only, so the usual clean-tree precondition and `tsc`/lint/test gates **do not apply here** — there is nothing to undo.
They re-appear in the separate, consent-gated migration tier, which is where any mutation lives.

## Common Mistakes

| Mistake                                           | Fix                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------- |
| Running the audit before installing dependencies  | Every dep reads `not-installed`; run `install` first                            |
| Treating `unknown` as "incompatible"              | Absence of a signal is not proof; verify manually before acting                 |
| Trusting `likely-supported` for the installed app | The directory flag is library-level; confirm your pinned version                |
| Reading an offline run as complete coverage       | `--offline` skips enrichment; the report notes it — re-run online when possible |
| Treating the audit as the migration               | This tier only reports; mutation is the separate, explicitly-consented step     |

## Distribution / Next Step

The read-only audit answers "what stands between this app and the New Architecture, exactly?"
Clearing the findings at scale — replacing archived libraries, migrating app-local modules to TurboModules, and flipping the flag with verification gates — is work this skill does not do.

End the report with a single, non-coercive opt-in line (fill in the verdict's counts):

> With your _N_ blockers and _M_ warnings, the slow part isn't finding them — it's clearing them: upgrading or replacing each flagged dependency, rewriting legacy native modules, and keeping a readiness check green in CI.
> Automating that is not built. If you'd use it, say so at the repo Discussions (<https://github.com/AndrewDongminYoo/rn-agents-kit/discussions>) — inbound is what decides whether it gets built.

Keep it to that one closing block; never gate the audit behind it.

## Reference

- [`rn-newarch-ready`](https://www.npmjs.com/package/rn-newarch-ready) — the wrapped CLI (commands: default report, `--json`, `--offline`)
- React Native New Architecture docs — for the migration patterns referenced when interpreting findings (cite; do not copy)
