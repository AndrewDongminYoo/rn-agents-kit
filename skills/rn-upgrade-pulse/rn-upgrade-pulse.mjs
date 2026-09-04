#!/usr/bin/env node
// rn-upgrade-pulse.mjs — read-only manifest projection and installed-version resolution.
//
//   --manifest <path>   print the upgrade-relevant fields of one package.json
//   --app-dir <dir>     resolve react, react-native and expo from that app root
//   --help, -h
//
// Both modes print JSON on stdout and never write to the project.
// A missing or unparseable input is reported as a status, not an error exit,
// so a reader can count it as a skipped input with its reason.
import { readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import {
  NODE_LINKERS,
  YARN_LOCK_GENERATIONS,
  readYarnLockfile,
  readYarnrc,
} from "./adapters.mjs";

// The fields an upgrade assessment reads. `overrides`, `resolutions` and `pnpm`
// carry the constraints a lockfile cannot show. `scripts` is projected by name
// only; every other field has its URL credentials redacted before it is printed.
const MANIFEST_FIELDS = [
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
];

const PACKAGES = ["react", "react-native", "expo"];

const YARN_CONFIG = ".yarnrc.yml";
const PNP_LOADERS = [".pnp.cjs", ".pnp.js"];
// Yarn reads the nearest configuration at or above the app, so the search runs
// nearest-first and stops at the filesystem root — a user-level `~/.yarnrc.yml`
// governs an install the same way a repository one does.
function* ancestors(from) {
  let dir = from;
  for (;;) {
    yield dir;
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

// Three outcomes, not two: a file that exists and cannot be read is evidence
// that something is there, which "absent" would throw away.
function readIfFile(path) {
  try {
    return { raw: readFileSync(path, "utf8"), unreadable: false };
  } catch (error) {
    return { raw: null, unreadable: error?.code !== "ENOENT" };
  }
}

// The install-mode evidence, gathered but not judged. Which of these facts makes
// a resolution trustworthy is the skill's call, not this helper's: every attempt
// to decide it here grew another branch for another environment.
//
// Nothing here is a path. The four this used to emit were read by the skill as
// presence tests and by nothing else, and a directory name carries a credential
// as readily as a file's contents do — which is the rule `evidence.mjs` has kept
// from the start and this helper had not. What is lost with them is which file
// declared the linker; `Read a Yarn linker` answers that per file when the
// report needs it, and `SKILL.md` records the loss under Not Examined.
//
// Each presence field has three values, because `readIfFile` has three
// outcomes. A file that exists and cannot be read is not an absence, and a
// field named `absent` would say that it is — which the paths it replaced did
// not, a null path being a missing answer rather than a wrong one. `ambiguous`
// still rises with it; that says the walk is uncertain, not which input made it
// so.
//
// Nothing here reads a file's syntax either. Both formats are read by the
// adapters that own them, so a `.yarnrc.yml` is parsed rather than matched, and
// a `yarn.lock`'s generation is decided by the one detector that knows the two
// stamps. What is left is the walk itself: which directories, which files exist
// in them, and how the answers combine.
export function detectInstallMode(appDir) {
  let linker = null;
  // The nearest file that declares the key at all, readable or not. Yarn's
  // nearest declaration wins whatever it says, so an ancestor's value must not
  // stand in for one this reader could not interpret.
  let declared = false;
  let yarnConfig = "absent";
  let loader = "absent";
  let yarnLock = "absent";
  let yarnLockGeneration = null;
  // Anything unreadable, and any declaration this cannot resolve to one of
  // Yarn's linkers or one of the two lockfile generations, sets this — so an
  // unanticipated value reads as "cannot tell" rather than as an absence.
  let ambiguous = false;
  for (const dir of ancestors(resolve(appDir))) {
    if (yarnLock !== "present") {
      const lock = readIfFile(join(dir, "yarn.lock"));
      if (lock.raw !== null) {
        yarnLock = "present";
        const generation = readYarnLockfile(lock.raw).fields?.generation;
        if (YARN_LOCK_GENERATIONS.has(generation))
          yarnLockGeneration = generation;
        else ambiguous = true;
      }
      if (lock.unreadable) {
        yarnLock = "unreadable";
        ambiguous = true;
      }
    }
    const config = readIfFile(join(dir, YARN_CONFIG));
    if (config.unreadable) {
      if (yarnConfig === "absent") yarnConfig = "unreadable";
      ambiguous = true;
    }
    if (config.raw !== null) {
      yarnConfig = "present";
      // Yarn merges ancestor configuration, so a file that declares nothing
      // does not end the search — keep climbing for the nearest declaration.
      if (!declared) {
        let value;
        try {
          value = readYarnrc(config.raw).fields?.declaredLinker;
        } catch {
          // The reader refuses a document it did not read whole, and a file
          // Yarn's own reader would refuse is a declaration this cannot see
          // past rather than one to climb over.
          declared = true;
          ambiguous = true;
        }
        if (value !== undefined) {
          declared = true;
          if (NODE_LINKERS.has(value)) linker = value;
          else ambiguous = true;
        }
      }
    }
    if (loader !== "present") {
      for (const name of PNP_LOADERS) {
        const found = readIfFile(join(dir, name));
        if (found.raw !== null) {
          loader = "present";
          break;
        }
        if (found.unreadable) {
          loader = "unreadable";
          ambiguous = true;
        }
      }
    }
  }
  return {
    linker,
    yarnConfig,
    loader,
    yarnLock,
    yarnLockGeneration,
    ambiguous,
  };
}

// The manifest fields that make a package this app's own dependency, in the
// order npm resolves them: an optionalDependencies entry overrides one of the
// same name in dependencies, so it is read first. `peerDependencies` is absent
// on purpose — it states a compatibility requirement, never that this package
// installed the copy that was found, so a peer-only entry would promote a
// neighbour's install to the app's own.
const DECLARATION_FIELDS = [
  "optionalDependencies",
  "dependencies",
  "devDependencies",
];

function findDeclaration(fields, name) {
  for (const field of DECLARATION_FIELDS) {
    const declarations = fields[field];
    if (declarations == null || !Object.hasOwn(declarations, name)) continue;
    const range = declarations[name];
    // A key that is present with an unusable value still declares the package.
    return {
      declaredIn: field,
      declaredRange: typeof range === "string" ? range : null,
    };
  }
  return null;
}

// A URL's userinfo carries a credential whenever the scheme is http or https,
// because an npm or git token is written exactly there, and whenever any scheme
// carries a password component. An ssh URL's bare `git@` is a user name, so it
// is left alone. A dependency specifier is projected, so an unredacted one would
// print a token the same way an unredacted command line would.
function redactUrlCredentials(value) {
  if (!value.includes("://")) return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    // npm accepts git's scp-like form, `host:path`, which the WHATWG parser
    // reads as a port and refuses. The separator is a colon followed by
    // something that is not a port, so replacing that one character with `/`
    // makes the same reference parseable. This is a documented git form, not a
    // guess about the value's shape.
    // The separator sits after the userinfo and after the host. Anchoring it
    // anywhere earlier finds the password colon instead, which rewrites the
    // credential into the path and leaves it in the output.
    const scp = /^([a-z+.-]+:\/\/(?:[^/@]*@)?[^/:@]+):(?![0-9]+(?:[/#?]|$))/i;
    if (!scp.test(value)) return "[REDACTED URL]";
    try {
      url = new URL(value.replace(scp, "$1/"));
    } catch {
      return "[REDACTED URL]";
    }
  }
  if (url.username !== "" || url.password !== "") {
    url.username = "REDACTED";
    url.password = "";
  }
  // A query carries a credential as readily as userinfo does — a private
  // tarball is fetched with `?token=`. Which parameter is the credential is a
  // judgement, and judging it is the thing that does not converge, so the whole
  // query goes. The fragment stays: for a git specifier it is the ref, which is
  // what an upgrade needs to see.
  if (url.search !== "") url.search = "?REDACTED";
  return url.href;
}

function redactDeep(value) {
  if (typeof value === "string") return redactUrlCredentials(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactDeep(entry)]),
    );
  }
  return value;
}

// `expo` holds whatever a project puts in it, and `expo.extra` is where an Expo
// project is documented to keep an API key. A projection cannot bound a value
// whose shape it does not know, so this field projects to its key names, like
// `scripts`: what the app configures stays visible, what it configures it with
// is not read here. The values come back from a redacted copy of the manifest
// itself, read whole like any other file — `app.json` does not carry the
// package-level Expo settings such as `autolinking` and `doctor`.
//
// `pnpm` is not in this set. It is a schema the package manager owns, with no
// credential field in it, and an Evidence Rule needs its override configuration
// by value.
const FREE_FORM_FIELDS = new Set(["scripts", "expo"]);

// `scripts` projects to its key names alone. The assessment needs which gates a
// project declares, not how they run, and a release script writes a token inline
// as readily as a CI file does. A command line is read from a redacted copy.
// A `scripts` value that is not a plain object declares no names, so it projects
// to null rather than to the index keys of whatever it is.
function fieldNames(scripts) {
  return scripts !== null &&
    typeof scripts === "object" &&
    !Array.isArray(scripts)
    ? Object.keys(scripts)
    : null;
}

export function projectManifest(manifest) {
  return Object.fromEntries(
    MANIFEST_FIELDS.filter((field) => manifest[field] !== undefined).map(
      (field) => [
        field,
        FREE_FORM_FIELDS.has(field)
          ? fieldNames(manifest[field])
          : redactDeep(manifest[field]),
      ],
    ),
  );
}

// Node's own module reader accepts a manifest that opens with a UTF-8 BOM, so
// JSON.parse refusing one would drop an otherwise usable input.
function withoutBom(raw) {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

export function readManifest(manifestPath) {
  const path = resolve(manifestPath);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = error?.code ?? "UNKNOWN";
    // Only ENOENT means the file is absent; a permission or directory error is
    // an input that exists and could not be read, which is a different gap.
    return {
      path,
      status: code === "ENOENT" ? "missing" : "unreadable",
      reason: code,
    };
  }
  try {
    const parsed = JSON.parse(withoutBom(raw));
    // A top level that is not a plain object projects to {}, which would be
    // reported as a manifest that was read and simply declares nothing.
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return { path, status: "unparseable", reason: "NOT_AN_OBJECT" };
    }
    return { path, status: "read", fields: projectManifest(parsed) };
  } catch (error) {
    return {
      path,
      status: "unparseable",
      reason: error?.message ?? "invalid JSON",
    };
  }
}

// Each package is reported as one of five states: `resolved` (found, and the app
// declares it), `undeclared` (found, but this app's manifest does not list it),
// `unverified` (found, and the app manifest could not be read to check),
// `unavailable` (no resolution), or `unreadable` (a manifest that resolved but
// carries no usable version). The error code is reported rather than collapsed
// into one token, because it separates a resolution failure from an exports-map
// refusal. It does not say why a resolution failed: an undeclared dependency and
// an uninstalled tree both give MODULE_NOT_FOUND, and only the pattern across the
// three packages, read against the manifests, separates those.
export function resolveInstalled(appDir) {
  const base = resolve(appDir);
  const req = createRequire(join(base, "noop.js"));
  // A resolution can come from outside this app: a workspace hoist, a peer npm
  // installed on its own, a transitive copy. Nothing here distinguishes those,
  // so the app manifest is the only evidence that the package is the app's own,
  // and a resolution is reported as `resolved` only when the app declares it.
  const appManifest = readManifest(join(base, "package.json"));
  return PACKAGES.map((name) => {
    const declaration =
      appManifest.status === "read"
        ? findDeclaration(appManifest.fields, name)
        : null;
    let manifestPath;
    try {
      manifestPath = req.resolve(`${name}/package.json`, { paths: [base] });
    } catch (error) {
      // The declaration travels with a failure too: a package the app never
      // declared and one whose install is incomplete share an error code.
      return {
        name,
        status: "unavailable",
        reason: error?.code ?? "UNKNOWN",
        ...(declaration ?? {}),
      };
    }
    try {
      const { name: resolvedName, version } = JSON.parse(
        withoutBom(readFileSync(manifestPath, "utf8")),
      );
      // An alias (`"react-native": "npm:react-native-tvos@…"`) resolves under
      // the requested name while the manifest carries the real one. Every
      // branch below has read that manifest, so every one of them can say so.
      const alias = resolvedName !== name && { resolvedName };
      // A resolved status is read as carrying a version, so a manifest without
      // a usable one is a gap, not a resolution.
      if (typeof version !== "string" || version.trim().length === 0) {
        return {
          name,
          status: "unreadable",
          manifestPath,
          reason: "NO_VERSION_FIELD",
          ...alias,
          ...(declaration ?? {}),
        };
      }
      if (appManifest.status !== "read") {
        return {
          name,
          status: "unverified",
          version,
          manifestPath,
          // the manifest's own status, not its errno or parser message: this
          // field answers why the declaration could not be checked, and step 5
          // reports the app manifest itself with its full reason
          reason: appManifest.status,
          ...alias,
        };
      }
      if (declaration === null) {
        return {
          name,
          status: "undeclared",
          version,
          manifestPath,
          ...alias,
        };
      }
      return {
        name,
        status: "resolved",
        version,
        manifestPath,
        ...alias,
        ...declaration,
      };
    } catch (error) {
      return {
        name,
        status: "unreadable",
        manifestPath,
        reason: error?.code ?? error?.message ?? "UNKNOWN",
        ...(declaration ?? {}),
      };
    }
  });
}

function printUsage() {
  process.stdout.write(
    [
      "rn-upgrade-pulse.mjs — read-only manifest and installed-version evidence",
      "",
      "  --manifest <path>   print the upgrade-relevant fields of one package.json",
      "  --app-dir <dir>     resolve react, react-native and expo from that app root",
      "  --help,-h",
      "",
      "Exactly one mode per run. Output is JSON on stdout.",
      "",
    ].join("\n"),
  );
}

export async function main(argv = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        // `multiple` so a repeated flag arrives as two values rather than
        // silently keeping the last one and passing the one-mode check
        manifest: { type: "string", multiple: true },
        "app-dir": { type: "string", multiple: true },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    process.stderr.write(`[rn-upgrade-pulse] ${error.message}\n`);
    return 1;
  }
  if (values.help) {
    printUsage();
    return 0;
  }
  // Presence and emptiness are separate checks. Filtering the empties out first
  // would let `--manifest "" --app-dir /tmp` through as a single supplied mode,
  // and an unset shell variable is exactly how that empty argument arrives.
  const manifestValues = values.manifest ?? [];
  const appDirValues = values["app-dir"] ?? [];
  const supplied = [...manifestValues, ...appDirValues];
  if (supplied.length !== 1 || supplied[0] === "") {
    process.stderr.write(
      "[rn-upgrade-pulse] pass exactly one of --manifest or --app-dir, with a non-empty value\n",
    );
    return 1;
  }
  const appDir = appDirValues[0];
  const result =
    manifestValues.length === 1
      ? readManifest(manifestValues[0])
      : {
          appDir: resolve(appDir),
          // Without this the caller cannot tell an app with none of the three
          // installed from one whose own manifest could not be read: an
          // unparseable manifest makes Node refuse every resolution.
          appManifest: (({ status, reason }) => ({ status, reason }))(
            readManifest(join(resolve(appDir), "package.json")),
          ),
          installMode: detectInstallMode(appDir),
          packages: resolveInstalled(appDir),
        };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

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
