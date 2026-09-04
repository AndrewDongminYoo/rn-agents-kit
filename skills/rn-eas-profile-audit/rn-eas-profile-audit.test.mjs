import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveBuildProfile } from "./rn-eas-profile-audit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "rn-eas-profile-audit.mjs");

const CONFIG = {
  build: {
    base: {
      distribution: "internal",
      env: { SHARED: "base", OVERRIDE: "base" },
      cache: { key: "base", disabled: false },
      ios: { resourceClass: "medium", simulator: false },
      android: {
        buildType: "app-bundle",
        resourceClass: "medium",
        env: { SHARED: "base", OVERRIDE: "base" },
      },
    },
    simulator: {
      extends: "base",
      env: { OVERRIDE: "child" },
      cache: { key: "child" },
      ios: { simulator: true },
      android: { buildType: "apk", env: { OVERRIDE: "child" } },
    },
  },
};

test("resolves a profile chain and merges nested platform settings", () => {
  assert.deepEqual(resolveBuildProfile(CONFIG, "simulator"), {
    profile: "simulator",
    chain: ["base", "simulator"],
    effective: {
      distribution: "internal",
      env: { SHARED: "base", OVERRIDE: "child" },
      cache: { key: "child" },
      ios: { resourceClass: "medium", simulator: true },
      android: {
        buildType: "apk",
        resourceClass: "medium",
        env: { SHARED: "base", OVERRIDE: "child" },
      },
    },
  });
});

test("validates inherited profile references", () => {
  assert.deepEqual(
    resolveBuildProfile(
      { build: { preview: { extends: "", distribution: "internal" } } },
      "preview",
    ).effective,
    { distribution: "internal" },
  );
  for (const extendsValue of [false, null, 0]) {
    assert.throws(
      () =>
        resolveBuildProfile(
          { build: { preview: { extends: extendsValue } } },
          "preview",
        ),
      /invalid "extends" value/,
    );
  }
  assert.throws(
    () =>
      resolveBuildProfile(
        { build: { child: { extends: "missing" } } },
        "child",
      ),
    /Profile "missing" was not found/,
  );
  assert.throws(
    () =>
      resolveBuildProfile(
        { build: { alpha: { extends: "beta" }, beta: { extends: "alpha" } } },
        "alpha",
      ),
    /cycle: alpha -> beta -> alpha/,
  );
});

test("accepts four extends hops and rejects a fifth", () => {
  const five = {
    build: {
      a: {},
      b: { extends: "a" },
      c: { extends: "b" },
      d: { extends: "c" },
      e: { extends: "d" },
    },
  };
  assert.deepEqual(resolveBuildProfile(five, "e").chain, [
    "a",
    "b",
    "c",
    "d",
    "e",
  ]);
  assert.throws(
    () =>
      resolveBuildProfile(
        {
          build: {
            ...five.build,
            f: { extends: "e" },
          },
        },
        "f",
      ),
    /maximum depth of 5/,
  );
});

test("CLI prints the resolved profile as JSON", async () => {
  const fixtureDir = await mkdtemp(join(tmpdir(), "rn-eas-profile-audit-"));
  const configPath = join(fixtureDir, "eas.json");
  await writeFile(configPath, JSON.stringify(CONFIG));
  try {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "--config", configPath, "--profile", "simulator"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(result.stdout),
      resolveBuildProfile(CONFIG, "simulator"),
    );
  } finally {
    await rm(fixtureDir, { force: true, recursive: true });
  }
});

test("CLI names strict JSON as a deliberate boundary", async () => {
  const fixtureDir = await mkdtemp(join(tmpdir(), "rn-eas-profile-audit-"));
  const configPath = join(fixtureDir, "eas.json");
  await writeFile(configPath, '{ "build": { "preview": {}, }, }');
  try {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "--config", configPath, "--profile", "preview"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /strict JSON only/);
  } finally {
    await rm(fixtureDir, { force: true, recursive: true });
  }
});

test("CLI runs when invoked through a symlinked skill directory", async () => {
  const fixtureDir = await mkdtemp(join(tmpdir(), "rn-eas-profile-audit-"));
  const configPath = join(fixtureDir, "eas.json");
  const linkPath = join(fixtureDir, "rn-eas-profile-audit.mjs");
  await writeFile(configPath, JSON.stringify(CONFIG));
  await symlink(SCRIPT, linkPath);
  try {
    const result = spawnSync(
      process.execPath,
      [linkPath, "--config", configPath, "--profile", "simulator"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(result.stdout),
      resolveBuildProfile(CONFIG, "simulator"),
    );
  } finally {
    await rm(fixtureDir, { force: true, recursive: true });
  }
});

test("importing with a nonexistent argv[1] does not throw", () => {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `process.argv[1] = "/nonexistent"; import(${JSON.stringify(pathToFileURL(SCRIPT).href)}).then(() => console.log("ok"))`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ok/);
});
