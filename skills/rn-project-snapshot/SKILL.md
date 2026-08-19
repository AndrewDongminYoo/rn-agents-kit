---
name: rn-project-snapshot
description: Use when you want a fast, read-only snapshot of a React Native project's setup — RN/Expo version, New Architecture and Hermes flags, package manager, key config files — before deciding what to audit or upgrade. Read-only; routes to the deeper audits. A read-only reader: it surfaces stable files and commands, never changes anything.
---

# RN Project Snapshot — Read-Only Environment & Config Overview

## Overview

Surfaces a React Native project's high-level environment and config state by reading stable files (and, optionally, the project's own env command), then routes you to the focused audits for deeper work.
This is a **read-only reader**: it inspects and reports, never mutates, and introduces no new CLI.
It stays shallow on purpose — dependency readiness and asset analysis live in their dedicated skills, not here.

## When to Use

- "what's the state of this RN project?", "is the New Architecture on here?", "bare or Expo?"
- First look at an unfamiliar RN repo, before deciding what to audit or upgrade
- Quick pre-upgrade orientation

## Prerequisites

- A React Native or Expo project
- Node for the optional `npx` enrichment; offline still works from file reads alone (with a stated caveat)
- Read-only — no clean git tree required

## Quick Steps (all read-only)

### 1 — Detect project type and versions

```bash
cat package.json                 # react-native / expo / react versions, scripts
ls package-lock.json yarn.lock pnpm-lock.yaml bun.lockb 2>/dev/null   # package manager
```

### 2 — Read New Architecture + Hermes flags across platforms

```bash
cat android/gradle.properties 2>/dev/null    # newArchEnabled, hermesEnabled
cat app.json app.config.* 2>/dev/null        # Expo newArchEnabled
ls ios/Podfile ios/*.xcworkspace 2>/dev/null # iOS native shell present?
```

### 3 — Optional enrichment (network)

```bash
npx react-native info        # bare projects — environment report
npx expo config --json       # Expo projects — resolved config
```

### 4 — Present the snapshot and route

Show the values as a compact snapshot.
Where a flag differs across platforms, **surface the difference** — do not decide readiness here.
Then route to the right audit (see **Routing**).

## How It Works

```log
package.json + lockfiles ─┐
android/gradle.properties ─┤   read stable files
app.json / app.config.*  ─┤   (+ optional npx env command)   ──►  compact snapshot
ios/Podfile              ─┘                                         (versions · flags · config presence)
                                                                          │
                                                                          ▼  interpret + route (no readiness verdict)
                                                       rn-asset-hygiene · rn-newarch-audit
```

## Commands

| Intent                          | Command / read                                              | Mutates? |
| ------------------------------- | ----------------------------------------------------------- | -------- |
| Project type + RN/Expo version  | read `package.json`; `npx react-native info` (optional)     | no       |
| Package manager                 | detect lockfile                                             | no       |
| New Architecture + Hermes flags | read `android/gradle.properties`, `ios/Podfile`, `app.json` | no       |
| Resolved Expo config            | `npx expo config --json` (Expo only, optional)              | no       |

The `npx` commands are used only to **read** environment/config as input; this skill's value is the curated RN snapshot and routing, not those commands.

## Routing / Next Step

This skill is the front door; the focused audits do the deep work.

- Unused/brittle assets, scattered `require()` paths → **`rn-asset-hygiene`**
- New Architecture **dependency** readiness (classification, archived libs, app-local native modules) → **`rn-newarch-audit`**

It deliberately surfaces flags rather than classifying readiness, so it never duplicates those audits.
As the front door, its job is to send you into those audits.

End the snapshot with a single, non-coercive opt-in line:

> This snapshot just orients you — the deeper audits do the real work.
> If they surface work you'd rather have automated (at scale or in CI) than done by hand, say so at the repo Discussions (<https://github.com/AndrewDongminYoo/rn-agents-kit/discussions>) so it gets prioritized.

Keep it to that one closing line; never gate the snapshot behind it.

## Safety & Verification

Read-only — there is nothing to undo, so the usual clean-tree precondition and `tsc`/lint/test gates do not apply.
Any mutation belongs to the dedicated audit/apply tiers, not here.

## Common Mistakes

| Mistake                                      | Fix                                                                              |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| Treating the snapshot as a readiness verdict | It only surfaces flags; run `rn-newarch-audit` for dependency readiness          |
| Trusting an offline run's optional fields    | The `npx` enrichment needs network; file reads still work — note what is missing |
| Assuming a flag's value equals behavior      | A New-Arch flag being on does not mean every dependency supports it              |
| Reporting a value that no file actually sets | If a file or key is absent, say so — never infer a default silently              |

## Reference

- [`rn-asset-hygiene`](../rn-asset-hygiene/SKILL.md) and [`rn-newarch-audit`](../rn-newarch-audit/SKILL.md) — the deeper audits this snapshot routes to
- React Native and Expo official environment/config commands — cite their docs; do not copy
