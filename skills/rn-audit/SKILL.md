---
name: rn-audit
description: Use when you need a broad, evidence-based React Native or Expo code audit of a project, feature, or diff. It reviews rendering, hooks, lists, native boundaries, and effects without changing source.
---

# RN Code Audit

## Overview

This skill reviews a React Native or Expo target for concrete code-quality defects.
It separates discovery from verification so a plausible concern does not become a finding without a second reading of the relevant code.
The audit does not modify source files.

## When to Use

- "audit this React Native app or feature"
- "review this React Native diff before merge"
- "look for hook, rendering, list, native-boundary, or effect problems"
- "give me a code-quality report with reproducible evidence"

## Prerequisites

- Identify one target: an app root, a directory, a file, or `diff`.
- For `diff`, set `BASE_REF` to the pull request base ref, or `main` when no pull request exists.
- Use the repository's tracked source and configuration files as default evidence.
- When the target is a named file or feature directory, include untracked source inside that target.
- For an app-root or diff audit, list untracked source with `git ls-files --others --exclude-standard`.
  Report untracked source as a coverage gap unless a named file or feature directory includes it.
- Exclude generated and vendored paths from discovery by default.
  Review an intentionally maintained generated file only when the target explicitly names it.
- Use collaboration tools only when the active runtime exposes them.

## Quick Steps

1. Inspect the target, project layout, React Native or Expo version, and enabled architecture before selecting review lenses.
   - Include untracked source when a named file or feature directory contains it.
   - For an app-root or diff audit, list untracked source with `git ls-files --others --exclude-standard`.
     Report it as a coverage gap unless a named file or feature directory includes it.
2. For a `diff` target, set `MERGE_BASE=$(git merge-base "$BASE_REF" HEAD)`.
   Inspect `git diff --name-status --find-renames "$BASE_REF"...HEAD` and the complete patch before selecting lenses.
   - Read a deleted preimage with `git show "$MERGE_BASE:$OLD_PATH"`.
   - Read both blobs for a renamed path with `git show "$MERGE_BASE:$OLD_PATH"` and `git show "HEAD:$NEW_PATH"`.
3. Select up to five distinct lenses that match the target, such as render cost, hook correctness, list virtualization, native boundaries, or effect cleanup.
4. For each proposed finding, read the cited code and the closest relevant context.
5. Have an independent reviewer challenge each finding when the runtime supports independent review.
6. When independent review is unavailable, perform a separate sequential challenge pass and label the report `[PARTIAL]`.
7. Report only verified findings with file locations, evidence, severity, and a concrete next step.

## How It Works

```log
target source
  -> scope and lenses
  -> candidate sites
  -> contextual inspection
  -> independent or sequential challenge
  -> evidence report
```

## Review Modes

| Mode          | Scope                                        | Verification                                                                       | Mutates source? |
| ------------- | -------------------------------------------- | ---------------------------------------------------------------------------------- | --------------- |
| Broad audit   | App root or feature                          | Independent challenge when available                                               | No              |
| Diff audit    | `git diff --find-renames "$BASE_REF"...HEAD` | Read the complete patch and both blobs for every deleted or renamed path           | No              |
| Focused audit | One directory or file                        | Independent challenge when available, otherwise a sequential `[PARTIAL]` challenge | No              |

## Evidence Rules

- Cite the file and line or symbol for every finding.
- Read enough surrounding code to distinguish a defect from an intentional pattern.
- Do not report a concern that depends on missing runtime evidence as confirmed.
- Put unverified runtime behavior, profiler work, and unavailable independent review in `caveats`.
- State the reviewed scope and selected lenses in every report.
- Give counts for candidate sites, inspected sites, and verified findings in every report.
- List each skipped path or candidate in every report and state why it was skipped.
- State when reviewed source was untracked.
- For deleted or renamed paths, read old blobs from `$MERGE_BASE` after obtaining their paths from `--name-status`.
- For renamed paths, read the postimage from `HEAD`.
- A pure rename can omit file content from the patch, so the patch does not replace direct blob reads.
- Treat zero findings as valid only when the report states the reviewed scope and gaps.

## Safety and Verification

This skill is read-only with respect to the target project.
Do not write fixes, change configuration, or run destructive commands during the audit.
Do not claim that a sequential re-read is independent verification.
Use `[PARTIAL]` when the active runtime cannot provide an independent challenge pass.

## Common Mistakes

| Mistake                               | Fix                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| Reviewing generic style issues        | Report concrete correctness, performance, lifecycle, or platform risks instead. |
| Treating a suspicion as a finding     | Read the local context and challenge the claim before reporting it.             |
| Calling static evidence runtime proof | Put required device, profiler, or network checks in `caveats`.                  |
| Hiding skipped areas                  | State the skipped path and why it was not reviewed.                             |

## Reference

- [React Native performance overview](https://reactnative.dev/docs/performance)
- [React hooks reference](https://react.dev/reference/react)

---

> If you need the same audit policy applied across several projects, open a Discussion in the RN Agents Kit repository.
