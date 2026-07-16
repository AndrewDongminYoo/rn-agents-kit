---
name: rn-device-capture
description: Use when an agent needs to see the running React Native app — verify a screen rendered as intended, capture the iOS simulator or Android emulator, or screenshot an iOS 17+ physical device. Read-only with respect to project source; writes only a screenshot artifact. Runs the bundled device-shot.sh helper.
---

# RN Device Capture — Screenshot the Running App for the Agent

## Overview

Runs the bundled `device-shot.sh` to capture the screen of a connected target — Android device/emulator, booted iOS simulator, or iOS 17+ physical device — to a path under `logs/` (default `logs/screenshot.png`) that the agent can immediately `Read`.
The helper prints the saved path to stdout, and never overwrites an existing default capture — always read the printed path.
This closes the visual feedback loop: the agent cannot watch the app, but it can read the screenshot and reason about whether a change rendered as intended.
It is read-only with respect to your source — the only thing written is the screenshot artifact.

## When to Use

- "show me the screen", "screenshot the simulator/emulator", "what does the app look like now?"
- "did this screen render correctly?", "is the new layout right?" after a change or reload
- Capturing an **iOS 17+ physical device** screen, where there is no obvious official CLI path

## Prerequisites / Setup

- A booted target: an Android device/emulator (`adb`), a booted iOS simulator (Xcode `simctl`), or an iOS 17+ device.
- Tools are detected at runtime; only the target you use needs its tool installed.
- **iOS 17+ physical device only:** capture goes through a RemoteXPC tunnel.
  Install `pymobiledevice3` (e.g. `pipx install pymobiledevice3`) and, in a **separate terminal left open**, run:

  ```bash
  sudo pymobiledevice3 remote tunneld
  ```

  then capture. Simulator and Android need no tunnel.

## Quick Steps (read-only on source)

### 1 — Locate the helper

`device-shot.sh` ships **inside this skill's own directory**, not in the user's project.
After install (marketplace plugin or a project `.claude/skills/`), the user's working directory is their React Native app — a project-relative path like `skills/rn-device-capture/device-shot.sh` will not exist there.
When this skill is active you are given its absolute **base directory**; resolve the helper from that path.
Set `SKILL_DIR` to it once:

```bash
SKILL_DIR="<this skill's base directory>"   # the absolute path provided when this skill loaded
```

### 2 — Capture

Run from the user's project directory (so the screenshot lands in their app), invoking the helper by its installed path:

```bash
bash "$SKILL_DIR/device-shot.sh"           # auto-detect target
bash "$SKILL_DIR/device-shot.sh" sim       # booted iOS simulator
bash "$SKILL_DIR/device-shot.sh" android   # Android device/emulator
bash "$SKILL_DIR/device-shot.sh" ios       # iOS 17+ physical device
```

The saved path is printed to stdout, relative to the current directory — i.e. inside the user's project, not the skill directory.
With no output path given it is `logs/screenshot.png`, or a timestamped `logs/screenshot-<YYYYMMDD-HHMMSS>.png` when that file already exists (so a prior capture is never overwritten).
Pass an explicit path as the last argument to choose the name yourself (it is used verbatim and may overwrite).
Always `Read` the path that was printed — do not assume `logs/screenshot.png`.

### 3 — Read and interpret

`Read` the printed PNG path, then judge it against the intended change.
If the screen looks wrong, capture again after a moment (timing) or route to logs (see Interpreting the Capture).

## How It Works

```log
device-shot.sh
  detect target ──► dispatch ──► write PNG ──► validate (non-empty + PNG magic)
   auto/android      adb / simctl /   logs/screenshot.png            │
   /sim/ios          pymobiledevice3  (timestamped if it exists)     ▼  agent reads the printed path
                                                              + interprets vs. intended change
```

## Commands

| Intent                  | Command                                   | Mutates source? |
| ----------------------- | ----------------------------------------- | --------------- |
| Auto-detect and capture | `device-shot.sh`                          | no              |
| iOS simulator           | `device-shot.sh sim`                      | no              |
| Android device/emulator | `device-shot.sh android`                  | no              |
| Specific Android device | `device-shot.sh -s <serial> android`      | no              |
| iOS 17+ physical device | `device-shot.sh ios`                      | no              |
| Specific iOS device     | `device-shot.sh -u <udid> ios`            | no              |
| Custom output path      | `device-shot.sh <target> path/to/out.png` | no              |

Invoke each form via `"$SKILL_DIR/device-shot.sh"` (see Quick Steps); the `device-shot.sh` names below show only the arguments.
`adb` / `simctl` / `pymobiledevice3` are invoked only to read the screen; the skill's value is the curated capture + interpretation loop, not those commands.

## Interpreting the Capture

- Compare the screenshot to the change you just made — did the expected element render, in the expected place?
- A static image cannot show timing, animation, or gesture state; if the screen looks mid-transition, recapture after a beat.
- If something rendered wrong, the cause is often in the logs — pair this with **[`rn-metro-console`](../rn-metro-console/SKILL.md)** (the log half of the verification loop) to read `console.*` output alongside the screen.

## Safety & Verification

- Read-only with respect to project source — there is nothing to undo, so the usual clean-tree precondition and `tsc`/lint/test gates do not apply.
- The screenshot is an output artifact; with no path given it is `logs/screenshot.png`, or a timestamped name when that already exists — a default capture never overwrites a prior one.
- Recommend adding `logs/` to the target project's `.gitignore`.
- A capture that produces no valid PNG fails loudly and removes the broken file rather than leaving a 0-byte image to misread.

## Common Mistakes

| Mistake                                                    | Fix                                                                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Assuming the newest capture is at `logs/screenshot.png`    | If that file already existed, the new default capture goes to a timestamped name — always `Read` the path printed to stdout    |
| Assuming `auto` picked the device you meant                | With several targets connected, name the target (or `-s <serial>` for Android)                                                 |
| Concluding a bug from a static image                       | It can't show timing/animation — recapture, or check logs                                                                      |
| Expecting iOS-device capture to work without the tunnel    | iOS 17+ needs `sudo pymobiledevice3 remote tunneld` in a separate terminal                                                     |
| Two iOS devices attached with no selector                  | `device-shot.sh ios` fails fast and asks for `-u <udid>` — otherwise `pymobiledevice3` would prompt and hang non-interactively |
| Calling `skills/rn-device-capture/device-shot.sh` directly | That repo-relative path does not exist after install; run `"$SKILL_DIR/device-shot.sh"` from this skill's base directory       |

## Reference

- [`adb` (Android Debug Bridge)](https://developer.android.com/tools/adb)
- the `simctl` tool — run `xcrun simctl help` for its command reference
- [`pymobiledevice3`](https://github.com/doronz88/pymobiledevice3)

---

> This skill just lets the agent see the screen.
> If you'd want capture wired into CI or your dev loop rather than run by hand, that's the kind of thing the planned paid tier covers — register interest at the repo Discussions (<https://github.com/AndrewDongminYoo/rn-agents-kit/discussions>) so it gets prioritized.
