# Example — New Architecture readiness on a public app

A real run of [`rn-newarch-audit`](../../skills/rn-newarch-audit/SKILL.md) against a public React Native codebase, kept here so the claims in the README have something behind them.
Nothing in the audited project was modified: the skill reads `package.json`, the installed `node_modules`, and the app's own native sources, and prints a report.

## What was audited

|                      |                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Project              | [`RocketChat/Rocket.Chat.ReactNative`](https://github.com/RocketChat/Rocket.Chat.ReactNative) at `main`, 2026-08-19 |
| React Native         | 0.81.5                                                                                                              |
| Runtime dependencies | 117 (59 of them ship no native code)                                                                                |
| Tool                 | `rn-newarch-ready@0.1.1`                                                                                            |
| Files changed        | 0                                                                                                                   |

Rocket.Chat was chosen because it is large, actively maintained, MIT-licensed, and **already has `newArchEnabled=true`** in `android/gradle.properties`.
That last property is the point of the example. It is not a criticism of the project — it is the situation the audit exists for.

## Reproducing it

```bash
git clone --depth 1 https://github.com/RocketChat/Rocket.Chat.ReactNative.git
cd Rocket.Chat.ReactNative
pnpm install --frozen-lockfile --ignore-scripts
npx rn-newarch-ready@0.1.1
```

The install takes about 15 seconds and the audit runs in seconds; it needs `node_modules` because readiness is read from each dependency's own manifest, not from a list we maintain.

## The report

![Running the New Architecture readiness audit on Rocket.Chat's React Native client](./newarch-audit.gif)

The recording is the run below, unedited ([asciicast](./newarch-audit.cast)).

```log
React Native — New Architecture readiness
  react-native: 0.81.5
  New Arch enabled: android=yes ios=? expo=?

Archived / unmaintained native dependencies (plan a replacement):
  - @react-native-cookies/cookies@6.2.1
  - expo-av@16.0.8
  - react-native-background-timer@2.4.1
  - react-native-file-viewer@2.1.4

App-local native modules using only legacy APIs (migrate to TurboModule/Fabric):
  - android/app/src/main/java/chat/rocket/reactnative/input/ExternalInputModule.kt [ReactContextBaseJavaModule, BaseJavaModule]
  - android/app/src/main/java/chat/rocket/reactnative/storage/SecureStorage.java [ReactContextBaseJavaModule, BaseJavaModule]
  - ios/ExternalInputModule.m [RCT_EXPORT_MODULE]
  - ios/Libraries/A11yFlowModule.m [RCT_EXPORT_MODULE, RCT_EXPORT_METHOD]
  - ios/Libraries/SecureStorage.m [RCT_EXPORT_MODULE]

Summary: 23 supported, 23 likely, 10 unknown, 59 non-native, 4 archived
Verdict: needs-review
```

The two long lists — 23 likely-supported and 10 unconfirmed dependencies — are elided from the text above; the run prints them in full.

The command exits `1` on a `needs-review` verdict and `0` on `ready`, so the same invocation works as a CI gate.

## Reading it

**The flag is on and five of the app's own native modules are still on legacy APIs.** `newArchEnabled=true` says the New Architecture is turned on, not that everything runs natively under it; modules written against `ReactContextBaseJavaModule` or `RCT_EXPORT_MODULE` go through the interop layer. No configuration file can tell you which ones those are — it takes a scan of the app's native sources, and the report names the files.

**`likely` is not `supported`.** The 23 likely-supported entries come from the React Native Directory, whose flag describes the library, not the version you have installed. The audit keeps them in a separate tier instead of rounding them up.

**`unknown` is not `incompatible`.** Ten dependencies publish no readiness signal the audit can read. That is a gap in what can be proven locally, not a verdict against the library — treating those ten as blockers would be the most common way to make this kind of report wrong.

**What the audit could not determine** is printed rather than hidden: `ios=?` and `expo=?` mean the iOS and Expo sides of the New Architecture switch were not resolved on this project.

## This run changed the tool

The first pass reported `26 unknown, 1 archived`, with 15 of the unknowns being `expo-*` packages.
Investigating that found a defect in the audit, not in the app: the React Native Directory carries each flag in two places, and only the smaller half was being read — the curated fields report readiness on 931 of 2,658 libraries against 434, and mark 866 unmaintained against 140 archived. Every Expo SDK package declares the curated flag and none carry the other one.

Fixed in `rn-newarch-ready@0.1.1`, which is what produced the report above:

```diff
- Summary: 23 supported,  7 likely, 26 unknown, 59 non-native, 1 archived
+ Summary: 23 supported, 23 likely, 10 unknown, 59 non-native, 4 archived
  Verdict: needs-review
```

Same 115 classified dependencies before and after — 16 moved out of `unknown`, and the verdict did not change. A fix that had flipped `needs-review` to `ready` would have been the wrong fix.
