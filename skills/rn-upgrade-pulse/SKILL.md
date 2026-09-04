---
name: rn-upgrade-pulse
description: Use when a React Native or Expo upgrade is being planned and you need the current upgrade surface recorded as evidence — installed versions, package-manager and lockfile candidates, native ownership, CI verification gaps. Wraps the bundled, tested rn-upgrade-pulse.mjs and stable read commands; read-only, and it never selects a target version. For a fast setup overview use rn-project-snapshot, and for New Architecture readiness specifically use rn-newarch-audit.
---

# RN Upgrade Pulse

## Overview

This skill records a fixed set of upgrade inputs before an agent changes a React Native or Expo project: the manifests, lockfiles, app-level and native configuration, Node pins and CI files that `references/commands.md` names, and nothing else.
It reports installed version evidence, package-manager and lockfile candidates, native ownership, configuration seams, and the verification commands the project already declares.
It does not select a target version, arbitrate between competing sources, or apply an upgrade.

## When to Use

- "what will this React Native upgrade touch?"
- "assess this Expo SDK upgrade before we start"
- "prepare an upgrade plan for this app or workspace"
- "find the risky native and dependency areas before a version bump"

## Prerequisites

- An identified repository and app root.
- The app root inside a git worktree: native ownership evidence comes from `git check-ignore` and `git ls-files`, which fail outside one.
- `rg` (ripgrep) for the discovery commands that search by pattern, and Node.js 18.3.0 or later for the bundled helper, which uses `node:util` `parseArgs`.
- Access to the project manifests, lockfiles, native directories, and existing CI scripts.
- A redacted copy of every file whose contents a row prints. No such row reads an original: the user decides once per file what a copy contains, and a file with no copy is reported as an unread input rather than read anyway.
- The bundled helpers are the exception, because each reads a file itself and prints a bounded result rather than the file. The rows that take an original need no copy, and `references/commands.md` is where they are named; do not ask for one and do not skip those files for want of one.

## Quick Steps

Each step names rows from `references/commands.md` by intent.
That file holds every command body, so a glob set has one home.

### 1 — Set the selected paths

```bash
REPO_DIR=/absolute/path/to/repository
APP_DIR="$REPO_DIR/path/to/app"
SKILL_DIR=/absolute/path/to/this/skill
```

Take `REPO_DIR` and `APP_DIR` from the user. When a workspace holds several candidate apps, present the candidates and ask; choosing one is the selection this skill does not make.

### 2 — Discover the inputs

Run `List candidate app manifests`, `Find lockfiles`, `Find package-manager configuration`, `Find external Node pins`, `Find Plug'n'Play loaders`, `Find CI configuration`.
Every later step draws its paths from a discovery row's output, whether that row ran here or in step 4, so a row skipped anywhere silently empties the set that depends on it.
Declared scripts arrive with the manifest projection in step 5 and are not discovered separately.

### 3 — Resolve installed versions

Run `Read installed package versions`.

The output's `installMode` carries what the helper could establish about the install, and carries no path: the nearest top-level `nodeLinker` declaration at or above the app root as `linker`, what the same walk found of a Plug'n'Play loader, a `.yarnrc.yml` and a `yarn.lock` as `loader`, `yarnConfig` and `yarnLock`, each `present`, `absent` or `unreadable`, that lockfile's `yarnLockGeneration`, and `ambiguous` when a file could not be read or a value could not be interpreted. A file that exists and cannot be read is `unreadable` rather than `absent`, so the third condition below stays closed for a project that plainly has Yarn evidence.
It reports those and decides nothing; the Evidence Rules say what they license.
Plug'n'Play keeps the dependency graph out of `node_modules`, and reading it requires executing the project's own loader, which this skill does not do, so under an active Plug'n'Play install every package comes back `unavailable`.
A resolution that succeeds anyway came from a `node_modules` tree whose standing that evidence has to settle.

The helper reports each of `react`, `react-native` and `expo` as one of five states:

| Status        | Meaning                                                                      | Fields beyond `name` and `status`                        |
| ------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------- |
| `resolved`    | a package manifest was read, and the app's own manifest declares the package | `version`, `manifestPath`, `declaredIn`, `declaredRange` |
| `undeclared`  | a package manifest was read, but the app does not declare it                 | `version`, `manifestPath`                                |
| `unverified`  | a package manifest was read, and the app manifest could not be read to check | `version`, `manifestPath`, `reason`                      |
| `unavailable` | nothing resolved                                                             | `reason` only — no path exists to report                 |
| `unreadable`  | something resolved but carries no usable version                             | `manifestPath`, `reason`, and the declaration            |

`resolvedName` appears on any entry whose installed manifest names a different package than the one requested, which is what an alias such as `"react-native": "npm:react-native-tvos@…"` looks like. Report the resolved name, not the requested one, as the package the version belongs to.
The `--app-dir` output also carries `appManifest`, the status and reason of the app's own `package.json`.

`undeclared` says only that the app's own manifest does not list the package. A workspace hoist, a peer that npm installed on its own, and a transitive copy all look identical here, so report it as not directly declared and leave the provenance `[UNCERTAIN]` unless a lockfile entry settles it.
An entry carries the app's declaration for that package whenever the app manifest could be read, including a failed one.
Read the two together: the same `MODULE_NOT_FOUND` covers a package this app never declared and a declared package whose install is incomplete.
Do not report an app as bare React Native from a resolution failure alone.
`ERR_INVALID_PACKAGE_CONFIG` for every package names the app's own `package.json`: Node refuses to resolve anything while that file is unparseable, so read it with `Read a discovered manifest` before reading anything into the resolution.

### 4 — Establish the native surface

Run `Find app-level configuration`, then read any discovered `react-native.config.*` before running an ownership command: it can move `project.ios.sourceDir` or `project.android.sourceDir`, and `ios` and `android` are the native roots only when it does not.

With the roots known:

- Resolve each platform's root independently: the `sourceDir` its configuration declares, or `$APP_DIR/ios` and `$APP_DIR/android` for a platform it does not mention. A configuration that moves one platform leaves the other on its default.
- Run `Report whether a native root exists` for each resolved root. A root it reports as `outside-repository` gets no further row: a declared `sourceDir` can be absolute, climb out with `..`, or be a symlink pointing out, and scanning one would walk outside the repository entirely. Report that platform's native surface as `[UNCERTAIN]` and name the declared value. Otherwise run `Inspect a native root's tracking state` for that root whether it exists or not: a sparse checkout omits the directory while the index still carries it, and only the two answers together separate that from a root the project never had.
- For a root that exists, set `NATIVE_ROOT` to it and run `Scan a native root`.
- Run `Read a path's ignore rule` for that root and for each path its scan returned. A rule such as `ios/*` leaves the root unmatched while ignoring everything inside it, so the root alone does not establish generation.
- Obtain a redacted copy of the app manifest, of the `eas.json` app-level discovery returned if any, and of each discovered CI configuration, set `REDACTED_MANIFEST`, `REDACTED_EAS_CONFIG` and `REDACTED_CI_CONFIG`, and run `Find generation and build declarations` over them in turn. This step reads file contents, so it waits for the copies exactly as step 5 does.

### 5 — Read every discovered input

For each path that steps 2 to 4 printed, run its row.

The rows that take the original need no copy. `references/commands.md` names them and the variable each one reads; set those from discovery output and run them first, so a file one of them covers is never waiting on a copy.

Every other row prints what a file contains, so it takes a redacted copy: obtain one, set the matching `REDACTED_` variable, and run `Inspect selected text lockfile entries`, `Read pnpm workspace configuration` or `Read Yarn configuration keys`, `Read a native input`, `Find generation and build declarations`, `Inspect CI Node and verification inputs`, `Find local CI references`.

Ask for the copies as one list, naming every path discovery returned and what each file is being read for. A second request is expected and is not a failure of the first: `Find local CI references` names an included or uploaded pipeline that no earlier step could have known about, so that file's copy is requested after it appears. Ask once per round of discovery rather than once per file.
A path whose row takes a copy and has none is reported as an unread input with that reason; it is not read from the original, and it is not counted as skipped for any other reason. A path that one of the original-reading rows covers never enters that count, because it needs no copy — and a file both kinds of row read, as `eas.json` is, is unread only for the part the copy would have supplied.

- Assign variables from discovery output only. A path that discovery did not return is not an input, and reporting it as skipped inflates the coverage count. `Find local CI references` is itself a discovery row, so a repository path it returns is discovery output and is assigned like any other.
- `bun.lockb` is binary: record it as a skipped input and take the version from an installed package manifest.
- A discovered `eas.json` takes `Read an eas config` on the original for the EAS CLI range. It accepts strict JSON only; a file using JSON5 comments or trailing commas is refused and recorded as unread, the same limit `rn-eas-profile-audit` states for the same file. That adds evidence rather than replacing a row: the same file still takes `Find generation and build declarations` on its redacted copy, and everything addressed by a build profile stays unread.
- A `package-lock.json` or `npm-shrinkwrap.json` takes `Read an npm lockfile` on the original and needs no copy. It reports the **locked** version of react, react-native and expo as typed evidence, and nothing else from the file; record the rest of it as unread. A locked version is what an install would produce, not proof that it is on disk: `npm install --package-lock-only` writes the entry without touching `node_modules`, and `--omit` leaves an entry for something deliberately not installed. Step 3's resolution is what says what is installed, and the two disagreeing is evidence rather than a contradiction to reconcile.
- The lockfile row is given `APP_DIR`, so a lockfile describing a workspace resolves for the selected app: its own copy where it has one, the root hoist otherwise, and nothing for a package its own entry does not declare. A lockfile that does not describe the selected app — no entry for it, or an app outside the tree the file covers — carries no version evidence; record it as an unread input and take the versions from step 3 instead.
- A `pnpm-lock.yaml` takes `Read a pnpm lockfile` on the original first, and needs a copy only where that row emitted no version — the `REDACTED_LOCKFILE` entry in `references/commands.md` states when that is. It reports the lockfile version and the version the selected importer resolved for react, react-native and expo, and nothing else from the file; record the rest of it as unread. It replaces the extraction row for this format rather than adding beside it, because what that row matched was a `packages` key, which is the whole store rather than what the app resolves.
  It takes the same size bound as the npm lockfile, because a lockfile is legitimately large and this reader's cost is linear in the file. Above it the file is refused unread; record it as a skipped input and take its versions from the extraction row on a copy, as the formats with no adapter do.
  Its row is given `APP_DIR`. A pnpm lockfile always states its importers separately, so a file with one importer answers without the app and a file with several answers only for the one the app names; for an app the file does not describe, the version fields come back rejected and the versions come from step 3 instead.
  The lockfile version is a member of a closed set, and it is a guard rather than one more field: an importer's layout is what its version declares, so a file declaring a version outside the set has no importer read at all and carries no version evidence. Record it as an unread input and name `lockfileVersion` among the rejected fields as the reason. The declared version itself is not reported: a value the type refused is exactly what this helper does not print, and no row reads that field from a copy either, so the version stays unexamined rather than recovered from somewhere else. A file that states no version reads the same way, because every `pnpm-lock.yaml` states one.
- Every other text lockfile is read by extraction, not whole: record it as partially read and name the pattern, so a file with no matching entry stays distinguishable from one that was never opened.
- A large native input such as `project.pbxproj` or `Podfile.lock` takes `Extract a large native input` instead of the whole-file read.
- An Expo `Podfile` reads its settings from `Podfile.properties.json`; read that sidecar too, or the assessment sees the setting consulted without its value.
- The helper reports a manifest it cannot use as `missing`, `unreadable`, or `unparseable` rather than failing, so those become skipped inputs with a reason. `missing` means the file is absent; the other two mean it exists and could not be used.

Then report required decisions, native surfaces, dependency risks, and verification gaps.
Open the report with an input summary: how many inputs were discovered, how many were read whole, how many were read in part, how many were skipped, and why each skipped input was skipped. A lockfile or a large native input read by extraction belongs in the partial count, not in either of the other two.

## How It Works

```log
project root
  -> version and lockfile evidence
  -> workspace and native ownership
  -> existing checks
  -> upgrade assessment
```

## Commands

The full intent → command table is in `references/commands.md`.
Every row there is read-only with respect to the target project.
The bundled `rn-upgrade-pulse.mjs` reads a manifest or resolves installed versions and prints JSON, and `evidence.mjs` reads one file of a kind an adapter claims and prints typed evidence. The verification command runs every test file this skill ships, so it covers both helpers rather than the older one alone.

## Evidence Rules

- Record an installed version only from a `resolved` package.
  Report every other status with the fields it carries — its reason where one is reported, its resolved path where one exists, its version where one was read — and report that version as installed but unattributed, with its provenance `[UNCERTAIN]`.
  A resolved path outside `REPO_DIR` invalidates the resolution.
  So does install-mode evidence that does not put a `node_modules` graph behind the resolution. The plain resolver cannot see a Plug'n'Play graph, so a version it returns under one came from a tree whose relationship to the install is unestablished.
  Record an installed version only when `installMode.ambiguous` is `false` and one of three things holds: `linker` is `node-modules` or `pnpm`; `yarnLockGeneration` is `classic` with `yarnConfig` and `loader` both `absent`, since Yarn 1 has no linker setting and a Berry configuration beside it would override the reading; or there is no Yarn evidence at all, meaning `yarnConfig`, `yarnLock` and `loader` are all `absent` and there is no `linker`.
  Report `[UNCERTAIN]` otherwise and read the `yarn.lock` entry alongside, naming the field that decided it. `ambiguous` disqualifies a recognised linker too: a nearer `.yarnrc.yml` that could not be read may override the one that was, or stop Yarn from running at all.
  Name the files from discovery output rather than from this helper, which reports presence and not paths.
- Do not inspect binary `bun.lockb` for version evidence.
- This skill reports evidence; it does not arbitrate between sources.
  Read every manifest and every text lockfile that discovery returns, report each with its path, and do not choose a project root, a lockfile precedence, an authoritative dependency graph, or a target version.
  While more than one lockfile candidate exists and the user has not chosen, report which one governs as `[UNCERTAIN]`; reading them all is not a selection.
- Read every distinct manifest discovery returned and report package-manager, Node, and workspace metadata per path rather than merging the values.
  When `pnpm-workspace.yaml` exists, run `Read a pnpm workspace catalog` on the original for the default catalog's react, react-native and expo ranges, and read the file whole from a redacted copy for the workspace globs and any named catalog beside them.
  The reader applies YAML merge keys before it selects and validates the default catalog, so typed evidence includes a default entry supplied through a merge key.
  A manifest that uses the catalog writes a `catalog:` specifier where a range would be, which the manifest row reports as a rejected field: the registry does not resolve that specifier and the manifest does not hold the version. The two files carry one answer between them, so report the catalog range as the declared one and name both paths; a rejected `catalog:` field is the manifest declining to state a range rather than a manifest that could not be read.
  A workspace file the parser did not read whole is refused rather than partly read, and recorded as an unread input: an unresolved tag leaves a value the parser did not interpret, wherever in the file it sits, and a duplicate key or a bad indent is the same answer. That is the reader refusing what it did not understand, which is a different question from whether pnpm would accept the file — the entry above under Not Examined is that second one.
  Every spelling that selects the default catalog joins this way, not the bare one alone: pnpm trims the text after `catalog:` and reads an empty suffix as `default`, so `catalog:`, that same specifier with trailing whitespace, and `catalog:default` all name the catalog this row reads. A suffix that names anything else is a named catalog, and its range stays unexamined.
  A `.yarnrc.yml` takes two rows. `Read a Yarn linker` runs on the original and reports the linker that one file declares, validated against the three values Yarn has; `Read Yarn configuration keys` still reads named keys from a redacted copy for the settings no schema names, and never the file, because it can hold `npmAuthToken`.
  What that row returns is what a single file declares, not the setting Yarn would use. The effective linker is still `installMode` from step 3, which walks the ancestors and merges them: where the two disagree, the walk is the one the install-mode rule above reads, and the declaration is evidence about one file. A `declaredLinker` the type refused is a file declaring something that is not one of Yarn's linkers, which is worth reporting as such rather than as an absent setting.
  A discovered Node pin takes `Read an external Node pin` on the original and needs no copy. It reports one field, the pinned Node version, and reads each of the five names by the rules its own format has: nvm's for a `.nvmrc`, asdf's line format for a `.tool-versions`, and a TOML parser for a `mise.toml`.
  A file that declares the pin more than once, or that the reader cannot resolve, comes back uncertain with its reason rather than with a value; record it as an unread input and name the reason. A prerelease pin is refused by the version type, so a project on one is reported as declaring a pin this skill did not read rather than as having none.
- Record declared `overrides`, `resolutions`, and `pnpm` override configuration as dependency risk evidence.
  A lockfile shows the resulting version, not the constraint that produced it.
- Read the `expo` object from the app manifest before reporting native ownership for an Expo app.
- Establish that a native directory exists before reading its tracking state: an absent directory and an untracked one both produce empty `git ls-files` output.
  Read `react-native.config.*` before treating `$APP_DIR/ios` and `$APP_DIR/android` as the native surface, report the declared source directories verbatim, and scan each one. A configuration that computes a path rather than stating one leaves that platform on its default root, with the surface reported `[UNCERTAIN]`.
  Read configuration, ignore rules, and declared `prebuild`, `run:ios`, `run:android`, or EAS Build commands from the manifest, `eas.json`, and the discovered CI configuration before reporting ownership, and report `[UNCERTAIN]` when those sources do not establish it.
- Keep dependency, CocoaPods, and platform build output out of native discovery on both platforms.
  `ios/build`, `ios/DerivedData`, and `android/**/build` hold generated copies of the same file names, and the native rows read past every ignore file, so only the explicit excludes prune them.
- Read a small configuration file whole and extract only the version-bearing lines from a large one, reporting such a file as partially read and naming the extraction used.
- Read every discovered external Node pin and every discovered CI configuration before recording a value from it.
  When a CI configuration names a repository path as an include, template, or uploaded pipeline, read that file too; a reference that resolves to no repository path is external, and is reported as unread rather than as an unresolved local one.
  Do not infer recursive include expansion or evaluate expressions.
  Report CI verification evidence as `[UNCERTAIN]` when the discovery row returned no CI configuration, a selected file cannot be read, or a local reference is unresolved.
- A proposed target is `[UNCERTAIN]` until the user provides it or authorizes current release research.
- The discovery rows in `references/commands.md` are the input set, and the counts are reported over that set.
  State discovered, read, and skipped counts with a reason for every skipped input, and report anything outside the set as unexamined rather than as absent: a value this skill did not look for is not a value the project does not have.

## Safety and Verification

This skill reads files and reports an upgrade assessment.
It does not run package installation, modify manifests, regenerate native projects, update CocoaPods, or build an app, and it executes no code the project owns.
Running the target project's declared checks belongs to a later, separately authorized step, because those scripts build, generate, or install.
Report them as the verification the upgrade will need, and name each one, rather than running any of them here.

Verify the bundled helpers with:

```bash
node --test "$SKILL_DIR"/*.test.mjs
```

## Not Examined

These sit outside the input set by design. Report each as unexamined when it could carry evidence, and never read its absence as the project not having it.

- A Plug'n'Play dependency graph. The loader is reported; it is never executed, so versions for such a project come from `yarn.lock`.
- Binary `bun.lockb`.
- A lockfile entry whose key syntax none of the extraction patterns match. They cover the yarn classic, yarn berry, npm `node_modules/` and pnpm slash-key forms; a format outside those is unexamined rather than absent. Which formats it is still the version reading for is stated by the `REDACTED_LOCKFILE` entry in `references/commands.md`, and its pnpm patterns stay in place for the files that entry still sends here.
- CI configuration reached through a provider's own continuation mechanism, such as a CircleCI setup workflow's `configuration_path`.
- A file named from inside a native project file, such as an `.xcconfig` that a `project.pbxproj` assigns as a base configuration.
- App-level configuration deeper than the app root's own directory: `Find app-level configuration` stops at depth 1, and everything below is reached only through an active native root.
- A CI system outside the fixed locations the CI row tests — Jenkins, Travis, Bitbucket Pipelines, Xcode Cloud, and any workflow in a subdirectory of `.github/workflows`.
- A mise configuration at any path other than `mise.toml` or `.mise.toml`. mise reads more than those two — a `local` variant beside them, and a `config.toml` under a `.config` or `.mise` directory — and both the discovery row and the evidence adapter take only the two names, so a pin declared elsewhere is unexamined rather than absent.
- A pnpm catalog other than the default one. The default catalog is read from either place pnpm accepts it, `catalog` or `catalogs.default`, including entries supplied through YAML merge keys. A file defining it both ways is reported unreadable because pnpm refuses such a file outright. Any other entry under `catalogs` is selected by a manifest writing `catalog:<name>`, and that name is project-owned text with no place in the output, for the reason no `eas.json` build profile is addressed either. The redacted copy is where those are read.
- Everything in a `pnpm-lock.yaml` outside the two things that have a type. No field addresses `packages`, `snapshots`, `settings`, `overrides` or `patchedDependencies`, so a resolution's `tarball` and a dependency's `specifier` are not read and no copy of the file is requested; that is what lets its row take the original. A package the importer resolved to something that is not an exact release — a `link:` to a workspace sibling, a prerelease — is reported as a rejected field rather than as a package the app does not have.
- A pnpm importer other than the one the app names. A workspace lockfile holds one answer per importer and the selected app picks between them, so a sibling's resolution is unexamined rather than absent.
- The declared version of a `pnpm-lock.yaml` the reader's closed set does not hold. The typed row refuses that field rather than printing it, and the extraction row matches react, react-native and expo entries, so no row produces the value; what is reported is that the field was rejected.
- The importers of a `pnpm-lock.yaml` whose declared version is outside the closed set the reader established. They may hold versions the reader could parse, and it does not read them at all: an importer's layout is what its version declares, so a value read under an unestablished one would be a definite reading of an assumption.
- Which `.yarnrc.yml` declared the linker `installMode` reports. That helper reports presence rather than paths, so the file is not named in its output; run `Read a Yarn linker` over the discovered `.yarnrc.yml` paths when the report needs to say which one declares.
- Everything in a Node pin file beside the pin itself. The row returns one validated version, so another tool's line in a `.tool-versions` and a `mise.toml`'s `[env]` table are not read and no copy of either is requested. That is what lets the row take the original.
- A Node pin in a `mise.toml` declared under a backend identifier other than `node`, `nodejs` or `core:node`. A backend-qualified `[tools]` key is ordinary mise, and the reader takes a closed set of names rather than a pattern over backends whose meaning it has not established.
- Whether the tool that owns a file would accept it. A field reports what the file declares, and a reader here validates the value it emits and nothing beside it, so a file its own tool refuses for a reason outside the schema still yields evidence. Two instances are measured: a `mise.toml` calendar day past the end of its month, which the bundled TOML parser normalises and mise rejects; and a `pnpm-workspace.yaml` catalog entry that is not a string, which makes pnpm refuse the workspace while the entries this schema names are still read. The alternative is worse in the direction that matters, because refusing a file over a value no field addresses turns a plainly declared range into a wrong absence. This holds for every adapter, not only those two: a malformed sibling entry in a manifest's `dependencies` or a lockfile's `packages` is read the same way.
- Any package other than `react`, `react-native` and `expo`. No installed version is collected for the rest of the dependency graph.
- Anything inside a directory the project ignores, for every row except the two native ones: an ignored directory is pruned before an include glob can match under it.
- Any discovered file whose row takes a redacted copy, where none was supplied. It is reported as an unread input with that reason, and its absence from the evidence says nothing about what it declares. This does not cover a file read by a row that takes the original: those need no copy, so a missing copy is not a reason to report one of them unread.
- The contents of a manifest's `expo` object, and of its `scripts`. Both project to key names only, because neither has a shape the projection can bound.
  The `expo` values are recovered by reading a redacted copy of the manifest itself: set `REDACTED_NATIVE_INPUT` to that copy and run `Read a native input`. `app.json` does not stand in for it — the package-level settings such as `autolinking` and `doctor` live only in `package.json`, and they affect native module resolution. A `scripts` command line has no such recovery and is read from a redacted copy only when the assessment needs it.
- A literal credential a manifest stores under `pnpm`. That field is a schema the package manager owns, with no credential field in it, and an Evidence Rule needs its override configuration by value, so it is projected by value and a project that puts something else there is unexamined.
- A binary `Info.plist`. `Read a native input` emits it verbatim; convert it outside this skill if its values are needed.
- A native root outside the repository, whether declared absolutely, reached with `..`, or reached through a symlink beneath the repository. It is reported as such and never scanned.
- A `sourceDir` a configuration computes rather than states literally. The configuration file is read, never evaluated, so a computed path leaves the native root at its default with the surface reported `[UNCERTAIN]`.

## Common Mistakes

| Mistake                                                     | Fix                                                                    |
| ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| Guessing the app root in a workspace                        | Identify the app that owns the selected native build.                  |
| Reading an undeclared package as the app's own              | Report it as not directly declared, with the provenance `[UNCERTAIN]`. |
| Using a package manifest as resolved-graph proof            | Read the lockfile or installed dependency metadata.                    |
| Treating a native directory as ownership proof              | Read its configuration, ignore rules, and generation commands.         |
| Reading empty `git ls-files` output as "generated"          | Check the directory exists first; absent and untracked look the same.  |
| Counting a path discovery never returned as a skipped input | Assign every variable from discovery output.                           |
| Applying generic native commands                            | Use only commands that the target project declares or documents.       |
| Treating a successful JavaScript test as native-build proof | Report native build verification as a separate requirement.            |

## Reference

- [React Native upgrade guide](https://reactnative.dev/docs/upgrading)
- [Expo upgrade guide](https://docs.expo.dev/workflow/upgrading-expo-sdk-walkthrough/)

---

> If you want recurring upgrade assessments across projects, open a Discussion in the RN Agents Kit repository.
