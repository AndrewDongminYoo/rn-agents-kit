---
name: rn-eas-profile-audit
description: Use when you need a deterministic, read-only resolution of one Expo EAS build profile and its extends chain from eas.json.
---

# RN EAS Profile Audit

## Overview

Runs the bundled `rn-eas-profile-audit.mjs` CLI to resolve one `eas.json` build profile.
The CLI follows the selected profile's `extends` chain and prints the effective JSON configuration.
It reads one JSON file and does not edit files, inspect a GitHub Actions workflow, authenticate to EAS, run a build, or identify an artifact.
It accepts strict JSON only.
Use EAS CLI for an `eas.json` file that uses JSON5 comments or trailing commas.

## When to Use

- "resolve this EAS build profile"
- "show the effective iOS simulator setting after profile inheritance"
- "check an eas.json profile chain before reviewing a CI workflow"

## Prerequisites

- Node.js 18.3.0 or later for `node:util.parseArgs` and `Object.hasOwn`.
- A strict JSON `eas.json` file with a `build` object.
- A named build profile.

## Quick Steps

1. When this skill is active, use its absolute base directory instead of a path in the target React Native project.
   Set `SKILL_DIR` to that directory.
2. Run the reader with one config path and one profile name.

```bash
SKILL_DIR="<this skill's base directory>" # absolute path provided when this skill loaded
node "$SKILL_DIR/rn-eas-profile-audit.mjs" --config path/to/eas.json --profile simulator
```

3. Read the JSON result.
   `chain` lists the inherited profiles from parent to selected profile.
   `effective` contains the resolved configuration.

## How It Works

```log
 eas.json + selected profile
  -> validate build object and extends chain
  -> merge EAS inheritance fields with child overrides
  -> effective profile JSON
```

## Commands

| Intent               | Command                                                                                  | Mutates source? |
| -------------------- | ---------------------------------------------------------------------------------------- | --------------- |
| Resolve a profile    | `node "$SKILL_DIR/rn-eas-profile-audit.mjs" --config path/to/eas.json --profile preview` | No              |
| Show help            | `node "$SKILL_DIR/rn-eas-profile-audit.mjs" --help`                                      | No              |
| Run the helper tests | `node --test "$SKILL_DIR/rn-eas-profile-audit.test.mjs"`                                 | No              |

The CLI writes JSON to stdout and diagnostics to stderr.
It accepts a chain with at most five profiles, rejects a missing inherited profile, and rejects a circular chain.
It merges `env`, `android`, and `ios` as EAS profile inheritance fields.
Other child fields replace the parent value.

## Safety and Verification

The CLI is read-only.
Use the result only as `eas.json` configuration evidence.
It does not apply Expo platform defaults or choose platform-specific precedence.
It does not parse JSON5 syntax.
Do not treat it as evidence that a workflow ran, that local EAS output was retained, that cloud EAS authentication succeeded, or that an artifact is installable.

Run the bundled tests after changing the helper.

```bash
node --test "$SKILL_DIR/rn-eas-profile-audit.test.mjs"
```

## Common Mistakes

| Mistake                                         | Fix                                                                        |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| Reading `extends` by hand                       | Run the CLI with the exact selected profile.                               |
| Treating `chain` as workflow execution evidence | Keep workflow order and command success as separate evidence.              |
| Treating `effective` as an artifact guarantee   | Collect build, retention, authentication, and runtime evidence separately. |
| Passing a nonexistent profile                   | Read the available names under `build` and run the CLI again.              |
| Passing JSON5 syntax                            | Use EAS CLI when the file contains comments or trailing commas.            |
| Calling a repository-relative helper path       | Use the absolute `SKILL_DIR` supplied when the skill loaded.               |

## Reference

- [Expo build profiles](https://docs.expo.dev/build/eas-json/)

---

> If you need broader EAS workflow policy checks across projects, open a Discussion in the RN Agents Kit repository.
