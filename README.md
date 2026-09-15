# RN Agents Kit

[![RN Agents Kit coordinates audit-first React Native maintenance](https://raw.githubusercontent.com/AndrewDongminYoo/rn-agents-kit/main/docs/assets/readme-hero.png)](https://rn-toolkits.donminzzi.kr/rn-agents-kit)

[![license](https://img.shields.io/github/license/AndrewDongminYoo/rn-agents-kit?style=flat-square&color=667085)](LICENSE) [![React Native](https://img.shields.io/badge/React_Native-maintenance-0086aa?style=flat-square&logo=react&logoColor=white)](https://reactnative.dev/) [![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-c57417?style=flat-square)](#install) [![audit first](https://img.shields.io/badge/workflow-audit_first-2f6f44?style=flat-square)](#how-it-works) [![RN Toolkits](https://img.shields.io/badge/docs-RN_Toolkits-c57417?style=flat-square)](https://rn-toolkits.donminzzi.kr/rn-agents-kit)

**Audit React Native projects before an agent changes them.**

[Documentation](https://rn-toolkits.donminzzi.kr/rn-agents-kit) · [Install](#install) · [Issues](https://github.com/AndrewDongminYoo/rn-agents-kit/issues) · [Discussions](https://github.com/AndrewDongminYoo/rn-agents-kit/discussions)

RN Agents Kit is a curated set of agent skills that automates the high-friction parts of React Native maintenance.
Every skill inspects and reports first, keeps the evidence reproducible, and requires explicit consent before changing a project.

## Install

Add the public marketplace and install the plugin in Claude Code:

```text
/plugin marketplace add AndrewDongminYoo/rn-agents-kit
/plugin install rn-agents-kit@rn-agents-kit
```

## Skills

| Skill                  | What it does                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rn-project-snapshot`  | Read-only snapshot of a project's setup — version, New Architecture / Hermes flags, configs — then routes you to the deeper audits                                                                                        |
| `rn-asset-hygiene`     | Audit and tidy RN assets — find unused images / SVG / Lottie, consolidate scattered `require()` paths, migrate to a typed registry                                                                                        |
| `rn-newarch-audit`     | Audit New Architecture readiness — classify dependencies, flag archived libraries, find app-local native modules on legacy APIs                                                                                           |
| `rn-audit`             | Evidence-based code audit — rendering, hooks correctness, list virtualization, native boundaries, effects; challenges every finding independently when available, otherwise reports a sequential challenge as `[PARTIAL]` |
| `rn-device-capture`    | Screenshot the running app (Android / iOS simulator / iOS 17+ device) to a reported path under `logs/` the agent can read — closes the visual feedback loop                                                               |
| `rn-metro-console`     | Read a running app's `console.*` output via Metro's CDP endpoint — bounded by default; the log half of the verification loop                                                                                              |
| `rn-device-qa`         | Route runtime acceptance evidence — screenshots, Metro logs, interactive QA — to the right surface, and name the authorization each one needs                                                                             |
| `rn-ci-artifact-audit` | Read-only inventory of where a GitHub Actions workflow declares its artifact evidence — app roots, dependency and build declarations, artifact references                                                                 |
| `rn-eas-profile-audit` | Resolve one EAS build profile and its `extends` chain from `eas.json`, rejecting missing profiles, cycles and excessive depth                                                                                             |
| `rn-upgrade-pulse`     | Record the upgrade surface before a React Native or Expo version bump — installed versions, lockfile candidates, native ownership, CI verification gaps                                                                   |

## An example run

[New Architecture readiness on a public app](docs/examples/newarch-audit.md) shows `rn-newarch-audit` running against Rocket.Chat's React Native client.
The report records the findings, confirms that 0 files changed, and includes the commands needed to reproduce the audit.

## How it works

Each skill is **audit-first** and **git-safe**: it inspects and reports before it proposes anything, and your source and assets do not change before you approve a fix; any such change requires a clean git tree and explicit consent, runs the project's gates afterward, and leaves a reviewable `git diff`.
A skill may still write its own output — a screenshot under `logs/`, a generated registry under `src/generated/` — which each skill names up front.
Skills wrap a tested CLI or surface stable project inputs — they do not re-implement that work in prose.

## License

See [`LICENSE`](./LICENSE).
