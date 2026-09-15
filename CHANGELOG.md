# Changelog

All notable, user-facing changes to this kit are recorded here.
Entries are grouped by release, newest first.

## [0.2.1] - 2026-09-15

- Updated `rn-metro-console` to prefer a project-resolvable `ws` transport and send Metro's required `Origin` header for physical-device inspector handshakes.
- Clarified that `rn-audit` labels its sequential challenge fallback as `[PARTIAL]` when independent challenge is unavailable.

## [0.2.0] - 2026-09-04

- Added `rn-upgrade-pulse`, which records the upgrade surface before a React Native or Expo version bump: installed versions with the manifest that declares them, lockfile and package-manager candidates, native ownership, and CI verification gaps.
- Added `rn-device-qa`, which routes runtime acceptance evidence to the right surface and names the authorization each one needs.
- Added `rn-ci-artifact-audit`, a read-only inventory of a GitHub Actions workflow's artifact evidence.
- Added `rn-eas-profile-audit`, a tested CLI that resolves one EAS build profile and its `extends` chain, plus the skill that interprets it.
- Made `rn-audit` portable across agent runtimes: its `Workflow`-only script was replaced by a read-only evidence procedure with independent challenge when available and a sequential fallback labeled `[PARTIAL]` otherwise.
- Hardened `rn-metro-console`: an independent setup deadline, readiness gated on the `Runtime.enable` acknowledgement, pre-ready events dropped, and a rejected enable or a pre-ready close reported as a failure.

## [0.1.0] - 2026-08-19

First tagged release of the public distribution snapshot. Ships six audit-first agent skills for React Native maintenance:

- `rn-project-snapshot` — read-only snapshot of a project's setup that routes you to the deeper audits.
- `rn-asset-hygiene` — audit and tidy RN assets, then migrate scattered references to a typed registry.
- `rn-newarch-audit` — audit New Architecture readiness across dependencies and app-local native modules.
- `rn-audit` — multi-agent code-quality audit with every finding adversarially verified before it reaches the report.
- `rn-device-capture` — screenshot the running app to a fixed path so the agent can read it.
- `rn-metro-console` — read a running app's console output via Metro's CDP endpoint.
