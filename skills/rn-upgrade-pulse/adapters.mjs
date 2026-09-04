// The adapters that `evidence.mjs` dispatches to.
//
// An adapter turns one file's text into candidate values for the fields its
// schema names. It does not write to stdout, it does not decide what is safe to
// print, and it never sees a path: `evidence.mjs` owns all three. An adapter
// that returns nothing usable says so with a code from a closed vocabulary,
// never with a message, because a parser's message quotes the text it read.
//
// A pattern here is an extractor, not a safety boundary. That is the difference
// this file rests on: when a pattern reaches too far, the candidate it produced
// still has to satisfy its field's declared type, so a miss becomes a refusal
// rather than a leak.
//
// The line readers below consume each line whole, and none of the formats they
// read nests, spans lines, or carries structural state between them. A format
// that does gets its own parser rather than a line reader, for the reason
// written beside `mise.toml`.
import { parse as parseToml } from "./vendor/smol-toml/dist/index.js";
import { load as loadPnpmYaml } from "./vendor/js-yaml/dist/js-yaml.mjs";
// A default import, because this package declares `"type": "commonjs"`: named
// exports out of CommonJS depend on the loader detecting them, and the
// declaration is the thing there is no detection question about.
import YAML from "./vendor/yaml/dist/index.js";

// The characters these formats' own readers treat as whitespace, written as the
// closed set they are: POSIX `[[:space:]]` in the C locale, which is what nvm's
// `sed 's/^[[:space:]]*//;s/[[:space:]]*$//'` and a shell word split both use.
//
// It is a positive definition on purpose. `String.prototype.trim` and `\s` mean
// Unicode whitespace, which is an open set that grows: trimming it removed a
// byte-order mark, then a non-breaking space, each turning a file the version
// manager cannot read into a clean pin, and each fix only named the codepoint
// that had been reported. Anything outside the set below stays in the candidate
// for the version type to refuse.
const SPACE = String.raw`[ \t\n\v\f\r]`;
const OUTER_SPACE = new RegExp(`^${SPACE}+|${SPACE}+$`, "g");
const INNER_SPACE = new RegExp(`${SPACE}+`);

function trimEdges(line) {
  return line.replace(OUTER_SPACE, "");
}

// A field the adapter found something in but could not read, as distinct from
// one that is absent. Without it the two collapse: absence is `undefined`, and
// every way a present but malformed input produced `undefined` — a container
// that is a string, a declaration that is `null`, a value of the wrong type —
// read as a field the manifest never had, so a manifest that half validated came
// back `ok`. Three rounds reported one shape each of that; the sentinel removes
// the class rather than shortening it.
//
// It lives here rather than in `evidence.mjs` only because that file already
// imports this one, and the dependency stays in one direction.
export const UNREADABLE_FIELD = Symbol("unreadable field");

// The linkers Yarn has, as the closed set they are.
//
// It lives here for the reason `UNREADABLE_FIELD` does: two modules need it and
// this is the one they can both import without a cycle or a side effect.
// `evidence.mjs` reads it as the `node-linker` value type, and
// `rn-upgrade-pulse.mjs` reads it to decide whether a `nodeLinker:` line
// declares a linker at all.
//
// These three are the enumeration Yarn's own configuration page documents. That
// is the evidence basis and it is a document rather than a grep of Berry's
// source: the yarn on this machine is 1.22.22, which has no such setting to
// read. A fourth value Yarn adds later reads as uncertain until it is added
// here, which costs evidence and never safety.
export const NODE_LINKERS = new Set(["node-modules", "pnp", "pnpm"]);

// The two generations of `yarn.lock`, as the closed set they are. Here rather
// than in `evidence.mjs` for the reason above it: `rn-upgrade-pulse.mjs` reads
// the same set while its own walk still exists.
export const YARN_LOCK_GENERATIONS = new Set(["classic", "berry"]);

// The `pnpm-lock.yaml` versions whose importer layout this reader established,
// as the closed set they are. One member: pnpm 11.25.0 writes `9.0` and nothing
// else (`LOCKFILE_MAJOR_VERSION = "9"`, with `LOCKFILE_VERSION` built from it,
// in its bundled `core/constants`), and all 35 lockfiles measured on this
// machine declare it.
//
// Here rather than in `evidence.mjs` for the reason the two sets above are: two
// modules read it. `evidence.mjs` reads it as the `pnpm-lockfile-version` value
// type, and `readPnpmLockfile` reads it before it reads an importer at all.
//
// Adding a member is establishing a layout, not widening a bound. Lockfile
// version 6.0 holds its importers in the same shape and would very likely read
// correctly, and it is still not a member: what makes a member is a layout read
// off a real file with a fixture recording it, and that has been done for one.
export const PNPM_LOCKFILE_VERSIONS = new Set(["9.0"]);

// Every non-blank line that is not wholly a comment, trimmed.
function* lines(text) {
  for (const raw of text.split(/\r?\n/)) {
    const line = trimEdges(raw);
    if (line !== "" && !line.startsWith("#")) yield line;
  }
}

// The line with a trailing comment cut off. Only the formats whose own readers
// do this get it: nvm runs `sed 's/#.*//'` over `.nvmrc` (nvm.sh:619) and asdf
// takes `#` as a comment in `.tool-versions`. `.node-version` has no such rule,
// and a tool reading that file would fail on the whole string, so cutting there
// would report a pin that does not resolve.
function withoutComment(line) {
  return trimEdges(line.split("#")[0]);
}

// One candidate is evidence, none is an absence, and more than one is a file
// this adapter cannot resolve on its own. Candidates are counted rather than
// deduplicated: a file that declares the pin twice is a file this reader does
// not understand, whichever values the two declarations carry.
function fromCandidates(found) {
  if (found.length === 0) return { reason: "NO_EVIDENCE" };
  if (found.length > 1) return { reason: "AMBIGUOUS" };
  return { fields: { version: found[0] } };
}

// `.node-version` holds a version and nothing else, so every line that is
// neither blank nor a comment is a candidate and a second one leaves the file
// ambiguous rather than resolved by order.
function readNodeVersion(text) {
  return fromCandidates([...lines(text)]);
}

// `.nvmrc` is that shape plus the rules nvm's own reader applies. A trailing
// comment is cut, and a `key=value` line is configuration rather than the pin:
// `nvm_process_nvmrc_content` collects those separately and resolves the single
// line left over (nvm.sh:634-682). More than one line left over is an error
// there too, which is what AMBIGUOUS says here.
//
// A pair leaves the file unread when nvm would refuse it, and the test for that
// is a positive definition rather than a list of dangerous shapes. nvm stores
// the keys it has seen in one space-separated string and asks
// `grep -E "(^| )${key}( |$)"` whether the next one is already there, so a key
// is safe to compare literally only when it is a plain token: an ERE
// metacharacter makes it match a different key (measured — `mirrorXprod=a`
// followed by `mirror.prod=b` is refused there, and the reverse order is not),
// and so does a space, which splits one key into two of that string's words.
//
// Enumerating those was the wrong shape: each round named one more character.
// A key that is not a plain token leaves the file unread, which covers both and
// whatever the next one would have been. The key `node` is nvm's own refusal,
// and a repeat is the check itself.
//
// There is no allowlist of key *names* beyond that, which is measured rather
// than assumed: nvm resolves `20.11.1` beside an arbitrary `NODE_AUTH_TOKEN=…`
// line. Such a list would report uncertain for files nvm answers definitely,
// which is the narrowing this architecture exists to remove.
const PLAIN_KEY = /^[\w-]+$/;

function readNvmrc(text) {
  const found = [];
  const keys = new Set();
  for (const raw of lines(text)) {
    const line = withoutComment(raw);
    if (line === "") continue;
    const separator = line.indexOf("=");
    // a line whose key part is empty is the pin to nvm, not a pair
    if (separator <= 0) {
      found.push(line);
      continue;
    }
    const key = trimEdges(line.slice(0, separator));
    if (key === "node" || !PLAIN_KEY.test(key) || keys.has(key)) {
      return { reason: "NO_EVIDENCE" };
    }
    keys.add(key);
  }
  return fromCandidates(found);
}

// asdf and mise read `.tool-versions` one `<tool> <version>...` line at a time,
// so only a line naming node contributes and another tool's value is never a
// candidate. A tool may list fallback versions after the first, and each of
// those is a candidate too: taking the first alone would report one definite pin
// for a line that declares several. A comment may follow on the same line, and
// it is cut before the versions are collected — counting `#` and the words after
// it as fallback versions made an ordinary commented pin ambiguous.
//
// The line is consumed whole either way. Skipping another tool's line is a
// choice about relevance, not a line this reader failed to read, which is what
// keeps the fail-closed rule decidable here.
function readToolVersions(text) {
  const declarations = [];
  for (const line of lines(text)) {
    const [tool, ...versions] = withoutComment(line).split(INNER_SPACE);
    if (tool === "node" || tool === "nodejs") {
      declarations.push(versions.filter((version) => version !== ""));
    }
  }
  // A line naming node with no version after it is still a declaration of node.
  // Counting only the versions let a second such line vanish and left the first
  // line's pin looking unambiguous, which contradicts the rule above rather than
  // any one tool's behaviour.
  if (declarations.length > 1) return { reason: "AMBIGUOUS" };
  return fromCandidates(declarations[0] ?? []);
}

// `mise.toml`, the one pin format that is read by a parser rather than by the
// readers above.
//
// A line reader for it was written and removed. It went through four review
// rounds finding one class of defect: a value matched by prefix, then a table
// header matched by prefix, then a line that was neither header nor assignment
// being skipped, then an assignment outside the Node path never being validated.
// Each fix revealed the next instance, which is the shape that says the reader
// is doing a job its abstraction cannot do — TOML nests, and a line carries no
// record of the table it is in. Validating uniformly closes the class and
// refuses `[settings]\nexperimental = true` with it, which is ordinary mise, so
// the only two settings a line reader has for this format are wrong sometimes
// and useless mostly.
//
// The parser is vendored, because this skill is installed by cloning the plugin
// and nothing runs `npm install` afterwards; `vendor/README.md` records which
// package and version, and how to reproduce the copy. It is not mise's own
// reader, and where the two disagree on what is valid TOML, `SKILL.md` records
// it under Not Examined rather than this reader working around it.
//
// Parsing the whole file is what makes the `[env]` table beside the pin a
// non-question. It is read into the object like everything else and nothing
// addresses it, so it has no path to stdout — the same reason the manifest
// adapter can read a whole `package.json`. A file the parser refuses raises,
// and `applyAdapter` turns that into `ADAPTER_FAILED` without reading the error:
// a TOML parser's message quotes the line it failed on.
//
// Two names are claimed, and they are the two the discovery row returns.
// `mise.local.toml` is not one of them, and mise's other locations —
// `.config/mise/config.toml` and `.mise/config.toml` — arrive at `matchAdapter`
// as the basename `config.toml`, which is a name this adapter must not claim on
// behalf of every other tool that uses it. They are excluded inputs rather than
// unread ones, and `SKILL.md` records them under Not Examined.
const MISE_ACCEPTS = ["mise.toml", ".mise.toml"];

// mise names the tool `node`; `nodejs` is the name asdf used, which the
// `.tool-versions` reader above accepts for the same reason. `core:node` is the
// same tool written as the backend identifier the registry maps `node` to, and a
// backend-qualified key is an ordinary `[tools]` key — the npm backend's own
// documented example is `"npm:prettier" = "latest"`, and `mise use` writes the
// qualified form when it is given one.
//
// A closed set rather than a `<backend>:node` pattern. The set can be extended
// when a real file needs another member; a pattern would accept a backend whose
// meaning this reader has not established, which is the widening this file
// refuses everywhere else. `SKILL.md` records the rest as unexamined.
//
// All three are collected rather than ordered, because a file declaring the pin
// under more than one of them declares it more than once, and this reader does
// not resolve that.
const MISE_TOOL_NAMES = ["node", "nodejs", "core:node"];

// A mapping, defined positively. `typeof value === "object"` is not that test: a
// TOML date is an object too, and it reached both readers below as a table — one
// collapsing a present `tools` into an absent one, the other only landing on the
// right answer because a date has no `version` property. Both parsers return a
// plain object for a mapping, inline or not, so the prototype separates it from
// anything else that is an object. Naming `TomlDate` would cover the one value
// type that happens to be an object today rather than the class, which is why
// the YAML reader takes this same test rather than one of its own.
function isTable(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

// One entry, as mise spells a version: the string itself, or the `version` key
// of the table form (`[tools.node]`, or an inline table). Anything else — a bare
// number, a date, a table stating everything but the version — is a declaration
// whose position this reader recognises and whose value it does not, which the
// sentinel says and the field's type then refuses.
function miseVersion(entry) {
  if (typeof entry === "string") return entry;
  if (!isTable(entry)) return UNREADABLE_FIELD;
  return Object.hasOwn(entry, "version") ? entry.version : UNREADABLE_FIELD;
}

// A tool may be given a list of versions, and each of those is a candidate: mise
// installs them all and this reader reports one pin or none.
function miseVersions(declaration) {
  if (!Array.isArray(declaration)) return [miseVersion(declaration)];
  // An empty list still declares the tool. Returning no candidates for it would
  // report the file as declaring no pin at all, which is the absent/unreadable
  // collapse the sentinel exists to prevent.
  if (declaration.length === 0) return [UNREADABLE_FIELD];
  return declaration.map(miseVersion);
}

function readMiseConfig(text) {
  const tools = parseToml(text).tools;
  if (tools === undefined) return { reason: "NO_EVIDENCE" };
  // present and not a table, so this file says something about tools that this
  // reader cannot read as one
  if (!isTable(tools)) return { fields: { version: UNREADABLE_FIELD } };
  const found = [];
  for (const name of MISE_TOOL_NAMES) {
    if (Object.hasOwn(tools, name)) found.push(...miseVersions(tools[name]));
  }
  return fromCandidates(found);
}

// Every node-pin file answers one question with one field, so the readers share
// a schema and differ only in how their format spells the answer.
const NODE_PIN = { kind: "node-pin", schema: { version: "node-version" } };

// The manifest fields that can declare a package as this app's own.
// `peerDependencies` is absent on purpose — it states a compatibility
// requirement, never that this package installed the copy that was found, so a
// peer-only entry would promote a neighbour's install to the app's own.
//
// Their order carries no priority, because a package declared in two of them
// with two different ranges is not resolved here by picking one. This reader
// already says that a file declaring the same thing twice is one it does not
// understand, and the alternative was to reproduce npm's edge priority: Arborist
// loads prod, then optional, then dev, and `#loadDepType` replaces an existing
// edge, so `devDependencies` wins — the opposite of the order this list was
// first written in. Two declarations agreeing on a range still emit it.
const DECLARATION_FIELDS = [
  "optionalDependencies",
  "dependencies",
  "devDependencies",
];

function declaredRange(manifest, name) {
  const ranges = new Set();
  let unreadable = false;
  for (const field of DECLARATION_FIELDS) {
    const declarations = manifest[field];
    // absent: this block says nothing about the package
    if (declarations === undefined) continue;
    // present and not a plain object: this cannot say whether the package is
    // declared, which is not the same as saying it is not
    if (
      declarations === null ||
      typeof declarations !== "object" ||
      Array.isArray(declarations)
    ) {
      unreadable = true;
      continue;
    }
    if (Object.hasOwn(declarations, name)) ranges.add(declarations[name]);
  }
  if (unreadable || ranges.size > 1) return UNREADABLE_FIELD;
  return ranges.size === 1 ? [...ranges][0] : undefined;
}

// `packageManager` is `name@version`, with semver build metadata after a `+`
// where corepack wrote a hash. The metadata is dropped because semver says it is
// not part of the version's identity.
//
// What this field reports is what the manifest declares, not whether corepack
// will accept it. Corepack reads the first metadata identifier as a hash
// algorithm and the second as a digest, so `+sha512.not-a-hash` fails there
// while it is a well-formed declaration here — checking that would mean carrying
// corepack's algorithm list and digest lengths, which is a second implementation
// of a tool rather than evidence about a file. The boundary is the same one the
// range grammar draws: the shape is bounded, third-party acceptance is not
// claimed.
//
// A transform may only drop a part it has recognised, and "recognised" means the
// metadata's own grammar rather than its character set. Splitting at the `+` and
// keeping the head dropped whatever followed without reading it, so
// `pnpm@10.4.1+not valid` became the pin `pnpm@10.4.1`; matching the rest as one
// run of `[0-9A-Za-z.-]` then still accepted `+sha512..deadbeef`, whose empty
// identifier semver does not allow. Build metadata is dot-separated non-empty
// identifiers, and that is what is matched. A declaration that does not match is
// handed on unchanged for the type to reject rather than repaired.
const BUILD_ID = String.raw`[0-9A-Za-z-]+`;
const PACKAGE_MANAGER_DECLARATION = new RegExp(
  String.raw`^([^@+]+@[^@+]+)(?:\+${BUILD_ID}(?:\.${BUILD_ID})*)?$`,
);

function packageManagerPin(declared) {
  // A declaration that is present but not a string is passed through, not turned
  // into an absence: `undefined` would drop it from the projection entirely, so
  // a manifest whose `packageManager` is a number would read as one that
  // declares none. The type rejects it and names the field.
  if (declared === undefined) return undefined;
  if (typeof declared !== "string") return UNREADABLE_FIELD;
  const matched = PACKAGE_MANAGER_DECLARATION.exec(declared);
  return matched === null ? declared : matched[1];
}

// A value from a nested object, and only when every step of the way is a plain
// object. A manifest can put anything under any of these keys, so a step that is
// present and not an object is reported as unreadable rather than as an absence
// — `"engines": "invalid"` is a manifest whose engine field cannot be read, not
// one that declares no engines.
function nested(value, ...path) {
  let current = value;
  for (const key of path) {
    // absent at this step, so the field is absent
    if (current === undefined) return undefined;
    // present at this step and not something a field can be read out of
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return UNREADABLE_FIELD;
    }
    current = current[key];
  }
  return current;
}

// `package.json`, read with the platform's own parser rather than a line reader,
// which is why this adapter exists where the TOML one does not.
//
// Nothing here decides what is safe to print. Every marker the corpus puts in a
// manifest sits in a place this adapter never looks — another dependency's
// specifier, a script's command line, a free-form `expo.extra` key, a header
// under it — and that is the point: those have no field in the schema, so no
// detector has to recognise them. What the schema does name is read by key and
// handed to `evidence.mjs`, which prints it only if its type accepts it whole.
//
// A manifest that does not parse throws, and the engine turns that into a
// refusal with a code. `JSON.parse`'s message quotes the text it failed on, and
// nothing here reads it.
function readNpmManifest(text) {
  // A byte-order mark is stripped here and kept in a pin file, and that is one
  // rule rather than two: each reader does what the format's own reader does.
  // nvm leaves the mark in the value and then fails to resolve it, so keeping it
  // is what makes a file it cannot read come back uncertain; Node's manifest
  // loader accepts one, so stripping it is what keeps a manifest npm reads from
  // being refused.
  const manifest = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest)
  ) {
    return { reason: "NO_EVIDENCE" };
  }
  return {
    fields: {
      react: declaredRange(manifest, "react"),
      reactNative: declaredRange(manifest, "react-native"),
      expo: declaredRange(manifest, "expo"),
      expoSdkVersion: nested(manifest, "expo", "sdkVersion"),
      engineNode: nested(manifest, "engines", "node"),
      packageManager: packageManagerPin(manifest.packageManager),
    },
  };
}

const NPM_MANIFEST = {
  kind: "npm-manifest",
  accepts: ["package.json"],
  schema: {
    react: "dependency-range",
    reactNative: "dependency-range",
    expo: "dependency-range",
    expoSdkVersion: "exact-version",
    engineNode: "version-range",
    packageManager: "package-manager",
  },
  read: readNpmManifest,
};

// `package-lock.json` and `npm-shrinkwrap.json`, read with the platform's parser
// for the reason the manifest is.
//
// The two fixtures for this kind exist because a line-based reader leaked a
// resolved URL out of them — one puts the whole tree on a single line, the other
// puts the version and the credentialed URL on the line after the key. Neither
// shape means anything to a parser, and `resolved` has no field in the schema,
// so the URL has no way out whatever line it sits on.
//
// Only the root entry for each package is read. A lockfile also carries nested
// `node_modules/x/node_modules/react` entries for a conflicting copy, and those
// are not what the app resolves.
//
// The `packages` map is npm 7's format and later. A v1 lockfile carries only the
// older `dependencies` tree and comes back with no evidence rather than a second
// reader for a format npm has not written since 2020.
function readNpmLockfile(text, context) {
  const lockfile = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (
    lockfile === null ||
    typeof lockfile !== "object" ||
    Array.isArray(lockfile)
  ) {
    return { reason: "NO_EVIDENCE" };
  }
  return {
    fields: {
      react: installedVersion(lockfile, "react", context?.app),
      reactNative: installedVersion(lockfile, "react-native", context?.app),
      expo: installedVersion(lockfile, "expo", context?.app),
    },
  };
}

// The version the selected app resolves, read the way npm places one.
//
// A lockfile that describes one package has one answer: the root hoist. A
// lockfile that describes a workspace has one per workspace, and which applies
// depends on the app — so it is answered only when the caller said which app
// that is, and refused otherwise rather than guessed. Three rounds of guessing
// preceded this: reading every app-level copy gave an app its sibling's copy,
// and reading the root gave it a dependency hoisted for a sibling.
//
// The placement is npm's, reproduced on npm 11.19.0. A root declaring
// `workspaces: ["apps/*"]` where `apps/mobile` wants 17 and `apps/web` wants 18
// writes 17 to the root `node_modules/<name>` and 18 to
// `apps/web/node_modules/<name>`, and gives each workspace an entry listing its
// own dependencies. So an app resolves its own copy when it has one and the root
// hoist otherwise, and only for a package its own entry declares — a package it
// does not declare is a neighbour's, whatever sits at the root.
function installedVersion(lockfile, name, app) {
  const packages = nested(lockfile, "packages");
  if (packages === undefined || packages === UNREADABLE_FIELD) return packages;
  if (
    packages === null ||
    typeof packages !== "object" ||
    Array.isArray(packages)
  ) {
    return UNREADABLE_FIELD;
  }
  if (!describesWorkspaces(packages)) {
    return descriptorVersion(packages, packages[`node_modules/${name}`], name);
  }
  // `undefined` is no `--app-dir`, and `null` is an app that cannot be written
  // as a key at all. A first segment of `..` is an app outside the tree this
  // file describes: npm writes every workspace key beneath the lockfile, so
  // nothing above it is described here. That is npm's rule and not a shared
  // one — the pnpm reader below takes a different answer from its own format.
  if (app === undefined || app === null || app.split("/")[0] === "..") {
    return UNREADABLE_FIELD;
  }
  const own = packages[app];
  if (own === undefined) return UNREADABLE_FIELD;
  const declared = declaresDependency(own, name);
  if (declared !== true) return declared === false ? undefined : declared;
  const local = app === "" ? "" : `${app}/`;
  return descriptorVersion(
    packages,
    packages[`${local}node_modules/${name}`] ??
      packages[`node_modules/${name}`],
    name,
  );
}

// Whether this lockfile describes a workspace, taken from the root entry's own
// `workspaces` field rather than from the shape of the keys.
//
// The keys cannot tell: npm writes a workspace as a local link, so `apps/web`
// beside `node_modules/web` and `local-react` beside `node_modules/react` are the
// same structure — a `file:` dependency and a workspace package are indistinct
// there, and judging by key shape refused the link case this reader follows.
// Verified on npm 11.19.0: the root entry of a workspace lockfile carries
// `workspaces: ["apps/*"]`, and the root entry of a `file:` one carries no such
// field.
//
// A lockfile with no root entry is not one npm writes, and the ambiguity this
// guards against lives in files that declare workspaces, so it is read as
// describing one package.
function describesWorkspaces(packages) {
  return nested(packages, "", "workspaces") !== undefined;
}

// Whether a workspace's own entry declares this package, as three answers: a
// declaration block that is present and not a plain object leaves this unable to
// say, which is not the same as saying no.
function declaresDependency(entry, name) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return UNREADABLE_FIELD;
  }
  let declared = false;
  for (const field of DECLARATION_FIELDS) {
    const declarations = entry[field];
    if (declarations === undefined) continue;
    if (
      declarations === null ||
      typeof declarations !== "object" ||
      Array.isArray(declarations)
    ) {
      return UNREADABLE_FIELD;
    }
    if (Object.hasOwn(declarations, name)) declared = true;
  }
  return declared;
}

// The version on one entry, after following a link and checking identity.
//
// An entry whose `name` differs from the key's is an alias — `node_modules/x`
// holding a fork — so its version is not this package's version and the field is
// unreadable rather than mislabelled.
//
// `name` is the signal because npm writes it exactly when it differs from the
// key. Reproduced on npm 11.19.0 with one manifest declaring both
// `"react-is": "18.3.1"` and `"react-is-18": "npm:react-is@18.3.1"`: the plain
// entry has no `name`, the aliased one has `name: "react-is"`. So an absent
// `name` is an ordinary install rather than an identity that could not be
// established, and refusing those would refuse every ordinary entry.
function descriptorVersion(packages, entry, name) {
  if (entry === undefined) return undefined;
  const descriptor = linkedDescriptor(packages, entry);
  if (descriptor === UNREADABLE_FIELD) return UNREADABLE_FIELD;
  const installed = nested(descriptor, "name");
  if (installed !== undefined && installed !== name) return UNREADABLE_FIELD;
  return nested(descriptor, "version");
}

// A `file:` dependency is written as a link: the entry under `node_modules/<name>`
// carries `link: true` and a `resolved` naming another key in the same map, and
// the version lives on that descriptor. Reproduced on npm 11.19.0 — a manifest
// declaring `"react": "file:./local-react"` writes
// `"node_modules/react": {"resolved": "local-react", "link": true}` beside
// `"local-react": {"name": "react", "version": "18.3.1"}`.
//
// A link's `resolved` is a key in this file rather than a URL, and it is used as
// one and never emitted.
// Whether an entry is a link, as three answers rather than two. Arborist branches
// on `if (meta.link)` (`@npmcli/arborist/lib/shrinkwrap.js`, line 558 in the npm
// installed here), so anything truthy is a link there; only a boolean is one
// here, and a present marker that is neither belongs to a file this reader does
// not understand.
//
// One function because the question is asked twice — of the entry, and of the
// descriptor it points at. Hardening only the first left `"link": "true"` on a
// target read as an ordinary descriptor, which is the same defect one hop along.
function linkState(entry) {
  const link = nested(entry, "link");
  if (link === undefined || link === false) return "none";
  return link === true ? "link" : "unreadable";
}

function linkedDescriptor(packages, entry) {
  const state = linkState(entry);
  if (state === "none") return entry;
  if (state === "unreadable") return UNREADABLE_FIELD;
  const target = nested(entry, "resolved");
  if (typeof target !== "string") return UNREADABLE_FIELD;
  const descriptor = packages[target];
  // one hop: a target this map does not hold, one that is itself a link, and one
  // whose marker is malformed are all files this reader does not resolve
  if (descriptor === undefined || linkState(descriptor) !== "none") {
    return UNREADABLE_FIELD;
  }
  return descriptor;
}

// `yarn.lock`, read for which generation wrote it and for nothing else.
//
// Two formats under one name. Yarn 1 writes its own format and stamps a header;
// Berry writes YAML and opens a `__metadata` block instead. Neither parses as
// the other, so this reader does not parse at all: it asks which of the two
// stamps is present.
//
// That makes the pattern here a detector rather than an extractor, and the
// difference is what makes it safe. The value emitted is one of two literals
// this file chose; no part of the lockfile becomes it, whatever a `resolved`
// URL beside the header holds. The `yarn-lock-generation` type checks that
// literal on the way out, which is the engine's invariant holding rather than
// the thing standing between a credential and stdout.
//
// A file carrying neither stamp is one whose generation this reader cannot
// read, which is a rejected field rather than an absent one: every `yarn.lock`
// was written by some generation. A file carrying both is a file that does not
// resolve, the rule this reader already applies to a thing declared twice.
const YARN_LOCK_CLASSIC = /^#\s*yarn\s*lockfile\s*v1/m;
const YARN_LOCK_BERRY = /^__metadata:/m;

export function readYarnLockfile(text) {
  const found = [];
  if (YARN_LOCK_CLASSIC.test(text)) found.push("classic");
  if (YARN_LOCK_BERRY.test(text)) found.push("berry");
  if (found.length > 1) return { reason: "AMBIGUOUS" };
  return {
    fields: { generation: found.length === 1 ? found[0] : UNREADABLE_FIELD },
  };
}

const YARN_LOCKFILE = {
  kind: "yarn-lockfile",
  accepts: ["yarn.lock"],
  // A lockfile is legitimately large, for the reason the npm one below states.
  maxBytes: 32 * 1024 * 1024,
  schema: { generation: "yarn-lock-generation" },
  read: readYarnLockfile,
};

const NPM_LOCKFILE = {
  kind: "npm-lockfile",
  accepts: ["package-lock.json", "npm-shrinkwrap.json"],
  // A lockfile is the one input here that is legitimately large: a monorepo's
  // runs to tens of megabytes, and the default bound — sized for a config file —
  // would refuse it unread and lose every version in it.
  maxBytes: 32 * 1024 * 1024,
  schema: {
    react: "exact-version",
    reactNative: "exact-version",
    expo: "exact-version",
  },
  read: readNpmLockfile,
};

// `eas.json`, the third JSON format and the one whose schema is mostly the
// project's to name.
//
// Only `cli.version` is emitted. Everything an assessment might otherwise want
// from this file is addressed by a build profile, and a profile name is the
// project's own string: naming one in the output would put an arbitrary key
// there, which is the gap the legacy projection has and this path does not. The
// fixture's credential sits in a profile's `env` block for exactly that reason,
// and it is unreachable because no field addresses a profile at all.
//
// A profile's `node` pin is worth having and is not here yet. It needs a way to
// say which profile it came from without emitting the profile's name, and that
// is a schema question rather than a reading one.
// Strict JSON only. EAS CLI reads JSON5, so a comment or a trailing comma makes
// this refuse a file EAS accepts — the same limit `rn-eas-profile-audit` states
// for the same file, and it is stated in `SKILL.md` beside the row rather than
// worked around. A JSON5 reader is a parser dependency, which is the decision
// `mise.toml` is also waiting on.
function readEasConfig(text) {
  const config = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return { reason: "NO_EVIDENCE" };
  }
  return { fields: { easCliVersion: nested(config, "cli", "version") } };
}

const EAS_CONFIG = {
  kind: "eas-config",
  accepts: ["eas.json"],
  schema: { easCliVersion: "version-range" },
  read: readEasConfig,
};

// `pnpm-workspace.yaml`, read for its catalog and for nothing else.
//
// The catalog is where a pnpm workspace keeps the version, and a manifest that
// uses it writes `"react": "catalog:"` — a specifier the registry never
// resolves, which the dependency-range type rejects and should. So without this
// adapter a catalog project reports no range for react at all, which is a wrong
// absence rather than a missing feature. The two files carry one answer between
// them and `SKILL.md` joins them; the manifest's rejected field is that file
// correctly declining to state a range it does not hold.
//
// The default catalog only, in either of the two places pnpm accepts it. Any
// other named catalog under `catalogs` is selected by a manifest writing
// `catalog:<name>`, and naming it in the output would put a project-owned string
// there — the same reason no `eas.json` build profile is addressed. `SKILL.md`
// records those as unexamined.
//
// `packages` is not emitted either, and that is the field's shape rather than
// its size: a workspace glob is arbitrary project text with no type that could
// bound it. The row that reads a redacted copy still supplies them, so this
// adds evidence rather than replacing that row.
//
// The parser is vendored for the reason the TOML one is, and `vendor/README.md`
// records it. A file it refuses raises, and the engine turns that into a code:
// a YAML parser's message quotes the line and column it failed on, and a
// duplicate key is one of the files it refuses.
// The default catalog, selected the way pnpm selects it. It is written either as
// the top-level `catalog` or as `catalogs.default`, and a file that writes it
// both ways is one pnpm refuses outright rather than resolving.
//
// Reproduced against pnpm 11.24.0's bundle rather than taken from the shape of
// the file: `getCatalogsFromWorkspaceManifest` returns
// `{ default: manifest.catalog, ...manifest.catalogs }`, so the named form wins
// the spread, and `checkDefaultCatalogIsDefinedOnce` throws
// `INVALID_CATALOGS_CONFIGURATION` when `manifest.catalog != null &&
// manifest.catalogs?.default != null`. Reading only `catalog` reported no
// catalog for a file that has one, which is the wrong absence this closes.
//
// A file that defines it both ways is unreadable here rather than resolved to
// either one, which is this file's own rule for a thing declared twice and
// pnpm's behaviour at the same time.
function defaultCatalog(workspace) {
  // A bare `catalog` that is null is a workspace declaring no default catalog,
  // not one this reader could not read: pnpm's own validator returns for it
  // straight away (`assertValidWorkspaceManifestCatalog` opens with
  // `if (manifest.catalog == null) return`). The null under `catalogs.default`
  // below is the opposite case, which the sibling validator throws on by name,
  // and the asymmetry between the two nulls is pnpm's rather than this reader's.
  const bare = workspace.catalog === null ? undefined : workspace.catalog;
  const catalogs = workspace.catalogs;
  // absent, or null, which is what pnpm's spread of it contributes: nothing
  if (catalogs === undefined || catalogs === null) return bare;
  if (!isTable(catalogs)) return UNREADABLE_FIELD;
  // the spread only reaches `default` when the mapping has that key, and it
  // then wins whatever it holds — a null included, which is the case this
  // reader read as "not defined" and answered with the bare catalog
  if (!Object.hasOwn(catalogs, "default")) return bare;
  // Defined in both places. pnpm refuses such a file twice over: through
  // `checkDefaultCatalogIsDefinedOnce` when the named one is non-null, and
  // through `assertValidWorkspaceManifestCatalogs` when it is null, which that
  // validator names as its own case. Unreadable either way, rather than one of
  // the two picked here.
  if (bare !== undefined) return UNREADABLE_FIELD;
  // Whatever the named key holds, including a null or a scalar. `nested` turns
  // those into an unreadable field at the next step, which is the same answer
  // and reached by the rule this file already applies to a container.
  return catalogs.default;
}

// The line both YAML readers draw, after four rounds spent finding where it was:
//
//   A reader refuses a document it did not read whole. It does not refuse a
//   document the owning tool would reject for a reason outside the schema.
//
// The first half is why `parseDocument` is used rather than `parse`. A warning
// is not an error to this parser and does not raise, and an unresolved tag
// raises exactly that: `react: !foo ^18.3.1` warns, and `parse` hands back the
// scalar underneath as though the tag had not been written, so a value would be
// emitted with the part that made it unresolved dropped. A transform here may
// only drop a part it has recognised, and an unknown tag is the definition of
// one it has not.
//
// Any warning, not the ones over a projected node. Deciding which nodes a
// warning touched is a per-construct judgement, and this boundary exists to
// stop making those; `doc.warnings` is empty for every document the parser
// resolved, including one carrying a known tag such as `!!str`.
//
// The second half is what `SKILL.md` records under Not Examined: an entry no
// field addresses does not decide whether the ones it names are evidence, and
// that holds for every adapter here.
//
// `logLevel` at `error` still matters and is not redundant with this. It keeps
// the warning off stderr on the way, where Node's own handler would print the
// source line that raised it; it does not stop `doc.warnings` from carrying it.
// `silent` would have gone too far and suppressed `doc.errors` with it.
//
// `yamlDocument` owns `.yarnrc.yml`. Its duplicate-key check is made here
// rather than by that file's parser.
//
// `yaml` makes it in `mapIncludes`, which answers each new key with
// `items.some(...)` over the keys already read, so composing one mapping is
// quadratic in the number of keys it holds. Measured on the vendored 2.9.0:
// 10,000 short keys take 0.53s, 20,000 take 2.2s, 40,000 take 11s. No bound on
// the file's size bounds that, because the cost is in the count and not the
// bytes — those 40,000 keys are 457 KiB, well under any bound a lockfile could
// be given, and 4 MiB of them would be some 350,000 keys. A bound on the count
// itself would be a bound on the wrong thing in the other direction, since the
// counts that are slow are the counts a real monorepo's lockfile reaches.
//
// Skipping the check is not the alternative. `toJS` keeps the later of two
// duplicate keys, so a value could be emitted from a declaration that shadowed
// another one, which is the thing this reader must not do.
//
// So the check is turned off in the parser and made below in linear time. It
// uses the projection's own key comparison rather than copying either the
// parser's relation or the JavaScript conversion into this file. A shallow
// mirror keeps each mapping's keys and replaces its values with null. One
// `toJS` call projects every mirror with one shared alias context. If a
// mapping loses a property, two source keys collapsed to the same JavaScript
// object key and the original projection would have kept only the later one.
//
// This is deliberately stricter than `mapIncludes` in two measured cases.
// `mapIncludes` holds an Alias equal only to the same node, so `&dep react`
// beside `? *dep` passes the parser's check while `toJS` collapses both to
// `react`. It also holds the number `1` distinct from the string `"1"`, while
// an object stringifies both keys as `"1"`. The vendored 2.9.0 reproduced both
// results with `uniqueKeys: true` and no errors.
//
// The single projection also keeps this pass linear for alias keys.
// `Alias.resolve` walks the document to collect its anchors unless one context
// caches that walk. Measured on the vendored 2.9.0 with one context per call:
// 1,000 alias keys take 1.7s, 2,000 take 7.2s, and 4,000 take 28s in a 508 KiB
// file. One shared context takes those same 4,000 keys to 232ms.

function isYamlMergeKey(pair) {
  return (
    pair.key?.addToJSMap &&
    typeof pair.key.value === "symbol" &&
    pair.key.value.description === "<<"
  );
}

function assertUniqueKeys(doc) {
  const mirrors = [];
  const sourceSizes = [];
  YAML.visit(doc, {
    Map(_, node) {
      const mirror = new YAML.YAMLMap();
      let hasMergeKey = false;
      for (const pair of node.items) {
        if (!YAML.isPair(pair)) continue;
        // The vendored schemas give only the merge key its own projection.
        // It adds no object property of its own, so the key-only mirror leaves
        // it out after checking that the source mapping declared it once.
        if (isYamlMergeKey(pair)) {
          if (hasMergeKey) throw new Error("the document was not read whole");
          hasMergeKey = true;
          continue;
        }
        mirror.items.push(new YAML.Pair(pair.key));
      }
      mirrors.push(mirror);
      sourceSizes.push(mirror.items.length);
    },
  });
  const documentMirror = new YAML.YAMLSeq();
  documentMirror.items = mirrors;
  const projected = documentMirror.toJS(doc);
  for (let i = 0; i < projected.length; i += 1) {
    if (Object.keys(projected[i]).length !== sourceSizes[i]) {
      // the same fixed message `yamlDocument` raises, for the same reason: a
      // duplicate key is a key the projection would have dropped
      throw new Error("the document was not read whole");
    }
  }
}

function assertSingleMergeKey(doc) {
  YAML.visit(doc, {
    Map(_, node) {
      let hasMergeKey = false;
      for (const pair of node.items) {
        if (!YAML.isPair(pair) || !isYamlMergeKey(pair)) continue;
        if (hasMergeKey) throw new Error("the document was not read whole");
        hasMergeKey = true;
      }
    },
  });
}

function parsedYamlDocument(text, options = {}) {
  const doc = YAML.parseDocument(text, {
    logLevel: "error",
    uniqueKeys: false,
    ...options,
  });
  if (doc.errors.length > 0 || doc.warnings.length > 0) {
    // The engine turns this into a code. Nothing from the document is read out
    // of it, and its message is fixed rather than the parser's.
    throw new Error("the document was not read whole");
  }
  return doc;
}

function yamlDocument(text, options = {}) {
  const doc = parsedYamlDocument(text, options);
  // `uniqueKeys: false` is why this call is here rather than in `doc.errors`
  assertUniqueKeys(doc);
  return doc.toJS();
}

function pnpmYamlDocument(text) {
  // The preflight output is discarded. Its only job is to preserve the
  // resource limits that protect this audit before pnpm's parser projects the
  // document with its own scalar and collection-key semantics. Duplicate-key
  // semantics belong to that owning parser. The explicit merge-key check is
  // the one stricter source rule: pnpm combines repeated merge declarations,
  // while this reader refuses to discard either declaration.
  const preflight = parsedYamlDocument(text, { merge: true, schema: "core" });
  assertSingleMergeKey(preflight);
  preflight.toJS({ maxAliasCount: 100 });
  return loadPnpmYaml(text);
}

function readPnpmWorkspace(text) {
  const workspace = pnpmYamlDocument(text);
  // An empty document parses to `null`, and a document whose whole content is a
  // scalar or a sequence has no place a catalog could be. Neither says a catalog
  // was meant to be there, so neither is a field this reader failed to read.
  if (!isTable(workspace)) return { reason: "NO_EVIDENCE" };
  const catalog = defaultCatalog(workspace);
  return {
    fields: {
      react: nested(catalog, "react"),
      reactNative: nested(catalog, "react-native"),
      expo: nested(catalog, "expo"),
    },
  };
}

// `pnpm-lock.yaml`, read for the version that wrote it and for what the
// selected importer resolves.
//
// The versions come from `importers`, not from the `packages` keys, and that is
// the decision this reader rests on. A `packages` key spells a package as
// `name@version` — with a second `@` when the name is scoped, and in a shape
// that changed between lockfile versions — so reading a version out of one is
// string surgery on project text. An importer states the resolved version as its
// own scalar, so there is nothing to cut. It is also the more honest answer:
// `packages` is everything the store holds, including a transitive copy the app
// never resolves, while an importer is one app's own resolution.
//
// That leaves `packages` addressed by no field, which is why the fixture's
// credentialed `tarball` has no path out — the same reason a `resolved` URL has
// none in the npm lockfile above.
//
// Measured against pnpm 11.25.0 and against 35 `pnpm-lock.yaml` files on this
// machine: every one of them has an `importers` block, the root importer is
// named `.`, and every other one is named by its posix path relative to the
// lockfile.

// pnpm writes a resolved version with the peer dependencies it was resolved
// against appended as parenthesised groups, and those nest. Measured in a real
// workspace on this machine:
// `0.86.2(@babel/core@7.29.7(supports-color@8.1.1))(@types/react@19.2.18)(react@19.2.3)`.
// A patch declaration is written as one more group, `(patch_hash=…)`.
//
// The version is what precedes them, and the groups are consumed one at a time
// so that the tail has to end exactly where the string does. Cutting at the
// first `(` alone would drop whatever followed the last group without reading
// it, which is the failure `packageManagerPin` states for build metadata: a
// transform may only drop a part it has recognised. A tail this cannot consume
// leaves the value unchanged for the type to reject rather than repaired.
//
// What is inside a group is not read, and that is pnpm's boundary rather than a
// gap here. Its own `indexOfDepPathSuffix` requires the string to end in `)`,
// scans back for the balancing `(`, and cuts there without inspecting what it
// cut: `parseDepPath` calls the remainder `peerDepGraphHash`, an identity that
// is a run of `name@version` groups in one release and a hash in another, with
// `(patch_hash=…)` as one more group. A grammar for the contents would be a
// grammar pnpm does not have, and it would refuse output pnpm writes.
//
// Against that reader this one is equal or stricter, never looser, which is the
// direction that matters. `0.74.5(a)x(b)` is `0.74.5(a)x` to pnpm, because its
// backward scan stops at the `x`; here the forward scan finds a character where
// a group should begin and keeps the whole value for the type to reject. Neither
// reports `0.74.5`.
function withoutPeerSuffix(version) {
  // a version that is present and not a string is handed on for the type to
  // reject, the way a declared range is
  if (typeof version !== "string") return version;
  const start = version.indexOf("(");
  if (start === -1) return version;
  let at = start;
  while (at < version.length) {
    // between two groups, or after the last one, there is nothing else
    if (version[at] !== "(") return version;
    let depth = 0;
    do {
      if (version[at] === "(") depth += 1;
      else if (version[at] === ")") depth -= 1;
      at += 1;
    } while (at < version.length && depth > 0);
    // a group the string ended in the middle of
    if (depth !== 0) return version;
  }
  return version.slice(0, start);
}

// The importer the caller asked about, as the entry itself or as the sentinel.
//
// One importer is the answer without being told which, and that is the same
// reading the npm lockfile takes of a file describing one package. Several are
// the question `--app-dir` exists to answer, and picking between them here is
// the guess three review rounds removed from that reader.
function selectedImporter(importers, app) {
  if (!isTable(importers)) return UNREADABLE_FIELD;
  const ids = Object.keys(importers);
  if (app === undefined) {
    return ids.length === 1 ? importers[ids[0]] : UNREADABLE_FIELD;
  }
  // an app that cannot be written as a key at all, which is the one case no
  // lookup can answer
  if (app === null) return UNREADABLE_FIELD;
  // `appRelative` writes the lockfile's own directory as the empty string;
  // pnpm writes that importer as `.`
  const id = app === "" ? "." : app;
  // The map is the check, and a leading `..` is not disqualifying here the way
  // it is for an npm lockfile. pnpm's `getLockfileImporterId` is
  // `path.relative(lockfileDir, projectDir)`, so `pnpm install --lockfile-dir`
  // writes an id above the lockfile whenever the lockfile does not sit at or
  // above the project. Reproduced on pnpm 11.25.0: a lockfile written into a
  // subdirectory of its project got `../../…/proj` as the importer id. Refusing
  // those would mark every field uncertain for a project whose resolution the
  // file plainly holds.
  return Object.hasOwn(importers, id) ? importers[id] : UNREADABLE_FIELD;
}

// The version one importer resolved for a package, collected the way a declared
// range is: from the three blocks that can name the app's own copy, with a
// second differing answer leaving the file unresolved rather than ordered.
//
// A dependency is written as `{ specifier, version }`, which is the shape
// lockfile version 9.0 declares. Nothing here re-checks that, because the
// caller has: `readPnpmLockfile` reads no importer at all under a version
// outside the closed set, so this function only ever sees the layout it was
// written for. An older lockfile writes the resolved version as the value
// itself and keeps the specifiers in a sibling map, and it would come back
// unreadable here too — but that is a second answer to the same question, not
// the one the guard rests on.
function importerBlocks(importer, name) {
  if (!isTable(importer)) return UNREADABLE_FIELD;
  const found = new Set();
  let unreadable = false;
  for (const field of DECLARATION_FIELDS) {
    const block = importer[field];
    // absent: this block says nothing about the package
    if (block === undefined) continue;
    if (!isTable(block)) {
      unreadable = true;
      continue;
    }
    if (!Object.hasOwn(block, name)) continue;
    const version = nested(block[name], "version");
    // present and holding no version this reader can read, which is not the
    // same as the package not being there
    if (version === undefined || version === UNREADABLE_FIELD) {
      unreadable = true;
      continue;
    }
    found.add(version);
  }
  if (unreadable || found.size > 1) return UNREADABLE_FIELD;
  return found.size === 1 ? withoutPeerSuffix([...found][0]) : undefined;
}

function resolvedVersion(importer, name) {
  if (importer === UNREADABLE_FIELD) return UNREADABLE_FIELD;
  return importerBlocks(importer, name);
}

function readPnpmLockfile(text, context) {
  const lockfile = pnpmYamlDocument(text);
  // An empty document, a scalar or a sequence: no place any of this could be
  // declared, and nothing said about the lockfile in either direction.
  if (!isTable(lockfile)) return { reason: "NO_EVIDENCE" };
  // The version is a guard before it is a field. What an importer holds is what
  // its lockfile version declares, so reading one under a version this reader
  // has not established would emit a value whose correctness depends on the
  // field beside it that was rejected. That coupling is the one
  // `packageManagerPin` refuses to split: a name the set does not hold, with
  // its version still emitted, reads as a definite version of something
  // unidentified. Outside the set every version field is unreadable instead.
  //
  // A missing version is outside it too, and that is not a second rule: pnpm's
  // own test for one of these objects opens with `"lockfileVersion" in obj`, so
  // a file without one has a version this reader could not read rather than
  // none at all. `readYarnLockfile` gives a missing generation stamp the same
  // reading.
  const declared = lockfile.lockfileVersion ?? UNREADABLE_FIELD;
  const importer = PNPM_LOCKFILE_VERSIONS.has(declared)
    ? selectedImporter(lockfile.importers, context?.absoluteApp ?? context?.app)
    : UNREADABLE_FIELD;
  return {
    fields: {
      lockfileVersion: declared,
      react: resolvedVersion(importer, "react"),
      reactNative: resolvedVersion(importer, "react-native"),
      expo: resolvedVersion(importer, "expo"),
    },
  };
}

// `.yarnrc.yml`, read for the linker it declares and for nothing else.
//
// This is the file the earlier command table could not print safely: it holds
// `npmAuthToken` and a registry URL with credentials in it, which is why the row
// that reads it takes named keys out of a redacted copy. A schema naming one
// field needs neither the copy nor the key list, because `npmAuthToken` has no
// field and so has no path out, whatever a project calls it.
//
// It replaces a validator that checked shape. `detectInstallMode` in
// `rn-upgrade-pulse.mjs` accepts `[\\w-]+` for this value, so a `.yarnrc.yml`
// holding `nodeLinker: ghp_realLookingToken123` emits that token as the linker
// with `ambiguous` false. That was measured on this branch rather than read off
// the spec section that records it. A supported linker is a member of a closed
// set, and `node-linker` in `evidence.mjs` is that set.
//
// The field is `declaredLinker` rather than `linker`, and the name is doing work
// while both readers exist. This one reads a single file and reports what that
// file declares; `detectInstallMode` walks the ancestors and merges them, and
// its `installMode.linker` is the effective setting the Evidence Rules read.
// Until that walk moves here, a name that survives being quoted out of context
// is worth more than matching the other one.
export function readYarnrc(text) {
  const config = yamlDocument(text);
  // Empty, a scalar, or a sequence: no place a setting could be declared, and
  // nothing said about the linker in either direction.
  if (!isTable(config)) return { reason: "NO_EVIDENCE" };
  return { fields: { declaredLinker: nested(config, "nodeLinker") } };
}

const YARNRC = {
  kind: "yarnrc",
  accepts: [".yarnrc.yml"],
  schema: { declaredLinker: "node-linker" },
  read: readYarnrc,
};

const PNPM_LOCKFILE = {
  kind: "pnpm-lockfile",
  accepts: ["pnpm-lock.yaml"],
  // A lockfile is legitimately large, for the reason the npm one states, and
  // this reader's duplicate checks stay linear at the scale covered by its
  // lockfile regression.
  maxBytes: 32 * 1024 * 1024,
  schema: {
    lockfileVersion: "pnpm-lockfile-version",
    react: "exact-version",
    reactNative: "exact-version",
    expo: "exact-version",
  },
  read: readPnpmLockfile,
};

const PNPM_WORKSPACE = {
  kind: "pnpm-workspace",
  accepts: ["pnpm-workspace.yaml"],
  schema: {
    react: "dependency-range",
    reactNative: "dependency-range",
    expo: "dependency-range",
  },
  read: readPnpmWorkspace,
};

export const ADAPTERS = [
  NPM_MANIFEST,
  NPM_LOCKFILE,
  YARN_LOCKFILE,
  EAS_CONFIG,
  PNPM_LOCKFILE,
  PNPM_WORKSPACE,
  YARNRC,
  { ...NODE_PIN, accepts: [".nvmrc"], read: readNvmrc },
  { ...NODE_PIN, accepts: [".node-version"], read: readNodeVersion },
  { ...NODE_PIN, accepts: [".tool-versions"], read: readToolVersions },
  { ...NODE_PIN, accepts: MISE_ACCEPTS, read: readMiseConfig },
];
