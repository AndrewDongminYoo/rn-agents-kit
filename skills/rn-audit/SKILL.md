---
name: rn-audit
description: Use when you want a thorough, low-false-positive code-quality audit of a React Native / Expo codebase or a diff — render performance, hooks correctness, list virtualization, native boundaries, effect leaks. Fans out many agents and adversarially verifies each finding to kill false positives, so it is for breadth, not a quick single-file check. Complements rn-newarch-audit (New Architecture readiness) — different scope, different mechanism.
---

# RN Code Audit — Fan-Out, Verify, Synthesize

## Overview

This skill runs a multi-agent workflow that audits a React Native codebase the way a careful reviewer would: it decomposes the target into inspection lenses, locates the most suspect sites for each lens, extracts concrete falsifiable findings from the actual code, then puts every finding through adversarial review before it reaches the report.
The defining move is the verification pass — each finding is challenged by independent skeptic voters whose job is to _refute_ it, and a finding only survives if it is not refuted.
That is what keeps the output low-noise: plausible-but-wrong findings are killed before you ever see them, and the killed ones are listed separately for transparency rather than dropped silently.

Unlike the other skills in this kit, `rn-audit` does not wrap a deterministic CLI — its deterministic layer is the workflow script itself, a `SKILL.md` beside a `.js` that the `Workflow` tool runs. The script owns the deterministic orchestration (deduping sites, ranking, tallying votes, capping cost); the fanned-out agents supply the judgment.
It is read-only with respect to your source; it reports and proposes fixes, it does not apply them.

## When to Use

- "audit this RN app / screen / feature for quality problems"
- Reviewing a branch before merge — pass `args: "diff"` to scope to the changed files
- Hunting render-performance, hooks, list-virtualization, native-boundary, or effect-leak defects across many files at once
- You want findings you can trust — false positives already filtered out

## When NOT to Use

- A quick review of one file or a small diff — use `/code-review`, it is faster and does not fan out.
- "Is my app ready for the New Architecture?" — use `rn-newarch-audit`; it is the New-Arch-readiness-specific, CLI-backed audit.
- You need the fixes applied, not just reported — this skill stops at the report.

## Prerequisites

- The `Workflow` tool must be available in the session (this skill is agent-orchestration, not a shell command).
- A React Native / Expo project to point at. `node_modules` is not required — the audit reads source, not installed packages.

## How to Run

Invoke the workflow with the target as `args`:

```plaintext
Whole app:    Workflow({ scriptPath: "<this-skill-dir>/rn-audit.js" })
A path/glob:  Workflow({ scriptPath: "<this-skill-dir>/rn-audit.js", args: "src/features/checkout" })
Branch diff:  Workflow({ scriptPath: "<this-skill-dir>/rn-audit.js", args: "diff" })
```

Use an absolute path to `rn-audit.js` for reliability.
If the workflow is registered by name in the environment, `Workflow({ name: "rn-audit", args })` also works.

## Cost — Read Before Running on a Large App

This skill fans out and is token-heavy: cost is dominated by the verification pass, which is `MAX_VERIFY × VOTES_PER_FINDING` agents.
The four constants at the top of `rn-audit.js` are the cost dial:

- `VOTES_PER_FINDING` (default 3) — skeptic voters per finding; lower to 1 for a cheap first pass, keep at 3 for trustworthy output.
- `REFUTATIONS_REQUIRED` (default 2) — votes needed to kill a finding.
- `MAX_INSPECT` (default 10) — suspect sites read in full.
- `MAX_VERIFY` (default 12) — findings adversarially verified.

Total agents ≈ `1 + lenses(5) + MAX_INSPECT + MAX_VERIFY × VOTES_PER_FINDING + 1`.
With the defaults that is roughly 50 agents; the `stats.agentCalls` field in the result reports the actual count.
For a large codebase, scope with `args` (a subdirectory or `"diff"`) rather than raising the caps.

## Interpreting the Report

The result is structured:

- `findings` — the confirmed defects, ordered by severity then confidence, each with `locations` (`file:line`), `evidence`, and a `suggestedFix`. These are the action items.
- `refuted` — findings that were killed in verification, kept for transparency. These are _not_ action items; they are shown so you can see what was considered and why it was dropped.
- `caveats` — what static reading could not confirm (e.g. real-world jank or memory thresholds that need a running app plus a profiler).
- `openQuestions` — follow-ups worth a second pass.
- `stats` — coverage accounting: lenses, sites inspected, findings extracted vs verified vs confirmed vs killed, dupes, and `budgetDropped` (sites the cap skipped — raise `MAX_INSPECT` or narrow `args` if this is high and you need them).

Treat a finding in `refuted` as settled-not-a-bug unless you have reason to re-check; treat `budgetDropped > 0` as a signal that coverage was capped, not that the rest is clean.
