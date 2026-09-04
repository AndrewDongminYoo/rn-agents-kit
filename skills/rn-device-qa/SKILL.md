---
name: rn-device-qa
description: Use when React Native or Expo acceptance work needs runtime evidence from a simulator, emulator, or physical device, including screenshots, logs, UI interaction, or exploratory QA.
---

# RN Device QA

## Overview

This skill plans the smallest runtime evidence surface that can prove the requested acceptance criterion.
It keeps static screenshots, JavaScript logs, interactive automation, and external state changes distinct.
It does not operate a device, install tools, launch apps, or change external state.

## When to Use

- "verify this React Native screen on a device"
- "run acceptance checks on the simulator or emulator"
- "collect runtime evidence for this mobile flow"
- "explore this app and record reproducible QA findings"

## Prerequisites

- Identify the requested app build and a read-only fingerprint source.
  Record the target platform, device or simulator identity, app identifier, account class, and starting state.
  Report build attribution as `[UNCERTAIN]` when no fingerprint source exists.
  Use an Android serial, iOS UDID, or one booted simulator identity when the evidence helper supports it.
- For simulator capture, require exactly one booted simulator overall.
  Confirm that the booted simulator matches the recorded identity.
- A Metro target descriptor carries no hardware identifier: it reports a title, a device name, and an app identifier only.
  Screenshot evidence is pinned by serial or UDID, so combining the two surfaces requires a read-only mapping from the recorded serial or UDID to the selected Metro target.
  Establish that mapping by confirming exactly one connected device or booted simulator reports the recorded device name, using `adb devices -l` for Android or `xcrun simctl list devices booted` for a simulator.
  Report device attribution as `[UNCERTAIN]` when two targets share a device name and app identifier, and do not present the screenshot and the log as evidence about the same device.
- Record `METRO_HOST` as the selected Metro `host:port` before inspecting targets or collecting logs.
- Record `APP_ID` as the expected app identifier for Metro preflight and collection descriptor verification.
- Record `METRO_SELECTOR` as a unique device name or other unique target selector for Metro preflight and collection.
- Set `METRO_SKILL_DIR` to the absolute base directory of the active `rn-metro-console` skill.
- Confirm the requested evidence can be produced without changing external state, or identify the required separate authorization.
- Identify a disposable fixture before a flow creates, edits, or deletes records.

## Quick Steps

1. Map each acceptance criterion to a target identity, build-attribution status, and evidence surface before any device operation.
2. Route rendered-screen evidence to `rn-device-capture` with the selected Android serial or iOS UDID when supported.
   - For a simulator, first inspect `xcrun simctl list devices booted` and require exactly one booted simulator overall.
     Confirm that it matches the recorded identity.
   - When the helper cannot select an ambiguous target, report `[TOOL_FAILED]` instead of attributing automatic output to the acceptance run.
3. Route bounded JavaScript `console.*` evidence to `rn-metro-console`.
   - Run `node "$METRO_SKILL_DIR/rn-console.mjs" --host "$METRO_HOST" --device "$METRO_SELECTOR" --preflight` before collecting logs.
   - Confirm that its JSON descriptor identifies the recorded device and app identifier.
   - Report `[TOOL_FAILED]` when preflight cannot select one eligible React Native target.
   - Report device attribution as `[UNCERTAIN]` when the recorded serial or UDID cannot be mapped to that target, even when preflight selects exactly one.
4. When the criterion needs interaction, a UI tree, native logs, network output, recording, replay, or an external state change, report the required evidence surface and separate authorization in a handoff.
5. For a JavaScript log that comes from an interaction, state this handoff:
   - Record the target platform, device name, app identifier, serial or UDID when applicable, and build fingerprint source.
   - Use `--host "$METRO_HOST" --device "$METRO_SELECTOR"` for every collection.
     Confirm that `[rn-console] ready` identifies the recorded device and app identifier before reading the output.
   - Start `node "$METRO_SKILL_DIR/rn-console.mjs" --host "$METRO_HOST" --device "$METRO_SELECTOR"` in a background session with a bounded duration.
   - Wait for its `[rn-console] ready` status.
   - Have an authorized device operator trigger the path while the collector is active.
   - Wait for the collector to return before reading its output.
6. Record the starting state, observed result, evidence path, build-attribution status, and untested criteria.

## Evidence Selection

| Requested property                   | Evidence surface                    | What it proves                                             |
| ------------------------------------ | ----------------------------------- | ---------------------------------------------------------- |
| One rendered state                   | `rn-device-capture`                 | Pixels at the capture time                                 |
| JavaScript log event                 | `rn-metro-console`                  | Captured Metro console output                              |
| Accessibility tree or selector state | Authorized interactive-QA handoff   | Exposed runtime structure after the authorized interaction |
| Native log or network request        | Authorized platform-tooling handoff | Captured native or network output                          |
| User flow regression                 | Authorized reproducible-run handoff | The stated flow when build attribution is confirmed        |

## How It Works

```log
acceptance criterion
  -> device and fixture state
  -> smallest valid evidence surface
  -> separate authorization handoff when required
  -> artifact review
  -> verified, partial, or untested report
```

## Safety and Verification

Start with read-only discovery when it can identify the target state.
Require explicit user authorization before a handoff installs, uninstalls, launches, terminates, uses interactive automation, changes an external record, sends data, makes a purchase, publishes, or uses a production account.
The authorization must name the target build, device or simulator, account class, and disposable fixture when state can change.
Do not use an implicit installer to obtain an automation tool.
This reader does not:

- Install or uninstall an app.
- Launch an app.
- Use interactive automation.
- Change external state.

Report `[TOOL_FAILED]` when required interactive automation is unavailable.
Report `[PARTIAL]` when the available screenshot or log cannot prove the requested criterion.
Report build attribution as `[UNCERTAIN]` when no read-only fingerprint ties the evidence to the requested build.
Do not report command round-trip time or placeholder values as startup, frame, FPS, CPU, or memory measurements.

## Common Mistakes

| Mistake                                             | Fix                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Treating a screenshot as interaction evidence       | Use an authorized interactive-QA handoff for interaction claims.                                       |
| Putting device operation in this reader             | Report the required authorization and handoff instead.                                                 |
| Letting automatic target discovery choose a device  | Run Metro preflight with the recorded unique selector and verify the returned app identifier.          |
| Calling bare `rn-console.mjs`                       | Set `METRO_SKILL_DIR` and invoke `node "$METRO_SKILL_DIR/rn-console.mjs"`.                             |
| Reading an empty log window as proof of no defect   | Start the collector, wait for `[rn-console] ready`, then have an authorized operator trigger the path. |
| Attributing evidence to an unverified build         | Record the fingerprint source or report build attribution as `[UNCERTAIN]`.                            |
| Pairing a screenshot and a log by device name alone | A Metro descriptor carries no serial or UDID: map it to the recorded identity or report `[UNCERTAIN]`. |
| Reporting an issue quota                            | Report the actual coverage and findings, including zero findings.                                      |

## Reference

- [`rn-device-capture`](../rn-device-capture/SKILL.md)
- [`rn-metro-console`](../rn-metro-console/SKILL.md)

---

> If you need reusable device QA coverage across projects, open a Discussion in the RN Agents Kit repository.
