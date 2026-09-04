// Unit tests for the evidence engine and the node-pin adapters. The fixture
// harness is separate, in `corpus.harness.test.mjs`, because it reads the
// corpus and the corpus does not ship.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, cp, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as evidenceEngine from "./evidence.mjs";

const { applyAdapter, matchAdapter, readEvidence } = evidenceEngine;

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "evidence.mjs");

async function withFile(name, contents) {
  const dir = await mkdtemp(join(tmpdir(), "rn-evidence-"));
  const path = join(dir, name);
  await writeFile(path, contents);
  return path;
}

async function evidenceFor(name, contents, options) {
  return readEvidence(await withFile(name, contents), options);
}

// The path is the caller's own input, and echoing it back was still an emitting
// channel with no validator behind it: a directory name carries a credential as
// readily as a file's contents. The field is gone, and this is the check.
test("no part of the path reaches either stream", async () => {
  const dir = await mkdtemp(
    join(tmpdir(), "rn-evidence-ghp_realLookingToken123-"),
  );
  const path = join(dir, ".nvmrc");
  await writeFile(path, "20.11.1\n");
  const run = spawnSync(process.execPath, [SCRIPT, "--read", path], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0);
  assert.deepEqual(JSON.parse(run.stdout).evidence, { version: "20.11.1" });
  assert.ok(!run.stdout.includes("ghp_"), run.stdout);
  assert.ok(!run.stderr.includes("ghp_"), run.stderr);
  assert.ok(!("source" in JSON.parse(run.stdout)));
});

const MANIFEST = (body) => JSON.stringify(body);

// The range grammar, pinned as literals. Every accepted case here was checked
// against node-semver's own `validRange` at authoring time and none of them is a
// range it rejects; the refused list holds the shapes it also rejects, plus the
// prerelease and build-metadata forms this type declines on purpose.
test("the range grammar accepts npm's shapes and no others", async () => {
  const accepted = [
    "18.3.1",
    "^18.3.1",
    "~0.74.5",
    ">=18 <21",
    "1.2.3 - 2.0.0",
    "1.2.3  -  2.0.0",
    ">= 18 < 21",
    ">=18\t<21",
    "~>1.2.3",
    "~> 1.2.3",
    "~ 1.2.3",
    "^18 || ^19",
    "18.x",
    "1.x.x",
    "1.2.x",
    "*",
    "x",
    "v18.3.1",
    "latest",
  ];
  const refused = [
    "1.x.2",
    "x.2.3",
    "^1.2.3 - 2.0.0",
    "1.2.3 - ^2.0.0",
    "1.2.3.4",
    "^>1.2.3",
    "- 1.2.3",
    "1.2.3 -",
    "19.0.0-rc.1",
    "10.4.1+sha512.a",
    "",
    "next",
  ];
  for (const range of accepted) {
    const result = await evidenceFor(
      "package.json",
      MANIFEST({ dependencies: { react: range } }),
    );
    assert.deepEqual(result.evidence, { react: range }, range);
  }
  for (const range of refused) {
    const result = await evidenceFor(
      "package.json",
      MANIFEST({ dependencies: { react: range } }),
    );
    assert.equal(result.status, "uncertain", JSON.stringify(range));
    assert.deepEqual(result.evidence, {}, JSON.stringify(range));
  }
});

// `ok` says the whole file was read. With several fields, a reader gating on the
// status would otherwise take a manifest one of whose fields it could not read
// as fully accepted.
test("a manifest with one unreadable field is uncertain, evidence and all", async () => {
  const result = await evidenceFor(
    "package.json",
    MANIFEST({
      dependencies: { react: "18.3.1" },
      engines: { node: "not a range" },
    }),
  );
  assert.equal(result.status, "uncertain");
  assert.equal(result.reason, "REJECTED_VALUE");
  assert.deepEqual(result.rejected, ["engineNode"]);
  assert.deepEqual(result.evidence, { react: "18.3.1" });
});

// Stripped here and kept in a pin file, because each reader does what the
// format's own reader does: Node's manifest loader accepts a mark, nvm does not.
test("a manifest behind a byte-order mark is read, not refused", async () => {
  const result = await evidenceFor(
    "package.json",
    `\uFEFF${MANIFEST({ dependencies: { react: "18.3.1" } })}`,
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(result.evidence, { react: "18.3.1" });
});

// `sdkVersion` names one release rather than a constraint.
test("an expo sdk that is a range is not reported as a version", async () => {
  for (const sdk of [">=50", "^51.0.0", "51", "latest", "51.0"]) {
    const result = await evidenceFor(
      "package.json",
      MANIFEST({ expo: { sdkVersion: sdk } }),
    );
    assert.equal(result.status, "uncertain", sdk);
    assert.deepEqual(result.rejected, ["expoSdkVersion"], sdk);
  }
});

// Present and unreadable is not absent. Every one of these once became an
// absence, so a manifest that half validated came back ok.
test("a malformed container or declaration is rejected, not dropped", async () => {
  const cases = [
    ["engines", "invalid", "engineNode"],
    ["engines", null, "engineNode"],
    ["engines", ["node"], "engineNode"],
    ["expo", "invalid", "expoSdkVersion"],
    ["dependencies", "invalid", "react"],
    ["devDependencies", null, "react"],
  ];
  for (const [key, value, field] of cases) {
    const result = await evidenceFor(
      "package.json",
      MANIFEST({
        [key]: value,
        ...(key === "dependencies" || key === "devDependencies"
          ? { optionalDependencies: {} }
          : { dependencies: { react: "18.3.1" } }),
      }),
    );
    assert.equal(result.status, "uncertain", `${key}=${JSON.stringify(value)}`);
    assert.ok(
      result.rejected.includes(field),
      `${key}=${JSON.stringify(value)} -> ${JSON.stringify(result)}`,
    );
  }
});

test("a packageManager that is present but not a string is rejected, not dropped", async () => {
  for (const declared of [42, true, null, { name: "pnpm" }, ["pnpm@10.4.1"]]) {
    const result = await evidenceFor(
      "package.json",
      MANIFEST({ dependencies: { react: "18.3.1" }, packageManager: declared }),
    );
    assert.equal(result.status, "uncertain", JSON.stringify(declared));
    assert.deepEqual(
      result.rejected,
      ["packageManager"],
      JSON.stringify(declared),
    );
  }
});

// npm resolves a dependency written as `latest`; `engines` is not resolved
// against the registry at all, so the same literal there is a constraint the
// manifest does not state.
test("latest is a dependency range and not an engine one", async () => {
  const dependency = await evidenceFor(
    "package.json",
    MANIFEST({ dependencies: { react: "latest" } }),
  );
  assert.deepEqual(dependency.evidence, { react: "latest" });

  const engine = await evidenceFor(
    "package.json",
    MANIFEST({ engines: { node: "latest" } }),
  );
  assert.equal(engine.status, "uncertain");
  assert.deepEqual(engine.rejected, ["engineNode"]);
});

test("a package manager pin may carry semver's own v prefix", async () => {
  const result = await evidenceFor(
    "package.json",
    MANIFEST({ packageManager: "pnpm@v10.4.1" }),
  );
  assert.deepEqual(result.evidence, { packageManager: "pnpm@v10.4.1" });
});

test("a range with more alternatives than a hand-written limit is accepted", async () => {
  const range = "^14 || ^16 || ^18 || ^20 || ^22 || >=24";
  const result = await evidenceFor(
    "package.json",
    MANIFEST({ engines: { node: range } }),
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(result.evidence, { engineNode: range });
});

// The two lockfile fixtures exist because a line-based reader leaked a resolved
// URL out of them: one puts the whole tree on a single line, the other puts the
// version and the credentialed URL on the line after the key. Neither shape means
// anything to a parser, and `resolved` has no field in the schema.
test("a lockfile emits installed versions and never a resolved url", async () => {
  const result = await evidenceFor(
    "package-lock.json",
    MANIFEST({
      packages: {
        "": { name: "acme-app" },
        "node_modules/react": {
          version: "18.3.1",
          resolved:
            "https://x-access-token:ghp_realLookingToken123@registry.internal/react.tgz",
        },
        "node_modules/react-native": { version: "0.74.5" },
      },
    }),
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(result.evidence, {
    react: "18.3.1",
    reactNative: "0.74.5",
  });
  assert.ok(!JSON.stringify(result).includes("ghp_"));
  assert.ok(!JSON.stringify(result).includes("resolved"));
});

// npm has not written a v1 lockfile since 2020, and reading one would be a second
// reader for a second format rather than a gap worth closing.
// A workspace lockfile cannot be attributed without knowing which workspace was
// selected. Verified on npm 11.19.0: a root declaring `workspaces: ["apps/*"]`
// with only `apps/web` depending on a package writes it to the root
// `node_modules/<name>` and gives `apps/mobile` no entry for it, so the root
// entry says nothing about the selected app either way.
test("a workspace lockfile carries no version evidence", async () => {
  for (const packages of [
    // hoisted for a sibling, no app-local copy anywhere
    {
      "": { name: "root", workspaces: ["apps/*"] },
      "apps/web": { dependencies: { react: "18.3.1" } },
      "apps/mobile": {},
      "node_modules/react": { version: "18.3.1" },
    },
    // an app-local copy beside the root
    {
      "": { name: "root", workspaces: ["apps/*"] },
      "apps/mobile": {},
      "node_modules/react": { version: "17.0.2" },
      "apps/mobile/node_modules/react": { version: "18.3.1" },
    },
  ]) {
    const result = await evidenceFor(
      "package-lock.json",
      MANIFEST({ packages }),
    );
    assert.equal(result.status, "uncertain");
    assert.ok(result.rejected.includes("react"));
    assert.deepEqual(result.evidence, {});
  }

  // a `file:` dependency writes a descriptor keyed like a workspace entry, so the
  // signal is the root's `workspaces` field rather than the shape of the keys
  const linked = await evidenceFor(
    "package-lock.json",
    MANIFEST({
      packages: {
        "": { name: "app", dependencies: { react: "file:./local-react" } },
        "local-react": { name: "react", version: "18.3.1" },
        "node_modules/react": { resolved: "local-react", link: true },
      },
    }),
  );
  assert.deepEqual(linked.evidence, { react: "18.3.1" });

  // a single-package lockfile is unaffected
  const single = await evidenceFor(
    "package-lock.json",
    MANIFEST({
      packages: {
        "": { name: "app" },
        "node_modules/react": { version: "18.3.1" },
      },
    }),
  );
  assert.deepEqual(single.evidence, { react: "18.3.1" });
});

// The placement is npm's, reproduced on npm 11.19.0: a root declaring
// `workspaces: ["apps/*"]` where `apps/mobile` wants 17 and `apps/web` wants 18
// writes 17 to the root `node_modules/<name>` and 18 to
// `apps/web/node_modules/<name>`. So an app resolves its own copy when it has
// one and the root hoist otherwise.
test("a workspace lockfile resolves per app once the app is named", async () => {
  const lockfile = MANIFEST({
    packages: {
      "": { name: "root", workspaces: ["apps/*"] },
      "apps/mobile": { dependencies: { react: "17.0.2" } },
      "apps/web": { dependencies: { react: "18.3.1" } },
      "apps/web/node_modules/react": { version: "18.3.1" },
      "node_modules/react": { version: "17.0.2" },
    },
  });
  const path = await withFile("package-lock.json", lockfile);
  const root = dirname(path);

  // the hoisted copy is this app's
  assert.deepEqual(
    readEvidence(path, { appDir: join(root, "apps/mobile") }).evidence,
    { react: "17.0.2" },
  );
  // and this one has its own
  assert.deepEqual(
    readEvidence(path, { appDir: join(root, "apps/web") }).evidence,
    { react: "18.3.1" },
  );
});

// A package the app's own entry does not declare is a neighbour's, whatever sits
// at the root.
test("a package the app does not declare is absent, not the root's", async () => {
  const lockfile = MANIFEST({
    packages: {
      "": { name: "root", workspaces: ["apps/*"] },
      "apps/mobile": {},
      "apps/web": { dependencies: { react: "18.3.1" } },
      "node_modules/react": { version: "18.3.1" },
    },
  });
  const path = await withFile("package-lock.json", lockfile);
  const result = readEvidence(path, {
    appDir: join(dirname(path), "apps/mobile"),
  });
  assert.equal(result.status, "uncertain");
  assert.equal(result.reason, "NO_EVIDENCE");
  assert.deepEqual(result.evidence, {});
});

// Without the app, and for an app the file does not describe, it refuses rather
// than picks.
test("a workspace lockfile refuses without a usable app", async () => {
  const lockfile = MANIFEST({
    packages: {
      "": { name: "root", workspaces: ["apps/*"] },
      "apps/mobile": { dependencies: { react: "17.0.2" } },
      "node_modules/react": { version: "17.0.2" },
    },
  });
  const path = await withFile("package-lock.json", lockfile);
  const root = dirname(path);
  for (const options of [
    undefined,
    { appDir: join(root, "..", "elsewhere") },
    { appDir: join(root, "apps/absent") },
  ]) {
    const result = readEvidence(path, options);
    assert.equal(result.status, "uncertain", JSON.stringify(options));
    assert.ok(result.rejected.includes("react"), JSON.stringify(options));
  }
});

// A lockfile key is not a path.
// It is `apps/mobile` on every platform, while `relative` answers
// `apps\\mobile` on Windows.
// A cross-volume result is absolute.
// pnpm writes that normalized result as an importer id, while npm does not
// describe workspaces outside the lockfile volume.
test("a windows app path keeps the context each lockfile format needs", () => {
  const nested = evidenceEngine.appContext(
    "C:\\repo\\pnpm-lock.yaml",
    "C:\\repo\\apps\\mobile",
    win32,
  );
  assert.deepEqual(nested, { app: "apps/mobile" });

  const pnpmContext = evidenceEngine.appContext(
    "C:\\repo\\pnpm-lock.yaml",
    "D:\\app",
    win32,
  );
  assert.deepEqual(pnpmContext, { app: null, absoluteApp: "D:/app" });
  const pnpm = applyAdapter(
    matchAdapter("pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\n" +
      "importers:\n" +
      "  D:/app:\n" +
      "    dependencies:\n" +
      "      react:\n" +
      "        specifier: 19.2.3\n" +
      "        version: 19.2.3\n",
    pnpmContext,
  );
  assert.equal(pnpm.status, "ok");
  assert.equal(pnpm.evidence.react, "19.2.3");

  const npmContext = evidenceEngine.appContext(
    "C:\\repo\\package-lock.json",
    "D:\\app",
    win32,
  );
  const npm = applyAdapter(
    matchAdapter("package-lock.json"),
    MANIFEST({
      packages: {
        "": { workspaces: ["apps/*"] },
        "D:/app": { dependencies: { react: "19.2.3" } },
        "D:/app/node_modules/react": { version: "19.2.3" },
      },
    }),
    npmContext,
  );
  assert.equal(npm.status, "uncertain");
  assert.deepEqual(npm.evidence, {});
});

// `normalize-path` treats a run of Windows separators as one separator.
// That rule turns the absolute result from a cross-server UNC path into the
// importer id that pnpm writes.
test("a cross-server UNC app uses pnpm's importer key", () => {
  const context = evidenceEngine.appContext(
    "\\\\lockhost\\share\\repo\\pnpm-lock.yaml",
    "\\\\apphost\\share\\app",
    win32,
  );
  assert.deepEqual(context, {
    app: null,
    absoluteApp: "/apphost/share/app",
  });
  const result = applyAdapter(
    matchAdapter("pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\n" +
      "importers:\n" +
      "  /apphost/share/app:\n" +
      "    dependencies:\n" +
      "      react:\n" +
      "        specifier: 19.2.3\n" +
      "        version: 19.2.3\n",
    context,
  );
  assert.equal(result.status, "ok");
  assert.equal(result.evidence.react, "19.2.3");
});

test("a lockfile may be larger than a configuration file", async () => {
  const padded = JSON.stringify({
    packages: { "node_modules/react": { version: "18.3.1" } },
    padding: "x".repeat(9 * 1024 * 1024),
  });
  const result = await evidenceFor("package-lock.json", padded);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.evidence, { react: "18.3.1" });

  const pin = await evidenceFor(
    ".nvmrc",
    `20.11.1\n${"#".repeat(9 * 1024 * 1024)}`,
  );
  assert.equal(pin.reason, "TOO_LARGE");
});

// A lockfile entry keeps the requested name in its path and records what was
// actually installed in `name`, so an alias is a fork's version under this
// package's key.
test("an aliased entry is not labelled as this package's version", async () => {
  const aliased = await evidenceFor(
    "package-lock.json",
    MANIFEST({
      packages: {
        "node_modules/react-native": {
          name: "react-native-tvos",
          version: "0.74.5",
        },
      },
    }),
  );
  assert.equal(aliased.status, "uncertain");
  assert.deepEqual(aliased.rejected, ["reactNative"]);
  assert.ok(!JSON.stringify(aliased).includes("tvos"));

  const named = await evidenceFor(
    "package-lock.json",
    MANIFEST({
      packages: {
        "node_modules/react": { name: "react", version: "18.3.1" },
      },
    }),
  );
  assert.deepEqual(named.evidence, { react: "18.3.1" });
});

test("a v1 lockfile carries no evidence rather than a second reader", async () => {
  const result = await evidenceFor(
    "package-lock.json",
    MANIFEST({
      lockfileVersion: 1,
      dependencies: { react: { version: "18.3.1" } },
    }),
  );
  assert.equal(result.status, "uncertain");
  assert.equal(result.reason, "NO_EVIDENCE");
});

test("a lockfile version that is not an exact release is rejected", async () => {
  for (const version of ["^18.3.1", "18.3", "latest", "18.3.1-rc.1"]) {
    const result = await evidenceFor(
      "package-lock.json",
      MANIFEST({ packages: { "node_modules/react": { version } } }),
    );
    assert.equal(result.status, "uncertain", version);
    assert.deepEqual(result.rejected, ["react"], version);
  }
});

test("a shrinkwrap is read the same way", async () => {
  const result = await evidenceFor(
    "npm-shrinkwrap.json",
    MANIFEST({ packages: { "node_modules/expo": { version: "51.0.14" } } }),
  );
  assert.equal(result.kind, "npm-lockfile");
  assert.deepEqual(result.evidence, { expo: "51.0.14" });
});

// A build profile is addressed by a name the project chose, so no field names
// one — which is why the fixture's credential, sitting in a profile's env block,
// has nowhere to go.
test("an eas config emits the cli range and nothing addressed by profile", async () => {
  const result = await evidenceFor(
    "eas.json",
    MANIFEST({
      cli: { version: ">= 7.0.0" },
      build: {
        production: {
          node: "20.11.1",
          env: { SENTRY_AUTH_TOKEN: "ghp_realLookingToken123" },
        },
        ghp_realLookingToken123: { node: "20.11.1" },
      },
    }),
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(result.evidence, { easCliVersion: ">= 7.0.0" });
  assert.ok(!JSON.stringify(result).includes("ghp_"));
});

// `cli.version` states which EAS CLI versions may run, which the registry does
// not resolve — the same kind of field as `engines.node`, and `validRange
// ("latest")` is null for both.
test("an eas cli dist-tag is rejected, not reported as a range", async () => {
  const tagged = await evidenceFor(
    "eas.json",
    MANIFEST({ cli: { version: "latest" } }),
  );
  assert.equal(tagged.status, "uncertain");
  assert.deepEqual(tagged.rejected, ["easCliVersion"]);

  const ranged = await evidenceFor(
    "eas.json",
    MANIFEST({ cli: { version: ">= 7.0.0" } }),
  );
  assert.deepEqual(ranged.evidence, { easCliVersion: ">= 7.0.0" });
});

test("a manifest emits the declared ranges and the expo sdk", async () => {
  const result = await evidenceFor(
    "package.json",
    MANIFEST({
      dependencies: { react: "18.3.1", "react-native": "^0.74.5" },
      devDependencies: { expo: "~51.0.0" },
      engines: { node: ">=18 <21" },
      packageManager: "pnpm@10.4.1+sha512.deadbeef",
      expo: { sdkVersion: "51.0.0" },
    }),
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(result.evidence, {
    react: "18.3.1",
    reactNative: "^0.74.5",
    expo: "~51.0.0",
    expoSdkVersion: "51.0.0",
    engineNode: ">=18 <21",
    packageManager: "pnpm@10.4.1",
  });
});

// Two blocks disagreeing is not resolved by picking one. Reproducing npm's edge
// priority was the alternative: Arborist loads prod, then optional, then dev and
// replaces the existing edge, so `devDependencies` wins — the opposite of the
// order this list was first written in.
test("a package declared twice with two ranges is not resolved by order", async () => {
  const conflicting = await evidenceFor(
    "package.json",
    MANIFEST({
      optionalDependencies: { react: "18.3.1" },
      dependencies: { react: "17.0.2" },
      devDependencies: { react: "19.0.0" },
    }),
  );
  assert.equal(conflicting.status, "uncertain");
  assert.deepEqual(conflicting.rejected, ["react"]);

  const agreeing = await evidenceFor(
    "package.json",
    MANIFEST({
      dependencies: { react: "18.3.1" },
      devDependencies: { react: "18.3.1" },
    }),
  );
  assert.deepEqual(agreeing.evidence, { react: "18.3.1" });
});

test("a peer-only entry is not a declaration", async () => {
  const result = await evidenceFor(
    "package.json",
    MANIFEST({
      dependencies: { react: "18.3.1" },
      peerDependencies: { "react-native": "0.74.5" },
    }),
  );
  assert.deepEqual(result.evidence, { react: "18.3.1" });
});

// Every shape a range can take that is not a range. A git or https specifier is
// where a credential lives, and it has no way through the type; the field is
// named as rejected and its value stays behind.
test("a specifier that is not a plain range is rejected, not printed", async () => {
  for (const range of [
    "https://x-access-token:ghp_realLookingToken123@github.com/a/b.git",
    "https://packages.example/app.tgz?token=ghp_realLookingToken123",
    "git+ssh://git@github.com:acme/lib.git#v1.2.3",
    "npm:react-native-tvos@0.74.5",
    "file:../local-react",
    "workspace:*",
    "19.0.0-rc.1",
  ]) {
    const result = await evidenceFor(
      "package.json",
      MANIFEST({ dependencies: { react: range } }),
    );
    assert.equal(result.status, "uncertain", range);
    assert.equal(result.reason, "REJECTED_VALUE", range);
    assert.deepEqual(result.rejected, ["react"], range);
    assert.deepEqual(result.evidence, {}, range);
    assert.ok(!JSON.stringify(result).includes("ghp_"), range);
    assert.ok(!JSON.stringify(result).includes(range.slice(0, 10)), range);
  }
});

// The fields the corpus puts a credential in are not in the schema at all, so
// nothing has to recognise them. This is decision 3 stated as a test.
test("a field the schema does not name is never looked at", async () => {
  const result = await evidenceFor(
    "package.json",
    MANIFEST({
      dependencies: {
        react: "18.3.1",
        "query-token": "https://p.example/a.tgz?token=ghp_realLookingToken123",
      },
      scripts: { release: "TOKEN=ghp_realLookingToken123 npx sentry-cli" },
      expo: {
        sdkVersion: "51.0.0",
        extra: { googleMapsApiKey: "ghp_realLookingToken123" },
      },
    }),
  );
  assert.deepEqual(result.evidence, {
    react: "18.3.1",
    expoSdkVersion: "51.0.0",
  });
  assert.ok(!JSON.stringify(result).includes("ghp_"));
  assert.ok(!JSON.stringify(result).includes("token"));
});

test("a manifest that does not parse is refused without the parser's message", async () => {
  const result = await evidenceFor(
    "package.json",
    '{"dependencies": {"react": "18.3.1", ghp_realLookingToken123}',
  );
  assert.equal(result.status, "refused");
  assert.equal(result.reason, "ADAPTER_FAILED");
  assert.ok(!JSON.stringify(result).includes("ghp_"));
});

test("a manifest whose top level is not an object declares nothing", async () => {
  for (const body of ["[]", "null", '"x"', "42"]) {
    const result = await evidenceFor("package.json", body);
    assert.equal(result.status, "uncertain", body);
    assert.equal(result.reason, "NO_EVIDENCE", body);
  }
});

test("a package manager outside the closed set is rejected whole", async () => {
  // the last three are malformed after the `+`, where splitting first would have
  // repaired them into a pin corepack itself refuses
  for (const pin of [
    "corepack-shim@1.0.0",
    "pnpm@latest",
    "pnpm",
    "npm@1.2",
    "pnpm@10.4.1+not valid",
    "pnpm@10.4.1+",
    "pnpm@10.4.1+sha512.abc+extra",
    "pnpm@10.4.1+sha512..deadbeef",
    "pnpm@10.4.1+sha512.",
    "pnpm@10.4.1+.a",
  ]) {
    const result = await evidenceFor(
      "package.json",
      MANIFEST({ packageManager: pin }),
    );
    assert.equal(result.status, "uncertain", pin);
    assert.deepEqual(result.rejected, ["packageManager"], pin);
    assert.ok(!JSON.stringify(result).includes("corepack-shim"), pin);
  }
});

test("a bare pin file emits its version", async () => {
  const result = await evidenceFor(".nvmrc", "20.11.1\n");
  assert.equal(result.status, "ok");
  assert.equal(result.kind, "node-pin");
  assert.deepEqual(result.evidence, { version: "20.11.1" });
  assert.ok(!("rejected" in result));
});

test("a bare pin file skips comments and blank lines", async () => {
  const result = await evidenceFor(
    ".node-version",
    "\n# pinned for the RN toolchain\nlts/hydrogen\n",
  );
  assert.deepEqual(result.evidence, { version: "lts/hydrogen" });
});

test("an alias and a truncated release are both accepted whole", async () => {
  for (const pin of [
    "20",
    "v20.11.1",
    "lts/*",
    "lts/iron",
    "lts/krypton",
    "latest",
    "system",
    // nvm's built-in aliases (nvm.sh:1374)
    "node",
    "stable",
    "unstable",
    "iojs",
  ]) {
    const result = await evidenceFor(".nvmrc", `${pin}\n`);
    assert.deepEqual(result.evidence, { version: pin }, pin);
  }
});

// The alias list is closed for the reason the prerelease tag is refused: read as
// a pattern, the codename is a free-form suffix wide enough to hold anything
// lowercase.
test("an lts codename outside the list is not emitted", async () => {
  for (const pin of ["lts/secretpassword", "lts/ghprealtoken", "lts/"]) {
    const result = await evidenceFor(".nvmrc", `${pin}\n`);
    assert.equal(result.status, "uncertain", pin);
    assert.deepEqual(result.rejected, ["version"], pin);
    assert.ok(!JSON.stringify(result).includes("secret"), pin);
  }
});

// nvm's own reader cuts a trailing comment (nvm.sh:619) and collects `key=value`
// lines separately from the pin (nvm.sh:634-682), so a file it resolves must not
// come back uncertain here. `.node-version` has neither rule and keeps the
// strict reading, because a tool reading that file fails on the whole string.
test("an nvmrc follows nvm's own two rules and .node-version does not", async () => {
  const nvmrc = await evidenceFor(
    ".nvmrc",
    "20.11.1 # the RN baseline\nmirror=https://example.invalid\n",
  );
  assert.equal(nvmrc.status, "ok");
  assert.deepEqual(nvmrc.evidence, { version: "20.11.1" });

  const strict = await evidenceFor(".node-version", "20.11.1 # a comment\n");
  assert.equal(strict.status, "uncertain");
  assert.equal(strict.reason, "REJECTED_VALUE");
});

// The pairs nvm refuses the file for, and the one it does not. Each row was run
// through `nvm_process_nvmrc_content` on the installed nvm before it was written
// here, so the reader tracks that reader rather than a guess about it.
test("an nvmrc pair is refused only where nvm refuses it", async () => {
  const pin = "20.11.1\n";
  const ok = await evidenceFor(
    ".nvmrc",
    `${pin}NODE_AUTH_TOKEN=ghp_realLookingToken123\nmirror=a\nflavor=b\n`,
  );
  assert.equal(ok.status, "ok", "nvm has no allowlist of keys");
  assert.deepEqual(ok.evidence, { version: "20.11.1" });
  assert.ok(!JSON.stringify(ok).includes("ghp_"));

  for (const pairs of ["node=18.19.0\n", "mirror=a\nmirror=b\n"]) {
    const result = await evidenceFor(".nvmrc", pin + pairs);
    assert.equal(result.status, "uncertain", pairs);
    assert.equal(result.reason, "NO_EVIDENCE", pairs);
  }
});

// nvm's duplicate check interpolates each key into an ERE, so a metacharacter
// makes it match a different key. Measured against the installed nvm: this file
// is refused there and the reverse key order is not.
test("an nvmrc key that nvm would read as a regex leaves the file unread", async () => {
  const result = await evidenceFor(
    ".nvmrc",
    "20.11.1\nmirrorXprod=a\nmirror.prod=b\n",
  );
  assert.equal(result.status, "uncertain");
  assert.equal(result.reason, "NO_EVIDENCE");
});

// `trim()` removes U+FEFF and these formats' readers do not, so trimming it here
// would report a clean pin for a file the version manager fails on: measured,
// `nvm_version` resolves an installed version and answers N/A for the same
// string behind a byte-order mark.
test("a byte-order mark is not trimmed into a clean pin", async () => {
  for (const name of [".nvmrc", ".node-version"]) {
    const result = await evidenceFor(name, "\uFEFF20.11.1\n");
    assert.equal(result.status, "uncertain", name);
    assert.equal(result.reason, "REJECTED_VALUE", name);
  }
  const tools = await evidenceFor(".tool-versions", "\uFEFFnodejs 20.11.1\n");
  assert.equal(tools.status, "uncertain");
  assert.equal(tools.reason, "NO_EVIDENCE");
});

// The trim set is the closed one these formats use, so whitespace outside it
// stays in the candidate rather than being normalised away. Each of these was a
// separate finding when the set was "Unicode whitespace minus the last codepoint
// someone reported".
test("whitespace outside the format's own set is not trimmed away", async () => {
  for (const pin of ["\u00a020.11.1", "20.11.1\u2003", "\uFEFF20.11.1"]) {
    const result = await evidenceFor(".nvmrc", `${pin}\n`);
    assert.equal(result.status, "uncertain", JSON.stringify(pin));
    assert.equal(result.reason, "REJECTED_VALUE", JSON.stringify(pin));
  }
  // and the set itself still trims
  const ok = await evidenceFor(".nvmrc", "  \t20.11.1\t \r\n");
  assert.deepEqual(ok.evidence, { version: "20.11.1" });
});

// nvm keeps its seen keys in one space-separated string and matches the next key
// against it as an ERE, so a key is only safely comparable when it is a plain
// token. A space splits one key into two of that string's words; a metacharacter
// matches a different one.
test("an nvmrc key that is not a plain token leaves the file unread", async () => {
  for (const pairs of [
    "mirrorXprod=a\nmirror.prod=b\n",
    "foo bar=a\nbar=b\n",
    "mirror|prod=a\n",
  ]) {
    const result = await evidenceFor(".nvmrc", `20.11.1\n${pairs}`);
    assert.equal(result.status, "uncertain", pairs);
    assert.equal(result.reason, "NO_EVIDENCE", pairs);
  }
});

// A line naming node with no version is still a declaration of node, and the
// rule this reader states is that a file declaring the pin twice does not
// resolve. Counting only versions let the second one vanish.
test("a second node declaration counts even with no version on it", async () => {
  for (const second of ["nodejs\n", "nodejs # pinned elsewhere\n", "node\n"]) {
    const result = await evidenceFor(
      ".tool-versions",
      `nodejs 20.11.1\n${second}`,
    );
    assert.equal(result.status, "uncertain", second);
    assert.equal(result.reason, "AMBIGUOUS", second);
  }
});

test("a tool-versions comment is not read as a fallback version", async () => {
  const result = await evidenceFor(
    ".tool-versions",
    "nodejs 20.11.1 # the RN baseline\n",
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(result.evidence, { version: "20.11.1" });
});

// PR #18 recorded a claim that a credential could not satisfy a validator, and
// `ghp_realLookingToken123` satisfied it. The same token is checked here
// against the version type, in the bare position and in the prerelease one a
// looser grammar would open. Both prerelease spellings are needed: the
// underscored one is refused by a semver-correct tag class on its own, so it
// alone would leave this test passing against that widening.
test("a credential-shaped pin is rejected rather than emitted", async () => {
  for (const value of [
    "ghp_realLookingToken123",
    "20.11.1-ghp_realLookingToken123",
    "20.11.1-ghpRealLookingToken123",
    "20.11.1 && curl https://example.invalid",
    "1".repeat(300),
    "../../etc/passwd",
  ]) {
    const result = await evidenceFor(".nvmrc", `${value}\n`);
    assert.equal(result.status, "uncertain", value);
    assert.equal(result.reason, "REJECTED_VALUE", value);
    assert.deepEqual(result.rejected, ["version"], value);
    assert.deepEqual(result.evidence, {}, value);
    assert.ok(!JSON.stringify(result).includes(value.slice(0, 12)), value);
  }
});

test("a tool-versions file reads the node line and no other tool's value", async () => {
  const result = await evidenceFor(
    ".tool-versions",
    "ruby 3.3.0\nnodejs 20.11.1\njava temurin-ghp_realLookingToken123\n",
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(result.evidence, { version: "20.11.1" });
});

// Every shape that declares the pin more than once, including the ones a first
// reading resolved by picking one: a second line, a fallback version on the same
// line, and a declaration repeated with the same value.
test("a file that declares the pin more than once is ambiguous", async () => {
  const files = [
    [".nvmrc", "20.11.1\n18.19.0\n"],
    [".tool-versions", "node 20.11.1\nnodejs 18.19.0\n"],
    [".tool-versions", "nodejs 20.11.1 18.19.0\n"],
    [".tool-versions", "node 20.11.1\nnode 20.11.1\n"],
  ];
  for (const [name, contents] of files) {
    const result = await evidenceFor(name, contents);
    assert.equal(result.status, "uncertain", contents);
    assert.equal(result.reason, "AMBIGUOUS", contents);
  }
});

// The mise reader parses instead of scanning, and these are the shapes the line
// reader that preceded it kept getting wrong: a table header, a dotted key, an
// inline table, a one-element list, and a comment sharing the line.
test("a mise config reads the pin however the file spells it", async () => {
  for (const [name, contents] of [
    ["mise.toml", '[tools]\nnode = "20.11.1"\n'],
    [".mise.toml", '[tools]\nnode = "20.11.1"\n'],
    ["mise.toml", '[tools.node]\nversion = "20.11.1"\n'],
    ["mise.toml", 'tools.node = "20.11.1"\n'],
    ["mise.toml", '[tools]\nnode = { version = "20.11.1" }\n'],
    ["mise.toml", '[tools]\nnode = ["20.11.1"]\n'],
    ["mise.toml", '[tools]\nnodejs = "20.11.1"\n'],
    ["mise.toml", '[tools]\n"core:node" = "20.11.1"\n'],
    ["mise.toml", '[tools] # the toolchain\nnode = "20.11.1" # pinned\n'],
  ]) {
    const result = await evidenceFor(name, contents);
    assert.equal(result.status, "ok", contents);
    assert.equal(result.kind, "node-pin", contents);
    assert.deepEqual(result.evidence, { version: "20.11.1" }, contents);
    assert.ok(!("rejected" in result), contents);
  }
});

// The whole file is parsed, `[env]` included, and that table has no path out
// because no field addresses it. This is the property that let the special case
// for this one format go away rather than be reasoned about.
test("a mise env table is parsed and still cannot reach the output", async () => {
  const result = await evidenceFor(
    "mise.toml",
    '[env]\nNODE_AUTH_TOKEN = "ghp_realLookingToken123"\n' +
      '[tools]\nnode = "20.11.1"\n[settings]\nexperimental = true\n',
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(result.evidence, { version: "20.11.1" });
  assert.ok(!JSON.stringify(result).includes("ghp_"), JSON.stringify(result));
});

// `[settings]` with `experimental = true` is ordinary mise and declares no tool.
// A line reader that validated every assignment uniformly refused files like
// this one, which is what made it wrong mostly rather than sometimes.
test("a mise config that names no tool declares no pin", async () => {
  for (const contents of [
    "[settings]\nexperimental = true\n",
    '[env]\nNODE_AUTH_TOKEN = "ghp_realLookingToken123"\n',
    '[tools]\nruby = "3.3.0"\n',
    "# nothing but a comment\n",
    "",
  ]) {
    const result = await evidenceFor("mise.toml", contents);
    assert.equal(result.status, "uncertain", contents);
    assert.equal(result.reason, "NO_EVIDENCE", contents);
    assert.ok(!JSON.stringify(result).includes("ghp_"), contents);
  }
});

// TOML has types, so `node = 20` is a number and not a pin. A declaration this
// reader locates and cannot read is a rejected field, never an absent one.
test("a mise pin that is not a string is rejected rather than read", async () => {
  for (const contents of [
    "[tools]\nnode = 20\n",
    "[tools]\nnode = 20.11\n",
    "[tools]\nnode = 2020-01-01\n",
    "[tools]\nnode = true\n",
    // a date is an object, so a check for one collapsed this into an absence
    "tools = 2020-01-01\n",
    "[tools]\nnode = []\n",
    '[tools]\nnode = { postinstall = "x" }\n',
    'tools = "everything"\n',
    '[tools]\nnode = "ghp_realLookingToken123"\n',
    "[tools]\nnode = \"{{ exec(command='echo 20') }}\"\n",
  ]) {
    const result = await evidenceFor("mise.toml", contents);
    assert.equal(result.status, "uncertain", contents);
    assert.equal(result.reason, "REJECTED_VALUE", contents);
    assert.deepEqual(result.rejected, ["version"], contents);
    assert.deepEqual(result.evidence, {}, contents);
    assert.ok(!JSON.stringify(result).includes("ghp_"), contents);
  }
});

// Every version in a list is a candidate, and the two tool names are counted
// together: a file naming the pin under both declares it twice.
test("a mise config that declares the pin twice does not resolve", async () => {
  for (const contents of [
    '[tools]\nnode = ["20.11.1", "18.19.0"]\n',
    '[tools]\nnode = ["20.11.1", "20.11.1"]\n',
    '[tools]\nnode = "20.11.1"\nnodejs = "18.19.0"\n',
    '[tools]\nnode = "20.11.1"\nnodejs = "20.11.1"\n',
    '[tools]\nnode = "20.11.1"\n"core:node" = "20.11.1"\n',
  ]) {
    const result = await evidenceFor("mise.toml", contents);
    assert.equal(result.status, "uncertain", contents);
    assert.equal(result.reason, "AMBIGUOUS", contents);
    assert.deepEqual(result.evidence, {}, contents);
  }
});

// A TOML parser's message quotes the line it failed on, so a file it refuses is
// reported by code and the error object is never read. A duplicate key is the
// format's own refusal and arrives the same way. The byte-order mark is here
// because the parser rejects one and this reader passes that on: whether mise
// itself would read the file is not established, and the refusal is the
// direction to be wrong in.
test("a mise config the parser refuses is reported by code alone", async () => {
  for (const contents of [
    '[tools]\nnode = "20.11.1"\nnode = "18.19.0"\n',
    "[tools]\nnode = ghp_realLookingToken123\n",
    "[tools]\nnode = \n",
    '\uFEFF[tools]\nnode = "20.11.1"\n',
  ]) {
    const result = await evidenceFor("mise.toml", contents);
    assert.equal(result.status, "refused", contents);
    assert.equal(result.kind, "node-pin", contents);
    assert.equal(result.reason, "ADAPTER_FAILED", contents);
    assert.deepEqual(result.evidence, {}, contents);
    assert.ok(!JSON.stringify(result).includes("ghp_"), contents);
  }
});

// Each vendored package's own `package.json` is what declares the module format
// of the `.js` files beside it, and the two here declare different ones. Drop
// one and Node infers the format from syntax instead — an inference absent from
// releases inside this skill's supported range, and one an ancestor
// `package.json` overrides where it is present. An installed plugin sits in a
// cache directory whose parents it does not choose, so this runs the CLI under
// such a parent. Without the declaration the import fails before any evidence
// command runs, taking every adapter with it and not only the one that reads
// the file.
//
// Both ancestor types are exercised, because each exposes only the package
// whose need it contradicts: under `commonjs` a missing `"type": "module"` is
// fatal and a missing `"type": "commonjs"` is invisible, and under `module` it
// is the other way round. This test covered one direction first, and deleting
// the other package's `package.json` left it passing.
test("the helper starts under an ancestor package of either module type", async () => {
  const inputs = [
    ["mise.toml", '[tools]\nnode = "20.11.1"\n', { version: "20.11.1" }],
    [
      "pnpm-workspace.yaml",
      "catalog:\n  react: ^18.3.1\n",
      { react: "^18.3.1" },
    ],
  ];
  for (const type of ["commonjs", "module"]) {
    const dir = await mkdtemp(join(tmpdir(), "rn-evidence-"));
    await writeFile(join(dir, "package.json"), `{ "type": "${type}" }\n`);
    await cp(HERE, join(dir, "skill"), { recursive: true });
    for (const [name, contents, evidence] of inputs) {
      await writeFile(join(dir, name), contents);
      const run = spawnSync(
        process.execPath,
        [join(dir, "skill", "evidence.mjs"), "--read", join(dir, name)],
        { encoding: "utf8" },
      );
      assert.equal(run.status, 0, `${type}/${name}: ${run.stderr}`);
      assert.deepEqual(
        JSON.parse(run.stdout).evidence,
        evidence,
        `${type}/${name}`,
      );
    }
  }
});

// A pnpm workspace keeps the version in its catalog, and a manifest that uses
// one writes `"react": "catalog:"` — which the dependency-range type rejects,
// correctly, because the registry never resolves it. So this adapter is what
// keeps a catalog project from reporting no range for react at all.
test("a pnpm catalog reads the three packages", async () => {
  const result = await evidenceFor(
    "pnpm-workspace.yaml",
    "packages:\n  - apps/*\ncatalog:\n  react: ^18.3.1\n" +
      "  react-native: 0.74.5\n  expo: ~51.0.0\n" +
      "  private-lib: https://x-access-token:ghp_realLookingToken123@example.invalid/a.git\n",
  );
  assert.equal(result.status, "ok");
  assert.equal(result.kind, "pnpm-workspace");
  assert.deepEqual(result.evidence, {
    react: "^18.3.1",
    reactNative: "0.74.5",
    expo: "~51.0.0",
  });
  // the workspace globs and the fourth entry have no field, so no path out
  assert.ok(!JSON.stringify(result).includes("ghp_"), JSON.stringify(result));
  assert.ok(!JSON.stringify(result).includes("apps/"), JSON.stringify(result));
});

// pnpm applies YAML merge keys before it reads the default catalog. Keep that
// value in the typed projection instead of making the redacted copy responsible
// for a range this adapter already reads.
test("a pnpm catalog reads a default entry supplied by a merge key", async () => {
  const result = await evidenceFor(
    "pnpm-workspace.yaml",
    "defaults: &defaults\n" +
      "  react: ^19.0.0\n" +
      "catalog:\n" +
      "  <<: *defaults\n",
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(result.evidence, { react: "^19.0.0" });
});

// A named catalog is selected by a manifest writing `catalog:<name>`, and
// naming it here would put a project-owned string in the output. It reads as no
// default catalog, which is what the file says.
test("a pnpm workspace with no default catalog declares no version", async () => {
  for (const contents of [
    "packages:\n  - apps/*\n",
    "catalogs:\n  rn:\n    react: ^18.3.1\n",
    "# a comment and nothing else\n",
    "",
    "- a\n- b\n",
  ]) {
    const result = await evidenceFor("pnpm-workspace.yaml", contents);
    assert.equal(result.status, "uncertain", contents);
    assert.equal(result.reason, "NO_EVIDENCE", contents);
    assert.deepEqual(result.evidence, {}, contents);
  }
});

// YAML 1.2's core schema types a bare `18` as a number, so a catalog entry
// written without quotes is not a range. A catalog that is present and is not a
// mapping is every field unreadable rather than every field absent.
test("a catalog entry that is not a range is rejected rather than read", async () => {
  const cases = [
    ["catalog:\n  react: 18\n", ["react"]],
    ["catalog:\n  react:\n", ["react"]],
    ["catalog:\n  react:\n    - 18\n", ["react"]],
    [
      "catalog:\n  react: https://x:ghp_realLookingToken123@example.invalid/a.git\n",
      ["react"],
    ],
    ["catalog: everything\n", ["react", "reactNative", "expo"]],
  ];
  for (const [contents, rejected] of cases) {
    const result = await evidenceFor("pnpm-workspace.yaml", contents);
    assert.equal(result.status, "uncertain", contents);
    assert.equal(result.reason, "REJECTED_VALUE", contents);
    assert.deepEqual(result.rejected, rejected, contents);
    assert.deepEqual(result.evidence, {}, contents);
    assert.ok(!JSON.stringify(result).includes("ghp_"), contents);
  }
});

// A YAML parser's message quotes the line and column it failed on, so a file it
// refuses is reported by code. A duplicate key is one of those files, which is
// also the rule this reader would apply itself.
test("a pnpm workspace the parser refuses is reported by code alone", async () => {
  for (const contents of [
    "catalog:\n  react: 18.3.1\n  react: 19.0.0\n",
    "catalog:\n  react: 18.3.1\n\tghp_realLookingToken123: x\n",
  ]) {
    const result = await evidenceFor("pnpm-workspace.yaml", contents);
    assert.equal(result.status, "refused", contents);
    assert.equal(result.kind, "pnpm-workspace", contents);
    assert.equal(result.reason, "ADAPTER_FAILED", contents);
    assert.deepEqual(result.evidence, {}, contents);
    assert.ok(!JSON.stringify(result).includes("ghp_"), contents);
  }
});

// The discovery row returns one name and this adapter claims that name. pnpm
// reads no `.yml` spelling of it, and claiming one would answer for a file the
// row never offered.
// Two formats under one name, and neither parses as the other, so this reader
// asks which stamp is present rather than parsing. The value it emits is one of
// two literals of its own — no part of the lockfile becomes it, which is what
// keeps a credentialed `resolved` URL beside the header out of the answer.
test("a yarn lockfile reports which generation wrote it", async () => {
  const classic = await evidenceFor(
    "yarn.lock",
    "# yarn lockfile v1\n\n" +
      '"private-pkg@^1.0.0":\n  version "1.0.0"\n' +
      '  resolved "https://x:ghp_realLookingToken123@registry.invalid/p.tgz"\n',
  );
  assert.equal(classic.status, "ok");
  assert.equal(classic.kind, "yarn-lockfile");
  assert.deepEqual(classic.evidence, { generation: "classic" });
  assert.ok(!JSON.stringify(classic).includes("ghp_"), JSON.stringify(classic));

  const berry = await evidenceFor("yarn.lock", "__metadata:\n  version: 8\n");
  assert.deepEqual(berry.evidence, { generation: "berry" });
});

// Every `yarn.lock` was written by some generation, so a file carrying neither
// stamp has a generation this reader could not read — a rejected field, not an
// absent one. A file carrying both does not resolve, which is the rule this
// reader already applies to a thing declared twice.
test("a yarn lockfile this cannot place is not read as generationless", async () => {
  for (const contents of [
    '"pkg@^1":\n  version "1.0.0"\n',
    "",
    "x # yarn lockfile v1\n",
  ]) {
    const result = await evidenceFor("yarn.lock", contents);
    assert.equal(result.status, "uncertain", contents);
    assert.equal(result.reason, "REJECTED_VALUE", contents);
    assert.deepEqual(result.rejected, ["generation"], contents);
  }

  const both = await evidenceFor(
    "yarn.lock",
    "# yarn lockfile v1\n__metadata:\n  version: 8\n",
  );
  assert.equal(both.status, "uncertain");
  assert.equal(both.reason, "AMBIGUOUS");
  assert.deepEqual(both.evidence, {});
});

// The linker is a member of a closed set, and this adapter exists because the
// reader it will replace checked shape: `detectInstallMode` accepts `[\w-]+`,
// so a token in that position is emitted as the linker with `ambiguous` false.
// Membership cannot do that, whatever a project writes there.
test("a yarnrc reports only a linker Yarn actually has", async () => {
  for (const value of ["node-modules", "pnp", "pnpm", '"node-modules"']) {
    const result = await evidenceFor(".yarnrc.yml", `nodeLinker: ${value}\n`);
    assert.equal(result.status, "ok", value);
    assert.equal(result.kind, "yarnrc", value);
    assert.deepEqual(
      result.evidence,
      { declaredLinker: value.replaceAll('"', "") },
      value,
    );
  }
  for (const value of [
    "ghp_realLookingToken123",
    "node_modules",
    "NODE-MODULES",
    "pnp-strict",
    "",
  ]) {
    const result = await evidenceFor(".yarnrc.yml", `nodeLinker: ${value}\n`);
    assert.equal(result.status, "uncertain", JSON.stringify(value));
    assert.ok(!JSON.stringify(result).includes("ghp_"), value);
  }
});

// The keys beside it are why the row this replaces reads a redacted copy. None
// of them has a field, so none of them has a path out, and the key list the
// copy row needs is not a thing this adapter has to keep.
test("a yarnrc credential has no field and so no way out", async () => {
  const result = await evidenceFor(
    ".yarnrc.yml",
    "nodeLinker: node-modules # rotate before release\n" +
      "yarnPath: .yarn/releases/yarn-4.1.1.cjs\n" +
      "npmAuthToken: ghp_realLookingToken123\n" +
      'npmRegistryServer: "https://ci:ghp_realLookingToken123@npm.invalid:4873"\n',
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(result.evidence, { declaredLinker: "node-modules" });
  assert.ok(!JSON.stringify(result).includes("ghp_"), JSON.stringify(result));
  assert.ok(!JSON.stringify(result).includes("yarn-4.1.1"), "yarnPath");
});

// A setting declared inside another block is not Yarn's linker setting. The
// reader this replaces anchored a regex at column 0 to say that; a parser says
// it by structure, and the difference is that a parser cannot be fooled by
// indentation the regex did not anticipate.
test("a yarnrc declaring no linker at the top level declares none", async () => {
  for (const contents of [
    "packageExtensions:\n  nodeLinker: pnp\n",
    "yarnPath: .yarn/releases/yarn-4.1.1.cjs\n",
    "",
    "# a comment and nothing else\n",
  ]) {
    const result = await evidenceFor(".yarnrc.yml", contents);
    assert.equal(result.status, "uncertain", contents);
    assert.equal(result.reason, "NO_EVIDENCE", contents);
    assert.deepEqual(result.evidence, {}, contents);
  }
});

// The same rule the pnpm reader draws, because they share the reader that draws
// it: a document the parser did not read whole is refused rather than partly
// read.
test("a yarnrc the parser cannot read whole is refused", async () => {
  for (const contents of [
    "nodeLinker: !foo pnp\n",
    "nodeLinker: pnp\nnodeLinker: pnpm\n",
    "nodeLinker:\n\tpnp\n",
  ]) {
    const result = await evidenceFor(".yarnrc.yml", contents);
    assert.equal(result.status, "refused", contents);
    assert.equal(result.kind, "yarnrc", contents);
    assert.equal(result.reason, "ADAPTER_FAILED", contents);
  }
});

test("a pnpm workspace file under another name is an unsupported input", async () => {
  for (const name of ["pnpm-workspace.yml", "workspace.yaml"]) {
    const result = await evidenceFor(name, "catalog:\n  react: ^18.3.1\n");
    assert.equal(result.status, "refused", name);
    assert.equal(result.reason, "UNSUPPORTED_INPUT", name);
  }
});

// pnpm's own selection, reproduced against its bundle: the default catalog is
// `catalog` or `catalogs.default`, the named form wins the spread that builds
// the set, and a file defining it both ways is one pnpm refuses outright.
test("the default catalog is read from either place pnpm accepts it", async () => {
  const named = await evidenceFor(
    "pnpm-workspace.yaml",
    "catalogs:\n  default:\n    react: ^18.3.1\n    react-native: 0.74.5\n",
  );
  assert.equal(named.status, "ok");
  assert.deepEqual(named.evidence, { react: "^18.3.1", reactNative: "0.74.5" });

  // defined both ways: pnpm throws INVALID_CATALOGS_CONFIGURATION, so nothing
  // here resolves to one of them either
  const both = await evidenceFor(
    "pnpm-workspace.yaml",
    "catalog:\n  react: ^18.3.1\ncatalogs:\n  default:\n    react: ^19.0.0\n",
  );
  assert.equal(both.status, "uncertain");
  assert.equal(both.reason, "REJECTED_VALUE");
  assert.deepEqual(both.rejected, ["react", "reactNative", "expo"]);
  assert.deepEqual(both.evidence, {});

  // a `catalogs` entry that is not the default one is not the default catalog
  const other = await evidenceFor(
    "pnpm-workspace.yaml",
    "catalogs:\n  rn:\n    react: ^18.3.1\n",
  );
  assert.equal(other.reason, "NO_EVIDENCE");
  assert.deepEqual(other.evidence, {});
});

// The spread that builds pnpm's catalog set reaches `default` whenever the
// mapping carries that key, and what it finds there wins — a null included.
// pnpm then refuses the workspace through `assertValidWorkspaceManifestCatalogs`,
// which names a null named catalog as its own case. A `catalogs` that is absent
// or itself null spreads nothing, so the bare field stands.
test("a present catalogs.default wins the selection even when it is null", async () => {
  const overridden = await evidenceFor(
    "pnpm-workspace.yaml",
    "catalog:\n  react: ^18.3.1\ncatalogs:\n  default:\n",
  );
  assert.equal(overridden.status, "uncertain");
  assert.equal(overridden.reason, "REJECTED_VALUE");
  assert.deepEqual(overridden.rejected, ["react", "reactNative", "expo"]);

  for (const contents of [
    "catalog:\n  react: ^18.3.1\ncatalogs:\n",
    "catalog:\n  react: ^18.3.1\n",
  ]) {
    const kept = await evidenceFor("pnpm-workspace.yaml", contents);
    assert.equal(kept.status, "ok", contents);
    assert.deepEqual(kept.evidence, { react: "^18.3.1" }, contents);
  }

  for (const contents of ["catalogs: nope\n", "catalogs:\n  default: nope\n"]) {
    const unreadable = await evidenceFor("pnpm-workspace.yaml", contents);
    assert.equal(unreadable.reason, "REJECTED_VALUE", contents);
    assert.deepEqual(unreadable.evidence, {}, contents);
  }
});

// The two nulls mean different things, and the difference is pnpm's own:
// `assertValidWorkspaceManifestCatalog` returns immediately for a null bare
// catalog, so that file declares no catalog rather than being one this reader
// failed to read; `assertValidWorkspaceManifestCatalogs` throws on a null named
// one by name.
test("a null bare catalog is an absence and a null named one is not", async () => {
  for (const contents of [
    "catalog:\n",
    "catalog: null\n",
    "packages:\n  - apps/*\ncatalog:\n",
  ]) {
    const absent = await evidenceFor("pnpm-workspace.yaml", contents);
    assert.equal(absent.status, "uncertain", contents);
    assert.equal(absent.reason, "NO_EVIDENCE", contents);
    assert.deepEqual(absent.evidence, {}, contents);
  }

  // a null bare catalog leaves the named one to be selected, as the spread does
  const named = await evidenceFor(
    "pnpm-workspace.yaml",
    "catalog:\ncatalogs:\n  default:\n    react: ^18.3.1\n",
  );
  assert.equal(named.status, "ok");
  assert.deepEqual(named.evidence, { react: "^18.3.1" });

  const both = await evidenceFor(
    "pnpm-workspace.yaml",
    "catalog:\ncatalogs:\n  default:\n",
  );
  assert.equal(both.reason, "REJECTED_VALUE");
});

// A YAML warning is printed by Node's own handler and quotes the source line
// that raised it, so an entry no field addresses reached stderr whole. Two
// things close it and both are kept: the reader asks its parser for `error`
// rather than the default, and the CLI drops the process warning listener so a
// parser added later cannot reopen the channel by not asking.
test("a construct that makes the parser warn puts nothing on stderr", async () => {
  const path = await withFile(
    "pnpm-workspace.yaml",
    "catalog:\n  react: ^18.3.1\n  private-lib: !foo ghp_realLookingToken123\n",
  );
  const run = spawnSync(process.execPath, [SCRIPT, "--read", path], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0);
  assert.equal(run.stderr, "");
  // and the document is refused, because a warning is the parser saying it did
  // not resolve part of it — the tag sits on an entry no field addresses, and
  // that is deliberately not what decides it
  assert.equal(JSON.parse(run.stdout).reason, "ADAPTER_FAILED");
  assert.deepEqual(JSON.parse(run.stdout).evidence, {});
  assert.ok(!run.stdout.includes("ghp_"), run.stdout);
});

// `silent` would suppress the warning and the throw with it, which is the
// option this reader must not take: a file the parser cannot read has to stay a
// refusal.
// The line: a document this reader did not read whole is refused, whether the
// parser called it an error or a warning. An unresolved tag is the warning case,
// and `parse` would have handed back the scalar under the tag as though it had
// not been written — dropping the part that made the value unresolved, which
// this file's transforms are not allowed to do. A tag the parser does resolve,
// such as `!!str`, leaves no warning and is read.
test("a file the parser cannot read is still refused", async () => {
  for (const contents of [
    "catalog:\n  react: 1\n  react: 2\n",
    "catalog:\n\treact: 1\n",
    "catalog: {react: 1\n",
    "catalog:\n  react: !foo ^18.3.1\n",
    "catalog:\n  react: ^18.3.1\n  private-lib: !foo tok\n",
  ]) {
    const result = await evidenceFor("pnpm-workspace.yaml", contents);
    assert.equal(result.status, "refused", contents);
    assert.equal(result.reason, "ADAPTER_FAILED", contents);
  }
  const known = await evidenceFor(
    "pnpm-workspace.yaml",
    "catalog:\n  react: !!str ^18.3.1\n",
  );
  assert.equal(known.status, "ok");
  assert.deepEqual(known.evidence, { react: "^18.3.1" });
});

// An entry beside the ones the schema names is not read, and its shape does not
// decide whether they are evidence — including where it is a shape the file's
// own tool refuses. pnpm's `assertValidWorkspaceManifestCatalog` throws on a
// non-string entry, and the three adapters that read a keyed container all
// behave this way; refusing here instead would turn a plainly declared range
// into a wrong absence. `SKILL.md` records the limit under Not Examined.
test("an entry beside the named ones does not decide whether they are read", async () => {
  const catalog = await evidenceFor(
    "pnpm-workspace.yaml",
    "catalog:\n  react: ^18.3.1\n  invalid-package: 123\n  another: []\n",
  );
  // a shape pnpm's own validator rejects, and still not this reader's question
  assert.equal(catalog.status, "ok");
  assert.deepEqual(catalog.evidence, { react: "^18.3.1" });

  const manifest = await evidenceFor(
    "package.json",
    MANIFEST({ dependencies: { react: "18.3.1", "invalid-package": 123 } }),
  );
  assert.equal(manifest.status, "ok");
  assert.deepEqual(manifest.evidence, { react: "18.3.1" });
});

// A `pnpm-lock.yaml` as pnpm 11.25.0 writes one, trimmed to the parts a field
// addresses. The versions come from `importers` rather than from the `packages`
// keys, so nothing here cuts a name off a version and a scoped name's second
// `@` is not a question this reader has.
const PNPM_LOCK = (importers, rest = "") =>
  `lockfileVersion: '9.0'\n\nimporters:\n${importers}${rest}`;

// Measured against a real workspace on this machine: an importer's resolved
// version carries the peer dependencies it was resolved against as nested
// parenthesised groups, and a patched package carries a `patch_hash` group too.
// The version is what precedes them.
test("a pnpm lockfile reports what the importer resolved, without its peers", async () => {
  const result = await evidenceFor(
    "pnpm-lock.yaml",
    PNPM_LOCK(
      "  .:\n" +
        "    dependencies:\n" +
        "      react:\n" +
        "        specifier: 19.2.3\n" +
        "        version: 19.2.3\n" +
        "      react-native:\n" +
        "        specifier: 0.86.2\n" +
        "        version: 0.86.2(@babel/core@7.29.7(supports-color@8.1.1))(react@19.2.3)\n" +
        "    devDependencies:\n" +
        "      expo:\n" +
        "        specifier: 57.0.15\n" +
        "        version: 57.0.15(patch_hash=abc)(react-native@0.86.2(react@19.2.3))\n",
    ),
  );
  assert.equal(result.status, "ok");
  assert.equal(result.kind, "pnpm-lockfile");
  assert.deepEqual(result.evidence, {
    lockfileVersion: "9.0",
    react: "19.2.3",
    reactNative: "0.86.2",
    expo: "57.0.15",
  });
});

// A transform may only drop a part it has recognised, which is the rule the
// `packageManager` pin states. The groups are consumed one at a time and the
// tail has to end where the string does, so text after the last group leaves
// the value whole for the type to reject — the alternative reports `0.74.5` for
// a version this reader did not read.
test("a pnpm version keeps a tail the suffix reader cannot consume", async () => {
  for (const version of [
    "0.74.5(react@19.2.3) ghp_realLookingToken123",
    "0.74.5(react@19.2.3)ghp_realLookingToken123(x@1)",
    "0.74.5(react@19.2.3",
    "0.74.5)react@19.2.3(",
  ]) {
    const result = await evidenceFor(
      "pnpm-lock.yaml",
      PNPM_LOCK(
        "  .:\n" +
          "    dependencies:\n" +
          "      react-native:\n" +
          "        specifier: 0.74.5\n" +
          `        version: '${version}'\n`,
      ),
    );
    assert.equal(result.status, "uncertain", version);
    assert.deepEqual(result.rejected, ["reactNative"], version);
    assert.ok(!JSON.stringify(result).includes("ghp_"), version);
  }
});

// What is inside a peer group is pnpm's business, not this reader's: its own
// `indexOfDepPathSuffix` cuts at the balancing `(` without inspecting what it
// cut, and the remainder is an identity that is a run of `name@version` groups
// in one release and a hash in another. So a group holding something else is
// still a suffix, and the release before it is still the release. Against that
// reader this one is equal or stricter and never looser: `0.74.5(a)x(b)` is
// `0.74.5(a)x` to pnpm and stays whole here, and neither reports `0.74.5`.
test("a pnpm peer group's contents are not this reader's question", async () => {
  const version = async (value) =>
    (
      await evidenceFor(
        "pnpm-lock.yaml",
        PNPM_LOCK(
          "  .:\n" +
            "    dependencies:\n" +
            "      react-native:\n" +
            "        specifier: 0.74.5\n" +
            `        version: '${value}'\n`,
        ),
      )
    ).evidence.reactNative;
  for (const suffix of [
    "(react@19.2.3)",
    "(patch_hash=6f2c1b)",
    "(9f2c1baa5e)",
    "(not-a-peer)",
  ]) {
    assert.equal(await version(`0.74.5${suffix}`), "0.74.5", suffix);
  }
  // stricter than pnpm rather than looser, for the one shape they differ on
  assert.equal(await version("0.74.5(a)x(b)"), undefined);
});

// pnpm names the root importer `.` and every other one by its posix path
// relative to the lockfile, which is the key `--app-dir` produces. One importer
// is the answer without being told which; several are the question the flag
// exists to answer, and picking between them here is the guess the npm reader
// spent three rounds removing.
test("a pnpm workspace lockfile resolves per importer once the app is named", async () => {
  const contents = PNPM_LOCK(
    "  .:\n" +
      "    devDependencies:\n" +
      "      react:\n" +
      "        specifier: 17.0.2\n" +
      "        version: 17.0.2\n" +
      "  apps/mobile:\n" +
      "    dependencies:\n" +
      "      react:\n" +
      "        specifier: 19.2.3\n" +
      "        version: 19.2.3\n" +
      "  apps/web:\n" +
      "    dependencies:\n" +
      "      react:\n" +
      "        specifier: 18.3.1\n" +
      "        version: 18.3.1\n",
  );
  const path = await withFile("pnpm-lock.yaml", contents);
  const root = dirname(path);
  assert.equal(
    readEvidence(path, { appDir: join(root, "apps/mobile") }).evidence.react,
    "19.2.3",
  );
  assert.equal(
    readEvidence(path, { appDir: join(root, "apps/web") }).evidence.react,
    "18.3.1",
  );
  // the lockfile's own directory is the root importer, which pnpm writes as `.`
  assert.equal(readEvidence(path, { appDir: root }).evidence.react, "17.0.2");

  for (const options of [
    undefined,
    { appDir: join(root, "..", "elsewhere") },
    { appDir: join(root, "apps/absent") },
  ]) {
    const result = readEvidence(path, options);
    assert.equal(result.status, "uncertain", JSON.stringify(options));
    assert.ok(result.rejected.includes("react"), JSON.stringify(options));
  }
});

// An importer id above the lockfile is ordinary pnpm, not an app outside the
// file's tree. `getLockfileImporterId` is `path.relative(lockfileDir,
// projectDir)`, so `pnpm install --lockfile-dir` writes one whenever the
// lockfile does not sit at or above the project — reproduced on pnpm 11.25.0,
// which wrote a `../../…/proj` id for a lockfile placed in a subdirectory of
// its own project. The npm reader refuses such a key because npm writes every
// workspace beneath the lockfile; this one looks it up instead.
test("a pnpm importer above the lockfile is looked up, not refused", async () => {
  const path = await withFile(
    "pnpm-lock.yaml",
    PNPM_LOCK(
      "  ../app:\n" +
        "    dependencies:\n" +
        "      react:\n" +
        "        specifier: 19.2.3\n" +
        "        version: 19.2.3\n" +
        "  ..:\n" +
        "    dependencies:\n" +
        "      react:\n" +
        "        specifier: 18.3.1\n" +
        "        version: 18.3.1\n",
    ),
  );
  const here = dirname(path);
  assert.equal(
    readEvidence(path, { appDir: join(here, "../app") }).evidence.react,
    "19.2.3",
  );
  // `..` is a key of its own, which is why it is not the sentinel for an app
  // that cannot be written as a key
  assert.equal(
    readEvidence(path, { appDir: join(here, "..") }).evidence.react,
    "18.3.1",
  );
  // and a key the map does not hold is still refused, by the lookup rather
  // than by the shape of the path
  const absent = readEvidence(path, { appDir: join(here, "../elsewhere") });
  assert.equal(absent.status, "uncertain");
  assert.ok(absent.rejected.includes("react"));
});

// One importer needs no flag, for the reason a lockfile describing one package
// does not.
test("a pnpm lockfile with one importer needs no app", async () => {
  const result = await evidenceFor(
    "pnpm-lock.yaml",
    PNPM_LOCK(
      "  .:\n" +
        "    dependencies:\n" +
        "      react:\n" +
        "        specifier: 19.2.3\n" +
        "        version: 19.2.3\n",
    ),
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(result.evidence, {
    lockfileVersion: "9.0",
    react: "19.2.3",
  });
});

// The closed set is a guard before it is a field: what an importer holds is what
// its lockfile version declares, so no importer is read at all under a version
// this reader has not established. Emitting a version there while rejecting the
// one beside it would be the coupling `packageManagerPin` refuses to split — a
// definite version of something unidentified. Every `pnpm-lock.yaml` states a
// version, so a file without one is outside the set too rather than a separate
// case. Note `9.0` unquoted: YAML reads that as the number 9, which is not the
// string the set holds.
test("no importer is read under a lockfile version outside the closed set", async () => {
  const importer =
    "  .:\n" +
    "    dependencies:\n" +
    "      react:\n" +
    "        specifier: 19.2.3\n" +
    "        version: 19.2.3\n";
  const every = ["expo", "lockfileVersion", "react", "reactNative"];
  for (const declared of [
    "'6.0'",
    "'5.4'",
    "9.0",
    "ghp_realLookingToken123",
    "",
  ]) {
    const result = await evidenceFor(
      "pnpm-lock.yaml",
      `lockfileVersion: ${declared}\n\nimporters:\n${importer}`,
    );
    assert.equal(result.status, "uncertain", declared);
    assert.deepEqual(result.rejected.sort(), every, declared);
    assert.deepEqual(result.evidence, {}, declared);
    assert.ok(!JSON.stringify(result).includes("ghp_"), declared);
  }
  // and a file that states no version at all is the same answer
  const none = await evidenceFor("pnpm-lock.yaml", `importers:\n${importer}`);
  assert.equal(none.status, "uncertain");
  assert.deepEqual(none.rejected.sort(), every);
  assert.deepEqual(none.evidence, {});
});

// The version this reader admits is the one whose importers hold
// `{ specifier, version }`. An older lockfile puts the resolved version there
// directly and keeps the specifiers in a sibling map, and it is refused twice
// over: the guard above stops it before the importer is reached, and the reader
// would have found a scalar where it reads a mapping. The second is what makes
// the first a guard rather than the only thing standing there.
test("an older pnpm importer shape is unreadable rather than misread", async () => {
  const older =
    "  .:\n" +
    "    specifiers:\n" +
    "      react: ^18.3.1\n" +
    "    dependencies:\n" +
    "      react: 18.3.1\n";
  const guarded = await evidenceFor(
    "pnpm-lock.yaml",
    `lockfileVersion: '5.4'\n\nimporters:\n${older}`,
  );
  assert.equal(guarded.status, "uncertain");
  assert.deepEqual(guarded.evidence, {});

  // the same importer under the version the reader does admit, so the shape
  // check is shown to hold on its own rather than behind the guard
  const unguarded = await evidenceFor(
    "pnpm-lock.yaml",
    `lockfileVersion: '9.0'\n\nimporters:\n${older}`,
  );
  assert.equal(unguarded.status, "uncertain");
  assert.deepEqual(unguarded.rejected, ["react"]);
  assert.deepEqual(unguarded.evidence, { lockfileVersion: "9.0" });
});

// Every `pnpm-lock.yaml` has an importers block — 35 of 35 measured on this
// machine, and pnpm's own test for one of these objects requires it — so a file
// without one describes no app this reader can resolve rather than an app with
// no dependencies.
test("a pnpm lockfile with no importers states no absence", async () => {
  const result = await evidenceFor(
    "pnpm-lock.yaml",
    "lockfileVersion: '9.0'\n\npackages:\n\n  react@19.2.3:\n" +
      "    resolution: {integrity: sha512-aaa}\n",
  );
  assert.equal(result.status, "uncertain");
  assert.deepEqual(result.rejected.sort(), ["expo", "react", "reactNative"]);
  assert.deepEqual(result.evidence, { lockfileVersion: "9.0" });
});

// `packages` and `specifier` are where this file's credentials live, and no
// field addresses either — the same reason a `resolved` URL cannot leave an npm
// lockfile. A `packages` entry for another version of the same package is there
// too, and it is not what the importer resolved.
test("a pnpm lockfile credential has no field and so no way out", async () => {
  const result = await evidenceFor(
    "pnpm-lock.yaml",
    PNPM_LOCK(
      "  .:\n" +
        "    dependencies:\n" +
        "      private-pkg:\n" +
        "        specifier: https://ci:ghp_realLookingToken123@npm.invalid:4873/p.tgz\n" +
        "        version: '@npm.invalid:4873/p.tgz'\n" +
        "      react:\n" +
        "        specifier: 19.2.3\n" +
        "        version: 19.2.3\n",
      "\npackages:\n\n  react@17.0.2:\n" +
        "    resolution: {tarball: https://ci:ghp_realLookingToken123@npm.invalid:4873/r.tgz}\n",
    ),
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(result.evidence, {
    lockfileVersion: "9.0",
    react: "19.2.3",
  });
  assert.ok(!JSON.stringify(result).includes("ghp_"), JSON.stringify(result));
  assert.ok(!JSON.stringify(result).includes("17.0.2"), "a store copy");
});

// A package declared in two blocks with two versions is a file this reader does
// not resolve, which is the rule the manifest reader applies to a range
// declared twice. Two declarations agreeing still emit.
test("a pnpm package resolved twice over is not resolved by order", async () => {
  const both = (dev) =>
    "  .:\n" +
    "    dependencies:\n" +
    "      react:\n" +
    "        specifier: 19.2.3\n" +
    "        version: 19.2.3\n" +
    "    devDependencies:\n" +
    "      react:\n" +
    `        specifier: ${dev}\n` +
    `        version: ${dev}\n`;
  const differing = await evidenceFor(
    "pnpm-lock.yaml",
    PNPM_LOCK(both("18.3.1")),
  );
  assert.equal(differing.status, "uncertain");
  assert.deepEqual(differing.rejected, ["react"]);

  const agreeing = await evidenceFor(
    "pnpm-lock.yaml",
    PNPM_LOCK(both("19.2.3")),
  );
  assert.equal(agreeing.status, "ok");
  assert.equal(agreeing.evidence.react, "19.2.3");
});

// The same rule both other YAML readers draw, because all three share the
// reader that draws it: a document the parser did not read whole is refused
// rather than partly read.
test("a pnpm lockfile the parser cannot read whole is refused", async () => {
  for (const contents of [
    "lockfileVersion: !foo '9.0'\nimporters:\n  .: {}\n",
    "lockfileVersion: '9.0'\nlockfileVersion: '9.0'\nimporters:\n  .: {}\n",
  ]) {
    const result = await evidenceFor("pnpm-lock.yaml", contents);
    assert.equal(result.status, "refused", contents);
    assert.equal(result.kind, "pnpm-lockfile", contents);
    assert.equal(result.reason, "ADAPTER_FAILED", contents);
  }
});

// An alias key is compared as what it aliases. The owning parser must preserve
// that refusal before it projects either declaration.
test("a duplicate key written through an alias is refused too", async () => {
  const shadowed = await evidenceFor(
    "pnpm-lock.yaml",
    "lockfileVersion: '9.0'\n" +
      "importers:\n" +
      "  .:\n" +
      "    dependencies:\n" +
      "      ? &dep react\n" +
      "      :\n" +
      "        specifier: 19.2.3\n" +
      "        version: 19.2.3\n" +
      "      ? *dep\n" +
      "      : specifier: 18.3.1\n" +
      "        version: 18.3.1\n",
  );
  assert.equal(shadowed.status, "refused");
  assert.equal(shadowed.reason, "ADAPTER_FAILED");

  // and an anchor that shadows nothing is still an ordinary document: the
  // check refuses a duplicate, not an alias
  const clean = await evidenceFor(
    "pnpm-lock.yaml",
    "lockfileVersion: '9.0'\n" +
      "importers:\n" +
      "  .:\n" +
      "    dependencies:\n" +
      "      ? &other expo\n" +
      "      :\n" +
      "        specifier: 51.0.0\n" +
      "        version: 51.0.0\n" +
      "      react:\n" +
      "        specifier: 19.2.3\n" +
      "        version: 19.2.3\n",
  );
  assert.equal(clean.status, "ok");
  assert.deepEqual(clean.evidence, {
    lockfileVersion: "9.0",
    react: "19.2.3",
    expo: "51.0.0",
  });
});

// `toJS` writes a YAML mapping to a JavaScript object. Its object keys are
// strings, so the numeric key `1` and the string key `'1'` name the same
// property. The owning parser must refuse that ambiguity before projection.
test("YAML keys that collapse to one object property are refused", async () => {
  const path = await withFile(
    "pnpm-lock.yaml",
    "lockfileVersion: '9.0'\n" +
      "importers:\n" +
      "  1:\n" +
      "    dependencies:\n" +
      "      react:\n" +
      "        specifier: 17.0.2\n" +
      "        version: 17.0.2\n" +
      "  '1':\n" +
      "    dependencies:\n" +
      "      react:\n" +
      "        specifier: 19.2.3\n" +
      "        version: 19.2.3\n",
  );
  const result = readEvidence(path, {
    appDir: join(dirname(path), "1"),
  });
  assert.equal(result.status, "refused");
  assert.equal(result.reason, "ADAPTER_FAILED");
});

// pnpm loads YAML with a schema that recognizes only `true` and `false` as
// booleans.
// A `%YAML 1.1` directive must not make this reader attribute an importer named
// `yes` to an app named `true`.
test("a YAML 1.1 directive does not change pnpm scalar keys", async () => {
  const path = await withFile(
    "pnpm-lock.yaml",
    "%YAML 1.1\n" +
      "---\n" +
      "lockfileVersion: '9.0'\n" +
      "importers:\n" +
      "  yes:\n" +
      "    dependencies:\n" +
      "      react:\n" +
      "        specifier: 19.2.3\n" +
      "        version: 19.2.3\n",
  );
  const root = dirname(path);
  const namedYes = readEvidence(path, { appDir: join(root, "yes") });
  assert.equal(namedYes.status, "ok");
  assert.equal(namedYes.evidence.react, "19.2.3");

  const namedTrue = readEvidence(path, { appDir: join(root, "true") });
  assert.equal(namedTrue.status, "uncertain");
  assert.equal(namedTrue.evidence.react, undefined);
});

// pnpm's default YAML schema resolves an unquoted date to a timestamp.
// The app's plain directory name must not select that differently typed key.
test("an implicit timestamp importer is not matched as a plain app", async () => {
  const path = await withFile(
    "pnpm-lock.yaml",
    "lockfileVersion: '9.0'\n" +
      "importers:\n" +
      "  2026-09-04:\n" +
      "    dependencies:\n" +
      "      react:\n" +
      "        specifier: 19.2.3\n" +
      "        version: 19.2.3\n",
  );
  const result = readEvidence(path, {
    appDir: join(dirname(path), "2026-09-04"),
  });
  assert.equal(result.status, "uncertain");
  assert.deepEqual(result.evidence, { lockfileVersion: "9.0" });
});

// pnpm keeps an implicit timestamp key and a quoted date key as two different
// properties.
// The resource preflight must not collapse them under its own scalar schema,
// especially in a mapping that this reader does not use as evidence.
test("pnpm timestamp and string keys stay distinct outside evidence", async () => {
  const result = await evidenceFor(
    "pnpm-lock.yaml",
    "lockfileVersion: '9.0'\n" +
      "importers:\n" +
      "  .:\n" +
      "    dependencies:\n" +
      "      react:\n" +
      "        specifier: 19.2.3\n" +
      "        version: 19.2.3\n" +
      "packages:\n" +
      "  2026-09-04: ignored\n" +
      "  '2026-09-04': ignored too\n",
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(result.evidence, {
    lockfileVersion: "9.0",
    react: "19.2.3",
  });
});

// js-yaml only resolves zero-padded date-only scalars as timestamps. An
// unpadded date remains a string and may be a pnpm importer id.
test("an unpadded date importer stays a pnpm string key", async () => {
  const path = await withFile(
    "pnpm-lock.yaml",
    "lockfileVersion: '9.0'\n" +
      "importers:\n" +
      "  2026-9-4:\n" +
      "    dependencies:\n" +
      "      react:\n" +
      "        specifier: 19.2.3\n" +
      "        version: 19.2.3\n",
  );
  const result = readEvidence(path, {
    appDir: join(dirname(path), "2026-9-4"),
  });
  assert.equal(result.status, "ok");
  assert.equal(result.evidence.react, "19.2.3");
});

// pnpm coerces implicit integer keys before it stores a YAML mapping. A
// directory named after the source spelling must not receive evidence for the
// coerced importer id.
test("pnpm numeric importer keys use pnpm's coercion", async () => {
  for (const [sourceKey, importerId] of [
    ["0b10", "2"],
    ["1_000", "1000"],
  ]) {
    const path = await withFile(
      "pnpm-lock.yaml",
      "lockfileVersion: '9.0'\n" +
        "importers:\n" +
        `  ${sourceKey}:\n` +
        "    dependencies:\n" +
        "      react:\n" +
        "        specifier: 19.2.3\n" +
        "        version: 19.2.3\n",
    );
    const sourceNamed = readEvidence(path, {
      appDir: join(dirname(path), sourceKey),
    });
    assert.equal(sourceNamed.status, "uncertain", sourceKey);
    assert.equal(sourceNamed.evidence.react, undefined, sourceKey);

    const coerced = readEvidence(path, {
      appDir: join(dirname(path), importerId),
    });
    assert.equal(coerced.status, "ok", sourceKey);
    assert.equal(coerced.evidence.react, "19.2.3", sourceKey);
  }
});

// pnpm stringifies a sequence key with JavaScript's array coercion. The
// vendored parser must not attribute the same entry to its own formatted key.
test("pnpm collection importer keys use pnpm's coercion", async () => {
  const path = await withFile(
    "pnpm-lock.yaml",
    "lockfileVersion: '9.0'\n" +
      "importers:\n" +
      "  ? [foo, bar]\n" +
      "  : dependencies:\n" +
      "      react:\n" +
      "        specifier: 19.2.3\n" +
      "        version: 19.2.3\n",
  );
  const pnpmNamed = readEvidence(path, {
    appDir: join(dirname(path), "foo,bar"),
  });
  assert.equal(pnpmNamed.status, "ok");
  assert.equal(pnpmNamed.evidence.react, "19.2.3");

  const formatted = readEvidence(path, {
    appDir: join(dirname(path), "[ foo, bar ]"),
  });
  assert.equal(formatted.status, "uncertain");
  assert.equal(formatted.evidence.react, undefined);
});

// A YAML 1.1 merge key contributes values instead of an object property. The
// duplicate check must leave that projection mechanism to `toJS` with its
// original value.
test("a YAML merge key is not counted as an object property", async () => {
  const result = await evidenceFor(
    "pnpm-lock.yaml",
    "%YAML 1.1\n" +
      "---\n" +
      "lockfileVersion: '9.0'\n" +
      "defaults: &defaults\n" +
      "  dependencies:\n" +
      "    react:\n" +
      "      specifier: 19.2.3\n" +
      "      version: 19.2.3\n" +
      "importers:\n" +
      "  .:\n" +
      "    <<: *defaults\n",
  );
  assert.equal(result.status, "ok");
  assert.equal(result.evidence.react, "19.2.3");
});

// A merge key contributes no property with its own name, but it is still a
// source key.
// Repeating it makes the later declaration disappear during projection, so the
// document was not read whole even when the first merged value looks valid.
test("repeated YAML merge keys are refused before projection", async () => {
  const result = await evidenceFor(
    "pnpm-lock.yaml",
    "%YAML 1.1\n" +
      "---\n" +
      "lockfileVersion: '9.0'\n" +
      "old: &old\n" +
      "  dependencies:\n" +
      "    react:\n" +
      "      specifier: 17.0.2\n" +
      "      version: 17.0.2\n" +
      "new: &new\n" +
      "  dependencies:\n" +
      "    react:\n" +
      "      specifier: 19.2.3\n" +
      "      version: 19.2.3\n" +
      "importers:\n" +
      "  .:\n" +
      "    <<: *old\n" +
      "    <<: *new\n",
  );
  assert.equal(result.status, "refused");
  assert.equal(result.reason, "ADAPTER_FAILED");
  assert.deepEqual(result.evidence, {});
});

// Resolving an alias key is what could have put the quadratic back, one level
// further in: `Alias.resolve` walks the whole document for its anchors unless
// it is handed a context to cache that walk in. Measured on the vendored 2.9.0
// with one context per call, 4,000 alias keys take 28s against 232ms for one
// shared context.
//
// The elapsed bound is measured from both sides, as the other one is: this pass
// takes 0.55s and 15.8s with a context per call. An earlier twenty-second bound
// let the second of those through, which is why the number is a measurement
// here and not a round figure.
test("many alias keys resolve against one shared context", async () => {
  const anchors = [];
  const keys = [];
  for (let i = 0; i < 4000; i += 1) {
    // the anchor sits on a scalar no key in the dependency map spells, so every
    // alias key below is distinct and the pass runs to the end rather than
    // throwing on the first pair
    anchors.push(`  - &a${i} pkg-${i}`);
    keys.push(
      `      ? *a${i}`,
      "      : specifier: 1.0.0",
      "        version: 1.0.0",
    );
  }
  const started = Date.now();
  const result = await evidenceFor(
    "pnpm-lock.yaml",
    `lockfileVersion: '9.0'\nnames:\n${anchors.join("\n")}\n` +
      `importers:\n  .:\n    dependencies:\n${keys.join("\n")}\n`,
  );
  // 4,000 alias keys, none of them a duplicate, so every one was resolved
  assert.equal(result.status, "ok");
  assert.deepEqual(result.evidence, { lockfileVersion: "9.0" });
  assert.ok(Date.now() - started < 5000, "the per-call context is back");
});

// The resource preflight protects the owning parser from inputs that expand or
// descend without bound. Both are small source files, and both are refused in
// well under a second.
test("a YAML input that expands or descends without bound is refused", async () => {
  // ten nested ten-element aliases, so the document is 10^9 nodes expanded and
  // under 500 bytes on disk. `yaml`'s own `maxAliasCount` stops the discarded
  // preflight projection before the owning parser sees the document.
  const rows = ["lockfileVersion: '9.0'", "a0: &a0 [x,x,x,x,x,x,x,x,x,x]"];
  for (let i = 1; i < 9; i += 1) {
    rows.push(
      `a${i}: &a${i} [${Array(10)
        .fill(`*a${i - 1}`)
        .join(",")}]`,
    );
  }
  const bomb = Date.now();
  const expanded = await evidenceFor("pnpm-lock.yaml", `${rows.join("\n")}\n`);
  assert.equal(expanded.status, "refused");
  assert.equal(expanded.reason, "ADAPTER_FAILED");
  assert.ok(Date.now() - bomb < 5000, "the alias bound is gone");

  // and a document nested deeper than the parser's own recursion. This one is
  // refused by the errors check rather than by anything downstream, and it is
  // the case that shows why that check is there: the parser reports
  // RESOURCE_EXHAUSTION, "Maximum call stack size exceeded", while `toJS`
  // succeeds on the partial tree it managed to build. Reading the projection
  // alone would have taken that partial document for a whole one.
  const deep = Date.now();
  const nested = await evidenceFor(
    "pnpm-lock.yaml",
    `lockfileVersion: '9.0'\ndeep: ${"[".repeat(200000)}${"]".repeat(200000)}\n`,
  );
  assert.equal(nested.status, "refused");
  assert.equal(nested.reason, "ADAPTER_FAILED");
  assert.ok(Date.now() - deep < 5000, "a deep document is not read slowly");
  // the errors check is what refuses it, so a reader that trusted `toJS` alone
  // would have emitted from a document the parser could not finish
  assert.deepEqual(nested.evidence, {});
});

// A YAML lockfile takes the lockfile bound, the same as the JSON one. The scale
// regression below keeps both parser passes within the reader's time bound.
test("a YAML lockfile takes the lockfile bound, not the configuration one", async () => {
  assert.equal(
    matchAdapter("pnpm-lock.yaml").maxBytes,
    matchAdapter("package-lock.json").maxBytes,
  );
  // a configuration file is not a lockfile and keeps the default
  for (const name of ["pnpm-workspace.yaml", ".yarnrc.yml"]) {
    assert.equal(matchAdapter(name).maxBytes, undefined, name);
  }
  // and the bound is a real refusal, not a declaration nothing reads
  const path = await withFile("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  assert.equal(readEvidence(path, { maxBytes: 4 }).reason, "TOO_LARGE");
});

// Duplicate detection has to survive a large sibling mapping, and it has to
// reach a nested mapping. A missed duplicate would emit a value from a
// declaration that shadowed another.
test("a duplicate key is caught at the scale the check was made for", async () => {
  const filler = Array.from({ length: 40000 }, (_, i) => `  k${i}: 1`).join(
    "\n",
  );
  const importer =
    "importers:\n" +
    "  .:\n" +
    "    dependencies:\n" +
    "      react:\n" +
    "        specifier: 19.2.3\n" +
    "        version: 19.2.3\n";
  const started = Date.now();
  const clean = await evidenceFor(
    "pnpm-lock.yaml",
    `lockfileVersion: '9.0'\n${importer}packages:\n${filler}\n`,
  );
  assert.equal(clean.status, "ok");
  assert.equal(clean.evidence.react, "19.2.3");
  assert.ok(Date.now() - started < 5000, "the quadratic check is back");

  // the duplicate sits at the far end of that mapping, so finding it is not an
  // early exit on the first few keys
  const shadowed = await evidenceFor(
    "pnpm-lock.yaml",
    `lockfileVersion: '9.0'\n${importer}packages:\n${filler}\n  k0: 2\n`,
  );
  assert.equal(shadowed.status, "refused");
  assert.equal(shadowed.reason, "ADAPTER_FAILED");

  // and one nested inside the importer, which is a mapping the visitor only
  // reaches by walking
  const nested = await evidenceFor(
    "pnpm-lock.yaml",
    "lockfileVersion: '9.0'\n" +
      "importers:\n" +
      "  .:\n" +
      "    dependencies:\n" +
      "      react:\n" +
      "        specifier: 19.2.3\n" +
      "        version: 19.2.3\n" +
      "        version: 18.3.1\n",
  );
  assert.equal(nested.status, "refused");
  assert.equal(nested.reason, "ADAPTER_FAILED");
});

// The discovery row returns this one name. pnpm reads no `.yml` spelling of it,
// and claiming one would answer for a file the row never offered.
test("a pnpm lockfile under another name is an unsupported input", async () => {
  for (const name of ["pnpm-lock.yml", "pnpm-lock.dev.yaml"]) {
    const result = await evidenceFor(name, "lockfileVersion: '9.0'\n");
    assert.equal(result.status, "refused", name);
    assert.equal(result.reason, "UNSUPPORTED_INPUT", name);
  }
});

// `yarn.lock` was in this list until it had an adapter, which is the shape to
// keep in mind when reading it: membership here is a statement about today's
// adapter set, not about the file being unreadable.
// The two mise names are here on purpose. `mise.toml` and `.mise.toml` are
// claimed and `mise.local.toml` is not, and mise's other locations arrive here
// as the basename `config.toml`, which belongs to every tool that keeps a file
// under `.config`. The refusal is what says so rather than an empty result.
test("a file no adapter claims is refused without being read", async () => {
  for (const [name, contents] of [
    ["config.toml", '[tools]\nnode = "20.11.1"\n'],
    ["mise.local.toml", '[tools]\nnode = "20.11.1"\n'],
  ]) {
    const result = await evidenceFor(name, contents);
    assert.equal(result.status, "refused", name);
    assert.equal(result.kind, null, name);
    assert.equal(result.reason, "UNSUPPORTED_INPUT", name);
    assert.deepEqual(result.evidence, {}, name);
  }
});

test("an absent file and a directory are separate refusals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rn-evidence-"));
  assert.equal(readEvidence(join(dir, ".nvmrc")).reason, "MISSING");
  await mkdir(join(dir, ".tool-versions"));
  assert.equal(readEvidence(join(dir, ".tool-versions")).reason, "NOT_A_FILE");
});

test("binary content is refused rather than decoded", async () => {
  const path = await withFile(".nvmrc", Buffer.from([0x32, 0x30, 0x00, 0x31]));
  assert.equal(readEvidence(path).reason, "NOT_TEXT");
});

test("a file over the read bound is refused unread", async () => {
  const path = await withFile(".nvmrc", "20.11.1\n");
  assert.equal(readEvidence(path, { maxBytes: 4 }).reason, "TOO_LARGE");
  assert.equal(readEvidence(path, { maxBytes: 8 }).status, "ok");
});

test("an empty file is read as declaring nothing", async () => {
  const path = await withFile(".nvmrc", "");
  const result = readEvidence(path);
  assert.equal(result.status, "uncertain");
  assert.equal(result.reason, "NO_EVIDENCE");
});

// The open is non-blocking for this reason: a plain open of a pipe waits for a
// writer. It runs in a child with a timeout because a blocked open blocks the
// whole process, and a blocked event loop cannot be interrupted by a test
// timeout — calling it here directly would hang the suite instead of failing it.
test("a named pipe is refused rather than waited on", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rn-evidence-"));
  const path = join(dir, ".nvmrc");
  execFileSync("mkfifo", [path]);
  const run = spawnSync(process.execPath, [SCRIPT, "--read", path], {
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(run.signal, null, "the CLI blocked on the pipe");
  assert.equal(run.status, 0);
  assert.equal(JSON.parse(run.stdout).reason, "NOT_A_FILE");
});

// The seam: an adapter cannot reach stdout, so a throwing one and an inventive
// one are both bounded by what this engine agrees to print.
test("an adapter that throws is refused without its message", () => {
  const message = "unexpected token at ghp_realLookingToken123";
  const result = applyAdapter(
    {
      kind: "stub",
      schema: { version: "node-version" },
      read() {
        throw new Error(message);
      },
    },
    "anything",
  );
  assert.deepEqual(result, {
    status: "refused",
    reason: "ADAPTER_FAILED",
    evidence: {},
  });
  assert.ok(!JSON.stringify(result).includes("ghp_"));
});

test("a field the schema does not name has no path to the output", () => {
  const result = applyAdapter(
    {
      kind: "stub",
      schema: { version: "node-version" },
      read: () => ({
        fields: { version: "20.11.1", token: "ghp_realLookingToken123" },
      }),
    },
    "anything",
  );
  assert.deepEqual(result, { status: "ok", evidence: { version: "20.11.1" } });
});

// The vocabulary is membership, not shape. A marker is spelled exactly like a
// code, so an uppercase pattern would have let one through as a reason.
test("a reason an adapter invents is replaced unless this file named it", () => {
  const read = (reason) => () => ({ reason });
  const withReason = (reason) =>
    applyAdapter({ kind: "stub", schema: {}, read: read(reason) }, "").reason;
  assert.equal(withReason("AMBIGUOUS"), "AMBIGUOUS");
  assert.equal(withReason("NO_EVIDENCE"), "NO_EVIDENCE");
  for (const invented of [
    "NODE_AUTH_TOKEN",
    "UNSUPPORTED_INPUT", // real, but not a reason an adapter may choose
    'failed to parse "ghp_realLookingToken123"',
    undefined,
  ]) {
    assert.equal(withReason(invented), "NO_EVIDENCE", String(invented));
  }
});

test("a refusal reason outside the vocabulary is not printed either", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rn-evidence-"));
  const path = join(dir, ".nvmrc");
  await writeFile(path, "20.11.1\n");
  await chmod(path, 0o000);
  const result = readEvidence(path);
  // root can read a 000 file, so accept either outcome and assert only that
  // whatever came back is a reason this CLI declares
  assert.ok(
    ["PERMISSION_DENIED", "UNREADABLE"].includes(result.reason) ||
      result.status === "ok",
    JSON.stringify(result),
  );
  await chmod(path, 0o600);
});

test("every registered name dispatches to exactly one adapter", () => {
  for (const name of [".nvmrc", ".node-version", ".tool-versions"]) {
    assert.equal(matchAdapter(name).kind, "node-pin", name);
  }
  assert.equal(matchAdapter("Mise.toml"), undefined);
});

test("the CLI prints one JSON object and takes exactly one file", async () => {
  const path = await withFile(".nvmrc", "20.11.1\n");
  const ok = spawnSync(process.execPath, [SCRIPT, "--read", path], {
    encoding: "utf8",
  });
  assert.equal(ok.status, 0);
  assert.equal(ok.stderr, "");
  assert.deepEqual(JSON.parse(ok.stdout).evidence, { version: "20.11.1" });

  // a malformed argument is caller text, and the parser quotes it in its own
  // message; the fixed line is what goes out instead
  for (const args of [
    [],
    ["--read", ""],
    ["--read", path, "--read", path],
    ["--not-an-option"],
    ["positional"],
    ["--read", path, "--app-dir", ""],
    ["--read", path, "--app-dir", "/a", "--app-dir", "/b"],
  ]) {
    const bad = spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
    });
    assert.equal(bad.status, 1, args.join(" "));
    assert.equal(bad.stdout, "", args.join(" "));
    assert.equal(
      bad.stderr,
      "[rn-upgrade-pulse-evidence] pass exactly one --read, and at most one --app-dir, each with a non-empty value\n",
      args.join(" "),
    );
  }
});
