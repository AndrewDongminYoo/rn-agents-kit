#!/usr/bin/env node
// evidence.mjs — the evidence CLI.
//
//   --read <path>       emit typed evidence for one project file
//   --app-dir <dir>     the selected app root, for a file describing several
//   --help, -h
//
// This file is the only place that reads project-owned content, and it prints
// nothing that it read. An adapter returns candidate values; this file decides
// what reaches stdout, and it emits a field only when that field is named in
// the adapter's schema and the field's declared type accepts the whole
// candidate. A value with no field, and a field whose value does not validate,
// have no path out — so the guarantee does not depend on recognising any
// credential's name, and widening a pattern cannot open one.
//
// The result is JSON on stdout. A file that is absent, unreadable or of a kind
// no adapter claims is reported as a status rather than as an error exit, so a
// reader can count it as an unread input with its reason. Exit code 1 is for a
// usage error alone.
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  ADAPTERS,
  NODE_LINKERS,
  PNPM_LOCKFILE_VERSIONS,
  YARN_LOCK_GENERATIONS,
} from "./adapters.mjs";

// A file larger than this is refused unread, unless its adapter declares a
// larger bound. Most inputs here are configuration files, and an unbounded read
// of an arbitrary path is a promise this tool cannot keep on a repository it did
// not choose.
const MAX_BYTES = 8 * 1024 * 1024;
const NATIVE_PATH = { dirname, isAbsolute, relative, resolve };

// A Node version pin: a dotted release with an optional `v`, or one of the
// aliases a pin file may hold in place of a number.
//
// A prerelease tag is refused on purpose. Accepting one makes everything after
// the hyphen a free-form field, and both shapes a widening takes admit a
// credential there: a permissive tag class accepts
// `20.11.1-ghp_realLookingToken123`, and even a semver-correct one, which
// forbids the underscore, accepts `20.11.1-ghpRealLookingToken123`. Both are in
// the test, because the first alone passes against the second widening and
// would have made that test vacuous. A genuine prerelease pin therefore comes
// back `uncertain`, which is the direction this CLI fails in.
// The aliases are a closed set for the same reason. `lts/<codename>` read as a
// pattern makes the codename a free-form suffix, and `lts/secretpassword`
// satisfies any character class wide enough to hold `lts/hydrogen`. The
// codenames below are every one in nodejs/Release's `schedule.json`, which is
// where the next line comes from when an LTS lands; until it is added, that
// codename reads as `uncertain` rather than as a pin.
const NODE_RELEASE = /^v?\d{1,3}(?:\.\d{1,5}){0,2}$/;
const NODE_ALIASES = new Set([
  "latest",
  "lts",
  // nvm's built-in aliases, from the set its own `nvm_alias` writes
  // (nvm.sh:1374): the node prefix, stable, unstable, and the iojs prefix.
  "node",
  "stable",
  "unstable",
  "iojs",
  "system",
  "lts/*",
  "lts/argon",
  "lts/boron",
  "lts/carbon",
  "lts/dubnium",
  "lts/erbium",
  "lts/fermium",
  "lts/gallium",
  "lts/hydrogen",
  "lts/iron",
  "lts/jod",
  "lts/krypton",
]);

// A dependency range, as npm's own grammar writes one: comparator sets joined by
// `||`, each a hyphen range or space-separated comparators over partial
// versions. Numeric parts are length-capped so a long numeric blob cannot be
// echoed back as a version.
//
// A prerelease tag is refused here for the reason it is refused above, and the
// cost is stated rather than traded away: a project on `19.0.0-rc.1` or a React
// canary gets `rejected` for that field instead of a value. Allowing the tag in
// this type while refusing it in that one would be a per-field exception, which
// is the shape this boundary exists to remove. Build metadata is refused with
// it. When a migration step needs those projects to resolve, the answer is a
// type that emits the release triple and drops the tag, not a wider tag class.
// This grammar is a conservative subset of npm's, not a copy of it, and the
// difference is the stopping rule for the class of finding that keeps arriving
// against it: a shape outside the subset is reported as a rejected field, never
// as a wrong value, so a gap costs evidence and never safety. Every accepted
// shape is checked against node-semver's own `validRange`, which is the property
// that has to hold; a missing shape is added when a real manifest needs it
// rather than by widening the grammar toward a second implementation of it.
//
// A partial version, written as the seven shapes npm allows rather than as
// "components that may be numeric or a wildcard": once a wildcard appears, every
// later component is one too, so `1.x.2` is not a version and node-semver reads
// it as no range at all. Enumerating the shapes is what makes that unstateable
// rather than a rule to remember.
const NUM = String.raw`(?:0|[1-9]\d{0,8})`;
const WILD = String.raw`[xX*]`;
const OPERAND = String.raw`v?(?:${NUM}\.${NUM}\.${NUM}|${NUM}\.${NUM}\.${WILD}|${NUM}\.${WILD}\.${WILD}|${NUM}\.${NUM}|${NUM}\.${WILD}|${NUM}|${WILD})`;
// Whitespace inside a range is the same closed set the pin readers use, not a
// literal space: node-semver splits on any whitespace, so a tab between two
// comparators is a range it reads and this type would otherwise reject. An
// operator may also stand apart from its operand, and a hyphen range may be
// spaced out — `">= 18 < 21"` and `"1.2.3  -  2.0.0"` read the same as the
// adjacent forms.
const WS = String.raw`[ \t\n\v\f\r]`;
const COMPARATOR = String.raw`(?:[<>]=?|=|\^|~>?)?${WS}*${OPERAND}`;
// A hyphen range takes a bare partial at each end; an operator on either side
// makes it no range at all.
const HYPHEN = String.raw`${OPERAND}${WS}+-${WS}+${OPERAND}`;
const SET = String.raw`(?:${HYPHEN}|${COMPARATOR}(?:${WS}+${COMPARATOR})*)`;
const SEMVER_RANGE = new RegExp(
  `^${WS}*${SET}(?:${WS}*\\|\\|${WS}*${SET})*${WS}*$`,
);

// An Expo SDK version names one release rather than a constraint, so it is not
// the range type: `">=50"` under `sdkVersion` is a manifest that does not say
// which SDK it is on, and reporting it as one would be evidence the file does
// not carry.
const EXACT_VERSION = /^(?:0|[1-9]\d{0,8})(?:\.(?:0|[1-9]\d{0,8})){2}$/;
// A `packageManager` pin, kept as one field. Splitting it into a name and a
// version gave two fields the schema could not couple: an unrecognised name was
// rejected while its version was still emitted, which reads as a definite
// version of something unidentified. One field with a closed name set and an
// exact version is both simpler and honest.
// The `v` prefix is semver's own and corepack reads through it: `valid("v10.4.1")`
// is `10.4.1`, while `V10.4.1` is not a version at all.
const PACKAGE_MANAGER =
  /^(?:npm|yarn|pnpm|bun)@v?(?:0|[1-9]\d{0,8})(?:\.(?:0|[1-9]\d{0,8})){2}$/;

// A range is short. The cap is here rather than inside a type because it bounds
// every type at once, and because a nested quantifier over an unbounded string
// is how a range grammar turns into a stall. It is what bounds the grammar
// rather than a branch count: measured against adversarial hundred-character
// inputs, the worst of them takes under a millisecond, so a range with more
// alternatives than a hand-written limit anticipated is accepted rather than
// discarded.
const MAX_VALUE_LENGTH = 100;

// The closed set of types a schema may name. Each one accepts a whole value or
// refuses it, and none of them selects a substring out of its input: selecting
// safe substrings out of arbitrary project text by pattern is the operation
// that had no closed form, and it is absent here rather than narrowed.
const VALUE_TYPES = {
  "node-version": (value) =>
    NODE_RELEASE.test(value) || NODE_ALIASES.has(value),
  // Two range types, differing only in the dist-tag. npm resolves a dependency
  // written as `latest`, so it is accepted there as a fixed literal — every
  // other tag is a name the registry owns, which is an open set.
  //
  // A field that states a constraint rather than something the registry resolves
  // takes the other one. `engines` is the case that named it: `validRange
  // ("latest")` is null and npm answers EBADENGINE, so the literal there would
  // be evidence of a constraint the file does not state. An EAS `cli.version` is
  // the same kind of field, which is why this type is not called after either.
  "dependency-range": (value) => value === "latest" || SEMVER_RANGE.test(value),
  "version-range": (value) => SEMVER_RANGE.test(value),
  "exact-version": (value) => EXACT_VERSION.test(value),
  "package-manager": (value) => PACKAGE_MANAGER.test(value),
  // A Yarn linker is a member of a closed set, which is in `adapters.mjs` because
  // the other reader of `.yarnrc.yml` needs the same set. Membership rather than
  // shape is the whole point: the shape check this replaced accepted
  // `ghp_realLookingToken123` and emitted it as a definite setting.
  "node-linker": (value) => NODE_LINKERS.has(value),
  // The reader picks this value from two literals of its own rather than out of
  // the file, so this type confirms the engine's invariant rather than standing
  // between anything and stdout. It is still declared, because a schema field
  // without a type is one the engine refuses to load.
  "yarn-lock-generation": (value) => YARN_LOCK_GENERATIONS.has(value),
  // Membership again, and this set does more than describe a value: the reader
  // that produces it consults the same set before reading an importer at all,
  // because an importer's layout is what the version declares. So this type
  // confirms a guard that has already been applied rather than standing alone,
  // which is why the set lives in `adapters.mjs` — two modules read it.
  "pnpm-lockfile-version": (value) => PNPM_LOCKFILE_VERSIONS.has(value),
};

// Every reason this CLI can print, and the whole vocabulary the field may hold.
// Membership rather than shape: an uppercase pattern describes an open language,
// and an environment variable's name — a token's name most of all — satisfies
// one as readily as a code does, so a reason read out of a file would have
// passed where a reason has to be one of these.
const REASONS = new Set([
  "UNSUPPORTED_INPUT",
  "NOT_A_FILE",
  "TOO_LARGE",
  "MISSING",
  "PERMISSION_DENIED",
  "UNREADABLE",
  "NOT_TEXT",
  "ADAPTER_FAILED",
  "REJECTED_VALUE",
  "NO_EVIDENCE",
  "AMBIGUOUS",
]);

// The subset an adapter may choose from. Adding one is a line here, which is
// what keeps the choice with this file rather than with the adapter.
const ADAPTER_REASONS = new Set(["NO_EVIDENCE", "AMBIGUOUS"]);

// Node's errno vocabulary is open too, so it is mapped into the set above
// instead of passed through. Only the distinction that changes what a reader
// does with the result is kept.
const ERRNO_REASONS = new Map([
  ["ENOENT", "MISSING"],
  ["EACCES", "PERMISSION_DENIED"],
  ["EPERM", "PERMISSION_DENIED"],
]);

// Dispatch is by file name, so two adapters claiming one name would make it
// depend on registry order. A schema naming a type that does not exist would
// silently refuse every value of that field. Both fail at load rather than at
// whichever call first reaches them.
const BY_NAME = new Map();
for (const adapter of ADAPTERS) {
  for (const name of adapter.accepts) {
    if (BY_NAME.has(name)) throw new Error(`two adapters accept ${name}`);
    BY_NAME.set(name, adapter);
  }
  for (const [field, type] of Object.entries(adapter.schema)) {
    if (!Object.hasOwn(VALUE_TYPES, type)) {
      throw new Error(
        `${adapter.kind}.${field} names an unknown type: ${type}`,
      );
    }
  }
}

export function matchAdapter(name) {
  return BY_NAME.get(name);
}

// The gate every value passes to reach stdout. The schema is what is walked, so
// a field an adapter invented is never even looked at, and a named field whose
// value its type refuses is reported by name with the value left behind.
// `undefined` is the one way to say absent, and everything else that is not an
// acceptable string is reported as rejected.
function project(schema, fields) {
  const evidence = {};
  const rejected = [];
  for (const [field, type] of Object.entries(schema)) {
    const value = fields?.[field];
    if (value === undefined) continue;
    if (
      typeof value === "string" &&
      value.length <= MAX_VALUE_LENGTH &&
      VALUE_TYPES[type](value)
    ) {
      evidence[field] = value;
    } else {
      rejected.push(field);
    }
  }
  return { evidence, rejected };
}

// A reason an adapter supplies has to be one this file named, so an adapter
// cannot report a failure by echoing what it read.
function adapterReason(reason) {
  return ADAPTER_REASONS.has(reason) ? reason : "NO_EVIDENCE";
}

export function applyAdapter(adapter, text, context) {
  let result;
  try {
    result = adapter.read(text, context);
  } catch {
    // The adapter's own error object is not read. Its message would quote the
    // text that produced it, which is project content leaving through the error
    // path rather than through the schema.
    return { status: "refused", reason: "ADAPTER_FAILED", evidence: {} };
  }
  const { evidence, rejected } = project(adapter.schema, result?.fields);
  // `ok` means the whole file was read, not that some of it was. With one field
  // those are the same thing; with several, a reader gating on the status would
  // otherwise take a manifest whose `engines.node` it could not read as fully
  // accepted. The evidence that did validate is returned either way.
  if (rejected.length === 0 && Object.keys(evidence).length > 0) {
    return { status: "ok", evidence };
  }
  return {
    status: "uncertain",
    reason:
      rejected.length > 0 ? "REJECTED_VALUE" : adapterReason(result?.reason),
    evidence,
    ...(rejected.length > 0 ? { rejected } : {}),
  };
}

// Every refusal is built here, so the membership test sits at the one point no
// later branch can go around.
function refused(kind, reason) {
  return {
    kind,
    status: "refused",
    reason: REASONS.has(reason) ? reason : "UNREADABLE",
    evidence: {},
  };
}

// The path is read and never printed. An earlier version echoed it back as
// `source` on the argument that it is the caller's own input, which is a
// per-field exception to the rule that a value reaches stdout only after a
// validator accepted it — and a directory name can carry a credential as
// readily as a file's contents can. The caller passed the path in and does not
// need it back.
export function readEvidence(path, { maxBytes, appDir } = {}) {
  const source = resolve(path);
  const adapter = matchAdapter(basename(source));
  if (adapter === undefined) {
    return refused(null, "UNSUPPORTED_INPUT");
  }
  let raw;
  let handle;
  try {
    // The path is opened once and every question is then asked of the
    // descriptor, so what was measured and what is read are the same file
    // rather than two resolutions of one name.
    //
    // `O_NONBLOCK` is what makes that order safe. A plain open of a named pipe
    // for reading blocks until a writer appears, so a check on the path first
    // looks like the answer — but the path can become a pipe between that check
    // and the open, and then the open is where it hangs. Opening non-blocking
    // returns immediately for a pipe and changes nothing for a regular file,
    // which `fstat` then confirms this is before anything is read.
    handle = openSync(source, constants.O_RDONLY | constants.O_NONBLOCK);
    const opened = fstatSync(handle);
    if (!opened.isFile()) return refused(adapter.kind, "NOT_A_FILE");
    // an adapter may declare its own bound where its format is legitimately
    // larger than a configuration file
    const bound = maxBytes ?? adapter.maxBytes ?? MAX_BYTES;
    if (opened.size > bound) return refused(adapter.kind, "TOO_LARGE");
    // The read is bounded by that descriptor's own size, which truncates a file
    // growing underneath instead of following it, and the loop is what keeps a
    // short read from truncating one that is not.
    raw = Buffer.alloc(opened.size);
    let filled = 0;
    while (filled < opened.size) {
      const read = readSync(handle, raw, filled, opened.size - filled, filled);
      if (read === 0) break;
      filled += read;
    }
    if (filled !== opened.size) raw = raw.subarray(0, filled);
  } catch (error) {
    return refused(
      adapter.kind,
      ERRNO_REASONS.get(error?.code) ?? "UNREADABLE",
    );
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
  // A NUL byte means this is not the text file the adapter was written for —
  // a binary plist reaches an adapter that expects a text one exactly this way.
  if (raw.includes(0)) return refused(adapter.kind, "NOT_TEXT");
  // The context tells an adapter where the caller says the selected app is,
  // expressed relative to the file being read. `relative` is lexical, so this
  // reads no filesystem. The result is used to look up a key and is never
  // emitted. An adapter whose file describes one package ignores it.
  //
  // Separators are normalised because the key it looks up is not a path: a
  // lockfile writes `apps/mobile` on every platform, while `relative` answers
  // `apps\mobile` on Windows, so the lookup would miss for every nested
  // workspace there. `relative` can also answer with an absolute path when the
  // two are on different volumes. The context preserves that answer so each
  // lockfile adapter can apply its own format's rule.
  const context = appContext(source, appDir);
  return {
    kind: adapter.kind,
    ...applyAdapter(adapter, raw.toString("utf8"), context),
  };
}

// Both usage failures print this and nothing else, so no argument the caller
// passed is echoed back on either stream.
const USAGE_ERROR =
  "[rn-upgrade-pulse-evidence] pass exactly one --read, and at most one --app-dir, each with a non-empty value";

// The app as lockfile context. `app` is the ordinary relative key, `null` when
// the result is absolute, and `undefined` when the caller named no app.
// `absoluteApp` preserves a normalized cross-volume result for a format that
// writes one as a key.
//
// `null` rather than the `".."` this returned before, because `".."` is a key a
// real lockfile holds. A leading `..` does not by itself mean a path outside the
// file's tree: pnpm's `getLockfileImporterId` is
// `path.relative(lockfileDir, projectDir)`, so `pnpm install --lockfile-dir`
// writes one whenever the lockfile's directory is not an ancestor of the
// project — reproduced on pnpm 11.25.0, which wrote a whole `../../…` chain as
// an importer id. Overloading `".."` as the sentinel would let an app on
// another volume match that importer. Whether a key is outside the tree is the
// reading adapter's question, and each answers it the way its own format does.
function normalizeImporterPath(path) {
  if (path === "\\" || path === "/") return "/";
  if (path.length <= 1) return path;
  let prefix = "";
  if (
    path.length > 4 &&
    path.startsWith("\\\\") &&
    (path[2] === "?" || path[2] === ".") &&
    path[3] === "\\"
  ) {
    path = path.slice(2);
    prefix = "//";
  }
  const segments = path.split(/[/\\]+/);
  if (segments[segments.length - 1] === "") segments.pop();
  return prefix + segments.join("/");
}

export function appContext(source, appDir, pathApi = NATIVE_PATH) {
  if (appDir === undefined) return { app: undefined };
  const path = pathApi.relative(
    pathApi.dirname(source),
    pathApi.resolve(appDir),
  );
  const normalized = normalizeImporterPath(path);
  return pathApi.isAbsolute(path)
    ? { app: null, absoluteApp: normalized }
    : { app: normalized };
}

function printUsage() {
  process.stdout.write(
    [
      "evidence.mjs — typed, allowlisted evidence from one project file",
      "",
      "  --read <path>       emit typed evidence for that file",
      "  --app-dir <dir>     the selected app root, for a file describing several",
      "  --help,-h",
      "",
      "One file per run. Output is JSON on stdout.",
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
        // silently keeping the last one and passing the one-file check
        read: { type: "string", multiple: true },
        "app-dir": { type: "string", multiple: true },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch {
    // `parseArgs` quotes the offending argument in its message, and an argument
    // is caller text like any other. The one fixed line goes out instead: the
    // caller can see what it passed, and this stream carries nothing it did not
    // already have.
    process.stderr.write(`${USAGE_ERROR}\n`);
    return 1;
  }
  if (values.help) {
    printUsage();
    return 0;
  }
  // Presence and emptiness are separate checks: filtering the empties out first
  // would let an unset shell variable through as a missing argument instead of
  // as the usage error it is.
  const supplied = values.read ?? [];
  if (supplied.length !== 1 || supplied[0] === "") {
    process.stderr.write(`${USAGE_ERROR}\n`);
    return 1;
  }
  // At most one, for the same reason `--read` takes one: a repeated flag must not
  // silently keep the last value.
  const appDirs = values["app-dir"] ?? [];
  if (appDirs.length > 1 || appDirs[0] === "") {
    process.stderr.write(`${USAGE_ERROR}\n`);
    return 1;
  }
  process.stdout.write(
    `${JSON.stringify(readEvidence(supplied[0], { appDir: appDirs[0] }), null, 2)}\n`,
  );
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
  // Node prints a process warning to stderr through a listener it installs
  // itself, and a parser's warning quotes the source line that raised it — a
  // whole line of project content on an emitting path, reached without passing
  // any validator. An adapter's own quiet option closes it for that adapter,
  // and this closes the channel for every adapter that will ever be added:
  // the guarantee cannot rest on each one remembering to configure its parser.
  //
  // Only on the path this file owns. Imported as a module it is a caller's
  // process, and removing their listeners is not this file's to do.
  process.removeAllListeners("warning");
  process.on("warning", () => {});
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
