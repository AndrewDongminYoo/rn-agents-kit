import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  detectInstallMode,
  projectManifest,
  readManifest,
  resolveInstalled,
} from "./rn-upgrade-pulse.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "rn-upgrade-pulse.mjs");

async function fixture() {
  return await mkdtemp(join(tmpdir(), "rn-upgrade-pulse-"));
}

async function linkerFixture(yarnrc, loader, { lock = true } = {}) {
  const root = await fixture();
  const appDir = join(root, "apps", "mobile");
  await mkdir(appDir, { recursive: true });
  if (yarnrc !== null) await writeFile(join(root, ".yarnrc.yml"), yarnrc);
  if (loader !== null) await writeFile(join(root, loader), "// loader");
  if (lock) {
    await writeFile(join(root, "yarn.lock"), "# yarn lockfile v1\n");
  }
  return { root, appDir };
}

test("install mode reports the declared linker and the loader separately", async () => {
  const { root, appDir } = await linkerFixture(
    "nodeLinker: node-modules\n",
    ".pnp.cjs",
  );
  try {
    const mode = detectInstallMode(appDir);
    assert.equal(mode.linker, "node-modules");
    assert.equal(mode.loader, "present");
    assert.equal(mode.ambiguous, false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a loader is reported even when nothing declares a linker", async () => {
  const { root, appDir } = await linkerFixture(null, ".pnp.js");
  try {
    const mode = detectInstallMode(appDir);
    assert.equal(mode.linker, null);
    assert.equal(mode.yarnConfig, "absent");
    assert.equal(mode.loader, "present");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a project with no Yarn evidence reports none", async () => {
  const { root, appDir } = await linkerFixture(null, null, { lock: false });
  try {
    const mode = detectInstallMode(appDir);
    assert.deepEqual(mode, {
      linker: null,
      yarnConfig: "absent",
      loader: "absent",
      yarnLock: "absent",
      yarnLockGeneration: null,
      ambiguous: false,
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a Berry config with no linker, lockfile or loader is still Yarn evidence", async () => {
  const { root, appDir } = await linkerFixture(
    "enableTelemetry: false\n",
    null,
    {
      lock: false,
    },
  );
  try {
    const mode = detectInstallMode(appDir);
    assert.equal(mode.linker, null);
    assert.equal(mode.yarnLock, "absent");
    assert.equal(mode.loader, "absent");
    // without this the rule reads "no Yarn evidence" and licenses a stale tree
    assert.equal(mode.yarnConfig, "present");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("the lockfile generation is read from its own header", async () => {
  for (const [body, expected] of [
    ["# yarn lockfile v1\n", "classic"],
    ["__metadata:\n  version: 8\n", "berry"],
  ]) {
    const root = await fixture();
    await writeFile(join(root, "yarn.lock"), body);
    try {
      assert.equal(detectInstallMode(root).yarnLockGeneration, expected, body);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
});

test("a configuration that declares nothing inherits the one above it", async () => {
  const { root, appDir } = await linkerFixture("nodeLinker: pnp\n", null);
  await writeFile(join(appDir, ".yarnrc.yml"), "enableTelemetry: false\n");
  try {
    const mode = detectInstallMode(appDir);
    // the nearer file declares nothing, so the one above it is the declaration
    assert.equal(mode.linker, "pnp");
    assert.equal(mode.yarnConfig, "present");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("the nearest configuration wins over one further up", async () => {
  const { root, appDir } = await linkerFixture("nodeLinker: pnp\n", null);
  await writeFile(join(appDir, ".yarnrc.yml"), 'nodeLinker: "node-modules"\n');
  try {
    const mode = detectInstallMode(appDir);
    // the nearer file declares node-modules and the one above it declares pnp
    assert.equal(mode.linker, "node-modules");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a linker value this cannot read is reported as ambiguous", async () => {
  for (const body of [
    "nodeLinker: ${YARN_NODE_LINKER-node-modules}\n",
    "nodeLinker:\n  - node-modules\n",
  ]) {
    const { root, appDir } = await linkerFixture(body, null);
    try {
      const mode = detectInstallMode(appDir);
      assert.equal(mode.linker, null, body);
      assert.equal(mode.ambiguous, true, body);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
});

// The defect this replaced: the value was taken by shape, so anything matching
// `[\w-]+` became the linker with `ambiguous` false — a credential printed as a
// definite setting. Membership cannot do that whatever a project writes there.
test("a value that is not one of Yarn's linkers is never emitted", async () => {
  for (const value of [
    "ghp_realLookingToken123",
    "node_modules",
    "NODE-MODULES",
    "pnp-strict",
    "true",
  ]) {
    const { root, appDir } = await linkerFixture(
      `nodeLinker: ${value}\n`,
      null,
    );
    try {
      const mode = detectInstallMode(appDir);
      assert.equal(mode.linker, null, value);
      assert.equal(mode.ambiguous, true, value);
      // Only for the credential-shaped one. A substring check cannot say
      // anything about `true`, which is a word this output legitimately holds
      // as the value of `ambiguous`.
      if (value.startsWith("ghp_")) {
        assert.ok(!JSON.stringify(mode).includes(value), value);
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
});

// Every member still reads, and so do the two spellings the pattern handles
// around them. Replacing the value capture is exactly how those get dropped
// without anyone noticing.
test("each linker Yarn has is read, quoted or with a comment after it", async () => {
  for (const [body, expected] of [
    ["nodeLinker: node-modules\n", "node-modules"],
    ["nodeLinker: pnp\n", "pnp"],
    ["nodeLinker: pnpm\n", "pnpm"],
    ['nodeLinker: "pnpm"\n', "pnpm"],
    ["nodeLinker: pnp # rotate before release\n", "pnp"],
  ]) {
    const { root, appDir } = await linkerFixture(body, null);
    try {
      const mode = detectInstallMode(appDir);
      assert.equal(mode.linker, expected, body);
      assert.equal(mode.ambiguous, false, body);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
});

// Yarn's nearest declaration wins whatever it says, so one this reader cannot
// interpret has to end the search too. Climbing past it would let an ancestor's
// linker stand for a setting Yarn would take from the nearer file, which is a
// plausible-looking wrong answer rather than an admitted gap.
test("a declaration this cannot read still ends the search", async () => {
  const { root, appDir } = await linkerFixture("nodeLinker: pnp\n", null);
  await writeFile(
    join(appDir, ".yarnrc.yml"),
    "nodeLinker: ghp_realLookingToken123\n",
  );
  try {
    const mode = detectInstallMode(appDir);
    assert.equal(mode.linker, null);
    assert.equal(mode.ambiguous, true);
    assert.ok(!JSON.stringify(mode).includes("ghp_"), JSON.stringify(mode));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

// The property this evidence was reshaped for. The four paths it used to carry
// were read by the skill as presence tests and by nothing else, and a directory
// name carries a credential as readily as a file's contents do.
test("install mode carries no path", async () => {
  const { root, appDir } = await linkerFixture(
    "nodeLinker: node-modules\n",
    ".pnp.cjs",
  );
  try {
    const mode = detectInstallMode(appDir);
    const serialised = JSON.stringify(mode);
    // the fixture root is a temporary directory, so its own name is the path
    // most likely to appear if any of them still does
    assert.ok(!serialised.includes(root), serialised);
    assert.ok(!serialised.includes("/"), serialised);
    assert.deepEqual(Object.keys(mode).sort(), [
      "ambiguous",
      "linker",
      "loader",
      "yarnConfig",
      "yarnLock",
      "yarnLockGeneration",
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

// The `.yarnrc.yml` reader refuses a document it did not read whole, and this
// walk has to turn that into "cannot tell" rather than into an exception or a
// climb. A file Yarn's own reader would refuse is a declaration this cannot see
// past, not one to step over.
test("a configuration the reader refuses is ambiguous, not inherited", async () => {
  for (const body of [
    "nodeLinker: pnp\nnodeLinker: pnpm\n",
    "nodeLinker:\n\tpnp\n",
    "nodeLinker: !foo pnp\n",
  ]) {
    const { root, appDir } = await linkerFixture("nodeLinker: pnp\n", null);
    await writeFile(join(appDir, ".yarnrc.yml"), body);
    try {
      const mode = detectInstallMode(appDir);
      assert.equal(mode.linker, null, body);
      assert.equal(mode.ambiguous, true, body);
      assert.equal(mode.yarnConfig, "present", body);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
});

test("a quoted top-level key is a declaration, an indented one is not", async () => {
  const quoted = await linkerFixture("'nodeLinker': node-modules\n", null);
  try {
    assert.equal(detectInstallMode(quoted.appDir).linker, "node-modules");
  } finally {
    await rm(quoted.root, { force: true, recursive: true });
  }

  // indented means nested: `packageExtensions` and plugin blocks can carry a
  // key of the same name, and neither selects Yarn's linker
  const nested = await linkerFixture(
    "packageExtensions:\n  nodeLinker: pnp\n",
    null,
  );
  try {
    assert.equal(detectInstallMode(nested.appDir).linker, null);
  } finally {
    await rm(nested.root, { force: true, recursive: true });
  }
});

// `readIfFile` has three outcomes and so does each presence field. A file that
// exists and cannot be read is not an absence, and reporting it as one would
// make the third condition of the install-mode rule — no Yarn evidence at all —
// read true for a project that plainly has some. `ambiguous` says the walk is
// uncertain; it does not say which input made it so.
test("a Yarn file that exists but cannot be read is present, not absent", async () => {
  for (const [name, field] of [
    [".yarnrc.yml", "yarnConfig"],
    ["yarn.lock", "yarnLock"],
    [".pnp.cjs", "loader"],
  ]) {
    const { root, appDir } = await linkerFixture(null, null, { lock: false });
    // a directory in place of the file: present, and not readable
    await mkdir(join(root, name));
    try {
      const mode = detectInstallMode(appDir);
      assert.equal(mode.ambiguous, true, name);
      assert.equal(mode[field], "unreadable", name);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
});

test("projection keeps nested override configuration intact", () => {
  const projected = projectManifest({
    name: "app",
    dependencies: { "react-native": "0.79.0" },
    pnpm: {
      overrides: { "react-native": "0.74" },
      peerDependencyRules: { allowedVersions: { react: "18" } },
    },
    overrides: { foo: { "react-native": "0.79" } },
    optionalDependencies: { expo: "~51.0.0" },
    peerDependencies: { "react-native": ">=0.74 <0.80" },
    peerDependenciesMeta: { "react-native": { optional: false } },
    unrelated: "dropped",
  });
  assert.equal(projected.unrelated, undefined);
  // the peer range is the constraint an upgrade violates
  assert.equal(projected.optionalDependencies.expo, "~51.0.0");
  assert.equal(projected.peerDependencies["react-native"], ">=0.74 <0.80");
  assert.equal(projected.peerDependenciesMeta["react-native"].optional, false);
  // util.inspect would render this third level as [Object]
  assert.deepEqual(projected.pnpm.peerDependencyRules.allowedVersions, {
    react: "18",
  });
  assert.deepEqual(projected.overrides.foo, { "react-native": "0.79" });
});

test("projection keeps devEngines, which npm enforces separately from engines", () => {
  const projected = projectManifest({
    name: "app",
    engines: { node: ">=20" },
    devEngines: { packageManager: { name: "pnpm", version: "10.x" } },
  });
  assert.equal(projected.devEngines.packageManager.name, "pnpm");
  assert.equal(projected.engines.node, ">=20");
});

test("an optionalDependencies range wins over a dependencies range", async () => {
  const { root, appDir } = await workspaceFixture({
    appManifest: {
      name: "app",
      dependencies: { "react-native": "0.74.0" },
      optionalDependencies: { "react-native": "0.79.0" },
    },
  });
  try {
    const byName = Object.fromEntries(
      resolveInstalled(appDir).map((entry) => [entry.name, entry]),
    );
    // npm: an optionalDependencies entry overrides the same name in dependencies
    assert.equal(byName["react-native"].declaredIn, "optionalDependencies");
    assert.equal(byName["react-native"].declaredRange, "0.79.0");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a missing manifest is a status, not a crash", async () => {
  const dir = await fixture();
  try {
    const result = readManifest(join(dir, "package.json"));
    assert.equal(result.status, "missing");
    assert.equal(result.reason, "ENOENT");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("a manifest that opens with a UTF-8 BOM is still read", async () => {
  const dir = await fixture();
  const pkgDir = join(dir, "node_modules", "react-native");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, "package.json"),
    `\uFEFF${JSON.stringify({ name: "react-native", version: "0.79.0" })}`,
  );
  const appManifest = join(dir, "package.json");
  await writeFile(
    appManifest,
    `\uFEFF${JSON.stringify({ name: "app", dependencies: { "react-native": "0.79.0" } })}`,
  );
  try {
    const read = readManifest(appManifest);
    assert.equal(read.status, "read");
    assert.equal(read.fields.dependencies["react-native"], "0.79.0");
    const byName = Object.fromEntries(
      resolveInstalled(dir).map((entry) => [entry.name, entry]),
    );
    // the BOM must not cost the declaration or the version
    assert.equal(byName["react-native"].status, "resolved");
    assert.equal(byName["react-native"].version, "0.79.0");
    assert.equal(byName["react-native"].declaredIn, "dependencies");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("an unparseable manifest is reported as such", async () => {
  const dir = await fixture();
  const path = join(dir, "package.json");
  await writeFile(path, '{ "name": "app", }');
  try {
    const result = readManifest(path);
    assert.equal(result.status, "unparseable");
    assert.ok(result.reason.length > 0);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("resolution reports the raw code rather than a verdict", async () => {
  const dir = await fixture();
  try {
    const packages = resolveInstalled(dir);
    for (const entry of packages) {
      assert.equal(entry.status, "unavailable");
      // an undeclared dependency and an uninstalled tree share this code
      assert.equal(entry.reason, "MODULE_NOT_FOUND");
    }
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("resolution reports the version and the manifest it came from", async () => {
  const dir = await fixture();
  const pkgDir = join(dir, "node_modules", "react-native");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "react-native", version: "0.79.0" }),
  );
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "app", dependencies: { "react-native": "0.79.0" } }),
  );
  try {
    const byName = Object.fromEntries(
      resolveInstalled(dir).map((entry) => [entry.name, entry]),
    );
    assert.equal(byName["react-native"].status, "resolved");
    assert.equal(byName["react-native"].version, "0.79.0");
    // require.resolve returns the real path; on macOS the fixture sits under /var
    assert.equal(
      byName["react-native"].manifestPath,
      realpathSync(join(pkgDir, "package.json")),
    );
    assert.equal(byName.expo.status, "unavailable");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("CLI prints the manifest projection as JSON", async () => {
  const dir = await fixture();
  const path = join(dir, "package.json");
  await writeFile(
    path,
    JSON.stringify({ name: "app", packageManager: "npm@11.0.0" }),
  );
  try {
    const result = spawnSync(process.execPath, [SCRIPT, "--manifest", path], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.status, "read");
    assert.equal(parsed.fields.packageManager, "npm@11.0.0");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("CLI app-dir mode prints the app root, the manifest status and the packages", async () => {
  const { root, appDir } = await workspaceFixture({
    appManifest: { name: "bare", dependencies: { "react-native": "0.79.0" } },
  });
  try {
    const result = spawnSync(process.execPath, [SCRIPT, "--app-dir", appDir], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.appDir, appDir);
    assert.equal(parsed.appManifest.status, "read");
    assert.equal(parsed.packages.length, 3);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("CLI app-dir mode names an unreadable app manifest as the cause", async () => {
  const dir = await fixture();
  const pkgDir = join(dir, "node_modules", "react-native");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "react-native", version: "0.79.0" }),
  );
  // Node refuses every resolution while the app manifest is unparseable, so
  // without appManifest the output is indistinguishable from an empty tree
  await writeFile(join(dir, "package.json"), '{ "name": "app", }');
  try {
    const result = spawnSync(process.execPath, [SCRIPT, "--app-dir", dir], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.appManifest.status, "unparseable");
    for (const entry of parsed.packages) {
      assert.equal(entry.status, "unavailable");
    }
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("CLI rejects a repeated mode flag", () => {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, "--manifest", "/tmp/a.json", "--manifest", "/tmp/b.json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /exactly one of/);
});

test("every projected field survives the projection", () => {
  const manifest = Object.fromEntries(
    [
      "name",
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
      "peerDependenciesMeta",
      "expo",
      "packageManager",
      "engines",
      "devEngines",
      "volta",
      "workspaces",
      "scripts",
      "overrides",
      "resolutions",
      "pnpm",
    ].map((field) => [field, { marker: field }]),
  );
  const projected = projectManifest(manifest);
  // dropping any one field from MANIFEST_FIELDS must fail this
  for (const field of Object.keys(manifest)) {
    if (["scripts", "expo"].includes(field)) continue;
    assert.deepEqual(projected[field], { marker: field }, field);
  }
  // a free-form field is projected by name, so it survives as its keys
  for (const field of ["scripts", "expo"]) {
    assert.deepEqual(projected[field], ["marker"], field);
  }
});

test("a free-form field projects to names and never to values", () => {
  const projected = projectManifest({
    expo: { name: "app", extra: { apiKey: "MARKER_EXPO", eas: {} } },
    pnpm: { overrides: { a: "1" } },
  });
  assert.doesNotMatch(JSON.stringify(projected), /MARKER_EXPO/);
  assert.deepEqual(projected.expo, ["name", "extra"]);
  // `pnpm` is a schema the package manager owns, so its values are kept
  assert.equal(projected.pnpm.overrides.a, "1");
});

test("scripts project to names and never to command lines", () => {
  const projected = projectManifest({
    scripts: {
      test: "jest",
      release: "SENTRY_AUTH_TOKEN=MARKER_TOKEN npx sentry-cli releases new",
    },
  });
  assert.deepEqual(projected.scripts, ["test", "release"]);
  assert.doesNotMatch(JSON.stringify(projected), /MARKER_TOKEN/);
});

test("a scripts value that is not a plain object projects to null", () => {
  assert.equal(projectManifest({ scripts: ["test"] }).scripts, null);
  assert.equal(projectManifest({ scripts: "test" }).scripts, null);
});

test("a dependency specifier has its URL credentials redacted", () => {
  const projected = projectManifest({
    dependencies: {
      "with-password": "git+https://user:MARKER_PW@github.com/acme/a.git",
      "with-token": "https://MARKER_PAT@github.com/acme/b.git",
      "over-ssh": "git+ssh://git@github.com/acme/c.git",
      registry: "^18.2.0",
    },
  });
  assert.doesNotMatch(JSON.stringify(projected), /MARKER_PW|MARKER_PAT/);
  assert.equal(
    projected.dependencies["with-password"],
    "git+https://REDACTED@github.com/acme/a.git",
  );
  assert.equal(
    projected.dependencies["with-token"],
    "https://REDACTED@github.com/acme/b.git",
  );
  // any userinfo goes, including a bare `git@`: telling a user name from a
  // credential is the judgement that does not converge, and the host and path
  // are what an upgrade needs
  assert.equal(
    projected.dependencies["over-ssh"],
    "git+ssh://REDACTED@github.com/acme/c.git",
  );
  assert.equal(projected.dependencies.registry, "^18.2.0");
});

test("a credential outside userinfo is removed with the query", () => {
  const projected = projectManifest({
    dependencies: {
      query: "https://packages.example/app.tgz?token=MARKER_QUERY",
      ref: "git+https://github.com/a/b.git#v1.2.3",
      unparseable: "https://[not a url",
    },
  });
  assert.doesNotMatch(JSON.stringify(projected), /MARKER_QUERY/);
  assert.equal(
    projected.dependencies.query,
    "https://packages.example/app.tgz?REDACTED",
  );
  // a git ref is the fragment, and an upgrade needs to see it
  assert.equal(
    projected.dependencies.ref,
    "git+https://github.com/a/b.git#v1.2.3",
  );
  // nothing the platform parser refuses is taken apart by guesswork
  assert.equal(projected.dependencies.unparseable, "[REDACTED URL]");
});

// Every URL shape a review round has produced, each carrying a marker in the
// position that shape puts a credential in. A new counterexample belongs here
// rather than in another pattern.
test("no URL shape a review has produced reaches the output", () => {
  const cases = [
    [
      "git+ssh://git@github.com:owner/repo.git#ref",
      "git+ssh://REDACTED@github.com/owner/repo.git#ref",
    ],
    [
      "git+ssh://u:MARKER@github.com:owner/repo.git",
      "git+ssh://REDACTED@github.com/owner/repo.git",
    ],
    [
      "git+ssh://MARKER@github.com:owner/repo.git",
      "git+ssh://REDACTED@github.com/owner/repo.git",
    ],
    [
      "git+ssh://github.com:owner/repo.git",
      "git+ssh://github.com/owner/repo.git",
    ],
    [
      "git+ssh://git@github.com:22/owner/repo.git",
      "git+ssh://REDACTED@github.com:22/owner/repo.git",
    ],
    [
      "https://u:MARKER@registry.internal:4873/a.tgz",
      "https://REDACTED@registry.internal:4873/a.tgz",
    ],
    [
      "https://packages.example/a.tgz?token=MARKER",
      "https://packages.example/a.tgz?REDACTED",
    ],
    ["https://github.com/a/b.git#v1", "https://github.com/a/b.git#v1"],
    ["https://[not a url", "[REDACTED URL]"],
  ];
  for (const [input, expected] of cases) {
    const out = projectManifest({ dependencies: { a: input } }).dependencies.a;
    assert.equal(out, expected, input);
    assert.doesNotMatch(out, /MARKER/, input);
  }
});

test("redaction reaches a nested field and leaves other types alone", () => {
  const projected = projectManifest({
    pnpm: {
      overrides: { a: "https://MARKER_NESTED@example.com/a.tgz" },
      list: ["https://u:MARKER_LIST@example.com/b.tgz"],
      enabled: true,
      count: 3,
    },
  });
  assert.doesNotMatch(JSON.stringify(projected), /MARKER_NESTED|MARKER_LIST/);
  assert.equal(projected.pnpm.enabled, true);
  assert.equal(projected.pnpm.count, 3);
});

test("CLI requires exactly one mode", async () => {
  const both = spawnSync(
    process.execPath,
    [SCRIPT, "--manifest", "a", "--app-dir", "b"],
    { encoding: "utf8" },
  );
  assert.equal(both.status, 1);
  assert.match(both.stderr, /exactly one of/);

  const neither = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(neither.status, 1);
  assert.match(neither.stderr, /exactly one of/);
});

// The documented commands pass "$MANIFEST_PATH" and "$APP_DIR" quoted, so an
// unset variable arrives as an empty argument rather than as no argument.
test("CLI rejects an empty mode value", () => {
  const cases = [
    ["--manifest", ""],
    ["--app-dir", ""],
    // an empty value must not be discarded so the other flag looks like the one
    // supplied mode: both were exiting 0 before this was separated out
    ["--manifest", "", "--app-dir", "/tmp"],
    ["--manifest", "/tmp/nope", "--app-dir", ""],
  ];
  for (const args of cases) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1, `${args.join(" ")}: ${result.stdout}`);
    assert.match(result.stderr, /non-empty value/);
  }
});

test("CLI runs when invoked through a symlinked skill directory", async () => {
  const dir = await fixture();
  const linkPath = join(dir, "rn-upgrade-pulse.mjs");
  await symlink(SCRIPT, linkPath);
  try {
    const result = spawnSync(process.execPath, [linkPath, "--help"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /read-only manifest and installed-version evidence/,
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("importing with a nonexistent argv[1] does not throw", () => {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `process.argv[1] = "/nonexistent"; import(${JSON.stringify(new URL("./rn-upgrade-pulse.mjs", import.meta.url).href)}).then(() => console.log("ok"))`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ok/);
});

test("an existing but unreadable manifest is not reported as missing", async () => {
  const dir = await fixture();
  // a directory in place of the file gives EISDIR: present, but not readable
  const path = join(dir, "package.json");
  await mkdir(path);
  try {
    const result = readManifest(path);
    assert.equal(result.status, "unreadable");
    assert.equal(result.reason, "EISDIR");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("a manifest without a usable version is not reported as resolved", async () => {
  const dir = await fixture();
  const pkgDir = join(dir, "node_modules", "react-native");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "react-native" }),
  );
  try {
    const byName = Object.fromEntries(
      resolveInstalled(dir).map((entry) => [entry.name, entry]),
    );
    assert.equal(byName["react-native"].status, "unreadable");
    assert.equal(byName["react-native"].reason, "NO_VERSION_FIELD");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

for (const [label, body] of [
  ["null", "null"],
  ["an array", '["react-native"]'],
  ["a string", '"react-native"'],
  ["a number", "42"],
]) {
  test(`a manifest whose top level is ${label} is not reported as read`, async () => {
    const dir = await fixture();
    const path = join(dir, "package.json");
    await writeFile(path, body);
    try {
      const result = readManifest(path);
      assert.equal(result.status, "unparseable");
      assert.equal(result.reason, "NOT_AN_OBJECT");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
}

// A workspace hoists a sibling's dependency to a shared node_modules, where the
// app's own resolution finds it. The app manifest is the evidence that separates
// the app's dependency from the sibling's.
async function workspaceFixture({ appManifest }) {
  const root = await fixture();
  const appDir = join(root, "apps", "bare");
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, "package.json"), JSON.stringify(appManifest));
  for (const [where, name, version] of [
    [appDir, "react-native", "0.79.0"],
    [root, "expo", "54.0.0"],
  ]) {
    const pkgDir = join(where, "node_modules", name);
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name, version }),
    );
  }
  return { root, appDir };
}

test("a hoisted package the app does not declare is not reported as resolved", async () => {
  const { root, appDir } = await workspaceFixture({
    appManifest: { name: "bare", dependencies: { "react-native": "0.79.0" } },
  });
  try {
    const byName = Object.fromEntries(
      resolveInstalled(appDir).map((entry) => [entry.name, entry]),
    );
    assert.equal(byName["react-native"].status, "resolved");
    assert.equal(byName["react-native"].declaredIn, "dependencies");
    assert.equal(byName["react-native"].declaredRange, "0.79.0");

    assert.equal(byName.expo.status, "undeclared");
    // the version is still evidence: the report names what was found and where
    assert.equal(byName.expo.version, "54.0.0");
    assert.ok(byName.expo.manifestPath.includes("expo"));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("an unreadable package manifest still reports the declaration", async () => {
  const dir = await fixture();
  const pkgDir = join(dir, "node_modules", "react-native");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "rn" }));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "app", dependencies: { "react-native": "0.79.0" } }),
  );
  try {
    const byName = Object.fromEntries(
      resolveInstalled(dir).map((entry) => [entry.name, entry]),
    );
    // a corrupt install of a declared dependency is not an undeclared package
    assert.equal(byName["react-native"].status, "unreadable");
    assert.equal(byName["react-native"].reason, "NO_VERSION_FIELD");
    assert.equal(byName["react-native"].declaredIn, "dependencies");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("an unresolved package still reports whether the app declares it", async () => {
  const dir = await fixture();
  const pkgDir = join(dir, "node_modules", "react-native");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "react-native", version: "0.79.0" }),
  );
  // expo is declared but absent: an incomplete install, not a bare app
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "app",
      dependencies: { "react-native": "0.79.0", expo: "~54.0.0" },
    }),
  );
  try {
    const byName = Object.fromEntries(
      resolveInstalled(dir).map((entry) => [entry.name, entry]),
    );
    assert.equal(byName.expo.status, "unavailable");
    assert.equal(byName.expo.reason, "MODULE_NOT_FOUND");
    assert.equal(byName.expo.declaredIn, "dependencies");
    // react is neither installed nor declared: the same code, different meaning
    assert.equal(byName.react.status, "unavailable");
    assert.equal(byName.react.declaredIn, undefined);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("a devDependencies entry counts but a peer-only one does not", async () => {
  const { root, appDir } = await workspaceFixture({
    appManifest: {
      name: "lib",
      devDependencies: { "react-native": "0.79.0" },
      peerDependencies: { expo: ">=53" },
    },
  });
  try {
    const byName = Object.fromEntries(
      resolveInstalled(appDir).map((entry) => [entry.name, entry]),
    );
    assert.equal(byName["react-native"].declaredIn, "devDependencies");
    // a peer entry states compatibility, never that this package installed the
    // copy that was found — here the copy is the workspace root's
    assert.equal(byName.expo.status, "undeclared");
    assert.equal(byName.expo.declaredIn, undefined);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a declared range of the wrong shape is not an absent declaration", async () => {
  const { root, appDir } = await workspaceFixture({
    appManifest: {
      name: "app",
      dependencies: { "react-native": { version: "0.79.0" } },
    },
  });
  try {
    const byName = Object.fromEntries(
      resolveInstalled(appDir).map((entry) => [entry.name, entry]),
    );
    assert.equal(byName["react-native"].declaredIn, "dependencies");
    assert.equal(byName["react-native"].declaredRange, null);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("an aliased install reports the name the manifest carries", async () => {
  const dir = await fixture();
  const pkgDir = join(dir, "node_modules", "react-native");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "react-native-tvos", version: "0.79.0-0" }),
  );
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "tvapp",
      dependencies: { "react-native": "npm:react-native-tvos@0.79.0-0" },
    }),
  );
  try {
    const byName = Object.fromEntries(
      resolveInstalled(dir).map((entry) => [entry.name, entry]),
    );
    assert.equal(byName["react-native"].status, "resolved");
    assert.equal(byName["react-native"].resolvedName, "react-native-tvos");
    // the requested name stays the key so a reader can still find the entry
    assert.equal(byName["react-native"].name, "react-native");
    // a package that did not resolve carries no resolvedName at all
    assert.equal(byName.react.status, "unavailable");
    assert.equal(byName.react.resolvedName, undefined);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("an alias is reported even when the app does not declare it", async () => {
  const dir = await fixture();
  const pkgDir = join(dir, "node_modules", "react-native");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "react-native-tvos", version: "0.79.0-0" }),
  );
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app" }));
  try {
    const byName = Object.fromEntries(
      resolveInstalled(dir).map((entry) => [entry.name, entry]),
    );
    assert.equal(byName["react-native"].status, "undeclared");
    assert.equal(byName["react-native"].resolvedName, "react-native-tvos");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("a whitespace-only version is not a usable version", async () => {
  const dir = await fixture();
  const pkgDir = join(dir, "node_modules", "react-native");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "react-native", version: "   " }),
  );
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "app", dependencies: { "react-native": "0.79.0" } }),
  );
  try {
    const byName = Object.fromEntries(
      resolveInstalled(dir).map((entry) => [entry.name, entry]),
    );
    assert.equal(byName["react-native"].status, "unreadable");
    assert.equal(byName["react-native"].reason, "NO_VERSION_FIELD");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("an unreadable app manifest leaves the declaration unverified", async () => {
  const root = await fixture();
  const appDir = join(root, "apps", "bare");
  const pkgDir = join(appDir, "node_modules", "react-native");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "react-native", version: "0.79.0" }),
  );
  try {
    const byName = Object.fromEntries(
      resolveInstalled(appDir).map((entry) => [entry.name, entry]),
    );
    // absent is not the same as "declares nothing": nothing was checked
    assert.equal(byName["react-native"].status, "unverified");
    assert.equal(byName["react-native"].version, "0.79.0");
    assert.equal(byName["react-native"].reason, "missing");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

// An app manifest that is invalid JSON, or valid JSON that is not an object,
// makes Node's own resolver throw ERR_INVALID_PACKAGE_CONFIG before anything
// resolves, so those shapes arrive as `unavailable`. A directory in place of the
// file is the reachable way to resolve a package and still fail to read the
// declaration, which is what this covers.
test("an app manifest that exists but cannot be read reports its status", async () => {
  const root = await fixture();
  const appDir = join(root, "apps", "bare");
  const pkgDir = join(appDir, "node_modules", "react-native");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "react-native", version: "0.79.0" }),
  );
  await mkdir(join(appDir, "package.json"));
  try {
    const byName = Object.fromEntries(
      resolveInstalled(appDir).map((entry) => [entry.name, entry]),
    );
    assert.equal(byName["react-native"].status, "unverified");
    // a bounded token, never the manifest's errno or a parser message
    assert.equal(byName["react-native"].reason, "unreadable");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
