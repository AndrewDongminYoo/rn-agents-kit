#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const MAX_PROFILE_DEPTH = 5;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function copy(value) {
  if (Array.isArray(value)) return value.map(copy);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, copy(item)]),
  );
}

function mergeProfiles(base, update) {
  const result = { ...copy(base), ...copy(update) };
  if (isRecord(base.env) && isRecord(update.env)) {
    result.env = { ...copy(base.env), ...copy(update.env) };
  }
  if (isRecord(base.android) && isRecord(update.android)) {
    result.android = mergeProfiles(base.android, update.android);
  }
  if (isRecord(base.ios) && isRecord(update.ios)) {
    result.ios = mergeProfiles(base.ios, update.ios);
  }
  return result;
}

function withoutExtends(profile) {
  const ownValues = copy(profile);
  delete ownValues.extends;
  return ownValues;
}

function profilesFrom(config) {
  if (!isRecord(config))
    throw new Error("eas.json must contain a JSON object.");
  if (!isRecord(config.build)) {
    throw new Error('eas.json must contain a "build" object.');
  }
  return config.build;
}

function profileFrom(profiles, name) {
  if (!Object.hasOwn(profiles, name)) {
    throw new Error(`Profile "${name}" was not found under "build".`);
  }
  if (!isRecord(profiles[name])) {
    throw new Error(`Profile "${name}" must be an object.`);
  }
  return profiles[name];
}

export function resolveBuildProfile(config, profileName) {
  if (typeof profileName !== "string" || !profileName.trim()) {
    throw new Error("A non-empty profile name is required.");
  }
  const profiles = profilesFrom(config);

  function resolveProfile(name, stack = [], depth = 0) {
    if (depth >= MAX_PROFILE_DEPTH) {
      throw new Error(
        `EAS profile chain exceeds maximum depth of ${MAX_PROFILE_DEPTH}.`,
      );
    }
    if (stack.includes(name)) {
      throw new Error(
        `EAS profile extends cycle: ${[...stack, name].join(" -> ")}.`,
      );
    }
    const profile = profileFrom(profiles, name);
    const parentName = profile.extends;
    let parent = { chain: [], effective: {} };

    if (parentName !== undefined && typeof parentName !== "string") {
      throw new Error(`Profile "${name}" has an invalid "extends" value.`);
    }
    if (parentName) {
      parent = resolveProfile(parentName, [...stack, name], depth + 1);
    }

    const ownValues = withoutExtends(profile);
    return {
      chain: [...parent.chain, name],
      effective: mergeProfiles(parent.effective, ownValues),
    };
  }

  const { chain, effective } = resolveProfile(profileName);
  return { profile: profileName, chain, effective };
}

function printUsage() {
  process.stdout.write(
    [
      "rn-eas-profile-audit.mjs — resolve one eas.json build profile",
      "",
      "  --config,  -c <path>    eas.json path",
      "  --profile, -p <name>    build profile name",
      "  --help,    -h",
      "",
      "Writes JSON to stdout and diagnostics to stderr.",
      "This tool does not inspect a workflow or run a build.",
      "",
    ].join("\n"),
  );
}

export async function main(args = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        config: { type: "string", short: "c" },
        profile: { type: "string", short: "p" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    }));
  } catch (error) {
    process.stderr.write(`[rn-eas-profile-audit] ${error.message}\n`);
    return 2;
  }

  if (values.help) {
    printUsage();
    return 0;
  }
  if (!values.config || !values.profile) {
    process.stderr.write(
      "[rn-eas-profile-audit] --config and --profile are required.\n",
    );
    return 2;
  }

  try {
    const text = await readFile(values.config, "utf8");
    let config;
    try {
      config = JSON.parse(text);
    } catch {
      throw new Error(
        "This helper accepts strict JSON only. Use EAS CLI for eas.json files that use JSON5 syntax.",
      );
    }
    const result = resolveBuildProfile(config, values.profile);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`[rn-eas-profile-audit] ${error.message}\n`);
    return 1;
  }
}

// A symlinked skill directory leaves argv[1] on the link while import.meta.url
// resolves to the real file, so both sides are canonicalized before comparison.
function invokedDirectly() {
  try {
    return (
      Boolean(process.argv[1]) &&
      realpathSync(process.argv[1]) ===
        realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    // argv[1] can name a path that does not exist; that is not direct execution.
    return false;
  }
}

if (invokedDirectly()) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
