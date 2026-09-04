---
name: rn-metro-console
description: Use when you need to read a running React Native app's console output — confirm a log fired, watch console.warn/error, or verify runtime behavior — without opening the DevTools GUI. Reads logs from Metro's CDP endpoint; bounded by default. Read-only with respect to project source. Runs the bundled rn-console.mjs helper.
---

# RN Metro Console — Read App Logs via Metro's CDP

## Overview

Runs the bundled `rn-console.mjs` to collect a running RN app's `console.log/info/warn/error` output from Metro's Chrome DevTools Protocol (CDP) endpoint, and prints it for the agent to read.
It is **bounded by default** — it collects for a short window (or up to N logs) and then exits — so it never blocks the agent.
This is the **log half** of the verification loop; pair it with `rn-device-capture` (the screen) to confirm a change behaved at runtime.
It is read-only with respect to your source — it writes nothing, only prints.

## When to Use

- "watch the logs", "tail the console", "did this `console.log` fire?"
- Verifying a fix by observing runtime behavior, without the DevTools GUI
- `adb logcat` is unavailable (iOS) or too noisy

## Prerequisites / Setup

- Metro running (`npm start` / `npx react-native start`) on `localhost:8081`, with the app open on a simulator/device so a CDP target exists.
- Node ≥ 22 (built-in `WebSocket`). On older Node, install `ws` in the project; run the helper from the project root so `ws` resolves.

## Quick Steps (read-only on source)

### 1 — Locate the helper

`rn-console.mjs` ships **inside this skill's own directory**, not in the user's project.
After install (marketplace plugin or a project `.claude/skills/`) the working directory is the user's RN app, where a path like `skills/rn-metro-console/rn-console.mjs` does not exist.
When this skill is active you are given its absolute **base directory**; resolve the helper from that path:

```bash
SKILL_DIR="<this skill's base directory>"   # the absolute path provided when this skill loaded
```

### 2 — Capture (bounded)

Run from the user's project root (so a `ws` fallback resolves), invoking the helper by its installed path:

```bash
node "$SKILL_DIR/rn-console.mjs"                       # collect ~10s, all levels
node "$SKILL_DIR/rn-console.mjs" --duration 5          # collect 5s then exit
node "$SKILL_DIR/rn-console.mjs" --max 30              # stop after 30 logs
node "$SKILL_DIR/rn-console.mjs" --level error         # errors only
node "$SKILL_DIR/rn-console.mjs" --filter "Login"      # substring filter
node "$SKILL_DIR/rn-console.mjs" --device "com.example.app" --preflight  # print the selected target as JSON
```

Logs print to stdout; status (target, filters) prints to stderr.
Preflight prints a selected target descriptor to stdout and does not open a CDP connection.
For a live human-watched stream, add `--follow` (unbounded, until Ctrl-C) — do not use `--follow` for agent runs, it blocks.

### 3 — Read and interpret

Read the collected lines and tie them to the change you made.
An empty capture is not proof of "no bug" — the app may be idle or need a reload; recapture after triggering the path.

## How It Works

```log
Metro (localhost:8081)
  GET /json  ──► CDP targets ──► WS: Runtime.enable + Console.enable
                                      └─► Runtime.consoleAPICalled ──► decode args
                                                                       filter (level/substring)
                                                                       bound (duration/max) ──► stdout
```

## Commands

| Intent                       | Command                                               | Mutates source? |
| ---------------------------- | ----------------------------------------------------- | --------------- |
| Collect ~10s (all levels)    | `rn-console.mjs`                                      | no              |
| Collect for N seconds        | `rn-console.mjs --duration <n>`                       | no              |
| Stop after N logs            | `rn-console.mjs --max <n>`                            | no              |
| Bound discovery before ready | `rn-console.mjs --setup-timeout <n>`                  | no              |
| Errors only                  | `rn-console.mjs --level error`                        | no              |
| Substring filter             | `rn-console.mjs --filter <text>`                      | no              |
| Pick a target                | `rn-console.mjs --device <name-or-appId>`             | no              |
| Preflight one target         | `rn-console.mjs --device <name-or-appId> --preflight` | no              |
| Live stream (human, blocks)  | `rn-console.mjs --follow`                             | no              |

Invoke each form via `node "$SKILL_DIR/rn-console.mjs"` (see Quick Steps); the `rn-console.mjs` names above show only the arguments.
Metro's `/json` and the CDP `Runtime`/`Console` domains are invoked only to read logs; the skill's value is the curated, bounded capture + interpretation, not those endpoints.

## Interpreting the Logs

- Tie each log to the change you just made — did the expected message fire, at the expected level?
- Pair with **[`rn-device-capture`](../rn-device-capture/SKILL.md)** — the screen plus the logs is a complete runtime check.
- An empty or all-noise capture often means the app was idle or not reloaded — trigger the path, then recapture.

## Safety & Verification

- Read-only with respect to project source — nothing is written and nothing to undo, so the usual clean-tree precondition and `tsc`/lint/test gates do not apply.
- Bounded by default; `--follow` is the only unbounded mode and is for humans, not agents.

## Common Mistakes

| Mistake                                          | Fix                                                                                     |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Using `--follow` in an agent run                 | It streams forever and blocks — use the bounded default (`--duration`/`--max`)          |
| Metro not running                                | `npm start` first — `localhost:8081` must be open                                       |
| `/json` returns an empty list                    | The app is not running or not connected to this Metro instance                          |
| Empty capture read as "no bug"                   | The app may be idle or need a reload — trigger the path and recapture                   |
| Calling `skills/rn-metro-console/rn-console.mjs` | That repo-relative path does not exist after install; use `"$SKILL_DIR/rn-console.mjs"` |

## Reference

- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) — the `Runtime` (`consoleAPICalled`) and `Console` domains
- [React Native / Metro debugging docs](https://reactnative.dev/docs/debugging) — cite, do not copy

---

> This skill just lets the agent read the app's logs.
> If you'd want log capture wired into CI or your dev loop rather than run by hand, say so at the repo Discussions (<https://github.com/AndrewDongminYoo/rn-agents-kit/discussions>) so it gets prioritized.
