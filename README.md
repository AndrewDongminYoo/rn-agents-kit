# RN Agents Kit

A curated set of audit-first agent skills for **React Native** that automates the high-friction parts of RN maintenance.
Audit-first: every skill inspects and reports before anything changes, and nothing changes without your consent.

## Install (Claude Code)

```text
/plugin marketplace add AndrewDongminYoo/rn-agents-kit
/plugin install rn-agents-kit@rn-agents-kit
```

## Skills

| Skill                 | What it does                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rn-project-snapshot` | Read-only snapshot of a project's setup — version, New Architecture / Hermes flags, configs — then routes you to the deeper audits                                                   |
| `rn-asset-hygiene`    | Audit and tidy RN assets — find unused images / SVG / Lottie, consolidate scattered `require()` paths, migrate to a typed registry                                                   |
| `rn-newarch-audit`    | Audit New Architecture readiness — classify dependencies, flag archived libraries, find app-local native modules on legacy APIs                                                      |
| `rn-audit`            | Multi-agent code-quality audit — render performance, hooks correctness, list virtualization, native boundaries; every finding is adversarially verified before it reaches the report |
| `rn-device-capture`   | Screenshot the running app (Android / iOS simulator / iOS 17+ device) to a fixed path the agent can read — closes the visual feedback loop                                           |
| `rn-metro-console`    | Read a running app's `console.*` output via Metro's CDP endpoint — bounded by default; the log half of the verification loop                                                         |

## An example run

[New Architecture readiness on a public app](docs/examples/newarch-audit.md) — `rn-newarch-audit` against Rocket.Chat's React Native client: the New Architecture flag is already on, and five of the app's own native modules are still on legacy APIs. 0 files changed, with the commands to reproduce it.

## How it works

Each skill is **audit-first** and **git-safe**: the first run is read-only and reports findings; any change requires a clean git tree and explicit consent, runs the project's gates afterward, and leaves a reviewable `git diff`.
Skills wrap a tested CLI or surface stable project inputs — they do not re-implement that work in prose.

## License

See [`LICENSE`](./LICENSE).
