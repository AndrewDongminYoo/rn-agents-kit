# Changelog

All notable, user-facing changes to this kit are recorded here.
Entries are grouped by release; the topmost section collects work that has not yet been tagged.

## [Unreleased]

First public distribution snapshot. Ships six audit-first agent skills for React Native maintenance:

- `rn-project-snapshot` — read-only snapshot of a project's setup that routes you to the deeper audits.
- `rn-asset-hygiene` — audit and tidy RN assets, then migrate scattered references to a typed registry.
- `rn-newarch-audit` — audit New Architecture readiness across dependencies and app-local native modules.
- `rn-audit` — multi-agent code-quality audit with every finding adversarially verified before it reaches the report.
- `rn-device-capture` — screenshot the running app to a fixed path so the agent can read it.
- `rn-metro-console` — read a running app's console output via Metro's CDP endpoint.
