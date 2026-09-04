---
name: rn-ci-artifact-audit
description: Use when you need a read-only inventory of React Native or Expo GitHub Actions artifact evidence before a workflow review.
---

# RN CI Artifact Audit

## Overview

This read-only reader collects raw CI evidence for iOS Simulator and Android emulator artifact workflows.
It shows where a workflow, app configuration, package metadata, and artifact references declare values.
It does not determine execution order, command success, artifact retention, EAS authentication, profile inheritance, or installability.

Use a tested CLI or direct execution evidence in a separate follow-up when a conclusion needs deterministic evaluation.

## When to Use

- "inventory the evidence in this mobile artifact workflow"
- "show the CI references before I review an Expo artifact pipeline"
- "find artifact, EAS, and package-manager declarations without changing the workflow"

## Prerequisites

- An existing GitHub Actions workflow file or job to inspect.
- Access to the selected app root and repository configuration files.
- A stated target platform: iOS Simulator, Android emulator, or both.
- A redacted copy of any selected source that contains or might contain a literal credential.

## Quick Steps

1. Identify the selected workflow file, job, target platform, and app root.
2. List raw values from the selected job and any literal repository-relative script, action metadata, or reusable workflow that it names.
   Record a dynamic or ambiguous reference as `[UNCERTAIN]` instead of resolving it.
   Record each value with its file and line number.
3. Before reading source content, stop for a file that contains or might contain a literal credential.
   Record its path and credential key or reference name, then obtain a redacted copy.
4. Read package manifests, lockfiles, native configuration, Expo configuration, and `eas.json` as available.
5. List raw build, output, upload, retention, and authentication references.
6. Start the report with counts of selected, inspected, and skipped sources.
   Give each skipped source an `[UNCERTAIN]` reason.
7. Mark the contract `[UNCERTAIN]` when it needs a conclusion beyond the observed source text.

## Commands

Set `REPO_DIR` to the repository root, `APP_DIR` to the selected app root, `WORKFLOW_FILE` to the selected workflow, and `REFERENCE_PATH` to a selected, credential-safe source file before running these read-only commands.

| Intent                              | Command                                                                                                                                                                                                                                                 | Mutates source? |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| List workflow files                 | `rg --files "$REPO_DIR/.github/workflows"`                                                                                                                                                                                                              | No              |
| Read the selected safe workflow     | `sed -n '1,$p' "$WORKFLOW_FILE"`                                                                                                                                                                                                                        | No              |
| Find raw workflow markers           | `rg -n -C 3 -e 'needs:' -e 'uses:' -e 'run:' -e 'if:' -e 'continue-on-error' -e 'working-directory:' -e install -e eas -e '--local' -e '--output' -e EAS_LOCAL_BUILD_ARTIFACTS_DIR -e upload-artifact -e retention-days -e EXPO_TOKEN "$WORKFLOW_FILE"` | No              |
| Find package metadata               | `rg --files "$APP_DIR" -g 'package.json' -g 'npm-shrinkwrap.json' -g 'package-lock.json' -g 'pnpm-lock.yaml' -g 'yarn.lock' -g 'bun.lock' -g 'bun.lockb' -g '.npmrc' -g 'pnpm-workspace.yaml'`                                                          | No              |
| Find Expo and EAS configuration     | `rg --files "$APP_DIR" -g 'app.json' -g 'app.config.*' -g 'eas.json'`                                                                                                                                                                                   | No              |
| Find iOS native configuration       | `if test -d "$APP_DIR/ios"; then rg --files "$APP_DIR/ios" -g 'project.pbxproj' -g '*.xcconfig' -g '*.xcscheme' -g 'Podfile' -g 'Podfile.lock'; fi`                                                                                                     | No              |
| Find Android native configuration   | `if test -d "$APP_DIR/android"; then rg --files "$APP_DIR/android" -g 'settings.gradle' -g 'settings.gradle.kts' -g 'build.gradle' -g 'build.gradle.kts' -g 'gradle.properties' -g 'AndroidManifest.xml'; fi`                                           | No              |
| Find literal iOS command references | `if test -d "$APP_DIR/ios"; then rg -n -e xcodebuild "$APP_DIR/ios"; fi`                                                                                                                                                                                | No              |
| Find literal Android command refs   | `if test -d "$APP_DIR/android"; then rg -n -e gradlew -e 'assemble' -e 'bundle' "$APP_DIR/android"; fi`                                                                                                                                                 | No              |
| Read a selected safe source         | `sed -n '1,$p' "$REFERENCE_PATH"`                                                                                                                                                                                                                       | No              |

## Evidence Rules

- Treat every matched command, field, path, credential key or reference name, condition, and upload setting as raw evidence only.
- Record the source file, line number, exact value, and the contract that the value may affect.
  Never record a literal credential value.
  Replace each non-empty literal credential value with `[REDACTED]`.
- Do not run a content-printing command for a source that contains or might contain a literal credential.
  Record the path and credential key or reference name, then request a redacted copy.
- Read a literal repository-relative script, action metadata, or reusable workflow only when its target is direct and unambiguous.
  Do not resolve an expression, `working-directory`, checkout state, or nested reference.
  Record that literal reference and mark its target `[UNCERTAIN]` instead.
- Start the report with selected, inspected, and skipped source counts.
  For each skipped source, include its path and an `[UNCERTAIN]` reason.
- Use `[OBSERVED]` only for text present in the inspected source.
  It is not confirmation that a step ran or produced a file.
- Use `[UNCERTAIN]` when a conclusion needs any of the following:
  - GitHub Actions expression evaluation, job reachability, step order, or command exit status.
  - Source checkout or local-script path resolution.
  - Package-manager selection, dependency installation, or generated native input.
  - An artifact's identity, retention, archive contents, signing, ABI compatibility, upload result, installation, or launch.
  - EAS profile inheritance, effective platform settings, output type, local-output retention, cloud-build authentication, or completed-build reference.
- Do not treat a matching `run`, `uses`, `--output`, `EAS_LOCAL_BUILD_ARTIFACTS_DIR`, `upload-artifact`, `retention-days`, `EXPO_TOKEN`, `extends`, `ios.simulator`, `android.buildType`, or `android.gradleCommand` value as proof of a complete artifact contract.
- Do not infer a profile's effective value from `extends`.
  Preserve each declared profile and field as separate evidence.
- Do not infer producer success from a command, an upload declaration, or `continue-on-error`.
- Do not infer cloud EAS authentication from an environment-variable reference.
- Do not propose a workflow change until the report states which evidence is observed and which required conclusion remains uncertain.

## Report Shape

```log
Inventory:
- Selected sources: 4
- Inspected sources: 3
- Skipped sources: 1
  - [UNCERTAIN] ios/App.xcodeproj/project.pbxproj was unavailable in the selected app root.

Contract: local EAS output retention
Evidence:
- [OBSERVED] .github/workflows/build.yml:42 contains "eas build --local --output build/app.apk".
- [OBSERVED] .github/workflows/build.yml:51 contains "retention-days: 7".
Status: [UNCERTAIN]
Reason: The reader does not evaluate step order, command success, or whether the upload path retains that output.
```

Keep simulator and emulator evidence separate.
Do not use a count of observed values as a count of complete contracts.

## Safety and Verification

This skill is read-only with respect to the workflow and target project.
Do not edit workflows, dispatch CI, download artifacts, update dependencies, or select an ambiguous output.
After a workflow change receives explicit approval, collect direct execution evidence with the project-equivalent commands.
After matching simulator or emulator installation receives separate authorization, collect runtime evidence in a separate handoff.

## Common Mistakes

| Mistake                                                      | Fix                                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Treating a matching value as proof that a step ran           | Report it as `[OBSERVED]` and keep the dependent contract `[UNCERTAIN]`.                    |
| Resolving `extends` in prose                                 | Preserve the raw profile chain and use a tested evaluator when the effective value matters. |
| Reading or reporting a literal credential                    | Record its key or reference name and use `[REDACTED]` for its value.                        |
| Resolving an ambiguous local workflow reference              | Preserve its literal text and mark the target `[UNCERTAIN]`.                                |
| Treating an upload declaration as retained artifact evidence | Report the declaration and state that retention remains `[UNCERTAIN]`.                      |
| Treating `EXPO_TOKEN` as confirmed EAS access                | Report the reference and state that authentication remains `[UNCERTAIN]`.                   |
| Treating an artifact path as an install check                | Get direct build and authorized runtime evidence in a separate step.                        |

## Reference

- [GitHub Actions workflow syntax](https://docs.github.com/actions/writing-workflows/workflow-syntax-for-github-actions)
- [GitHub Actions artifact documentation](https://docs.github.com/actions/using-workflows/storing-workflow-data-as-artifacts)
- [Expo local builds](https://docs.expo.dev/build-reference/local-builds/)
- [Expo build profiles](https://docs.expo.dev/build/eas-json/)

---

> If you need policy checks for artifacts across projects, open a Discussion in the RN Agents Kit repository.
