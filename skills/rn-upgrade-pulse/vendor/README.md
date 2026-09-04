# Vendored dependencies

This skill is installed by cloning the plugin, and nothing runs `npm install` afterwards.
A dependency therefore arrives in the tree or it does not arrive at all.

Each directory below holds one published package, copied unmodified from its npm tarball.
Nothing here is written or edited by this repository: a change to a vendored file is an upgrade, performed by replacing the directory with a newer tarball's files and updating its row.
`.trunk/trunk.yaml` keeps the formatter off these paths for the same reason, so a copy stays byte-identical to what was published.

| Directory    | Package                   | License      | Copied                                      | Tarball integrity                                                                                  |
| ------------ | ------------------------- | ------------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `js-yaml/`   | `@zkochan/js-yaml@0.0.11` | MIT          | `dist/js-yaml.mjs`, `package.json`, `LICENSE` | `sha512-SO+h5Jg079r2JvGle0jbdtk1EY7ppu6TGzmfWTp3Gy61IEb1OVKBocJ6ydTn4++nYFNfRKYenI2MniZQwsM9KQ==` |
| `smol-toml/` | `smol-toml@1.8.0`         | BSD-3-Clause | `dist/*.js`, `package.json`, `LICENSE`      | `sha512-kCZr2V3ch9i00x8zXRhjUNVcjG9ijES5dDudkXvUVCT5QlJNQWElSJdZqyPemffHoLNUYwOcou0Fy+ojN0uHSQ==` |
| `yaml/`      | `yaml@2.9.0`              | ISC          | `dist/**/*.js`, `package.json`, `LICENSE`   | `sha512-2AvhNX3mb8zd6Zy7INTtSpl1F15HW6Wnqj0srWlkKLcpYl/gMIMJiyuGq2KeI2YFxUPjdlB+3Lc10seMLtL4cA==` |

The copy rule for `smol-toml` and `yaml` is a rule rather than a file list: every `.js` file under the tarball's `dist`, at the path the tarball puts it at, plus `package.json` and `LICENSE`.
That takes the package's own entry and every module it loads, and leaves out the type declarations, a build outside `dist` such as `yaml`'s browser bundle, and anything under `dist` that is not `.js` — `smol-toml`'s CommonJS bundle and `yaml`'s CLI entry are both dropped that way, and neither is loaded from here.
`@zkochan/js-yaml` is different because `dist/js-yaml.mjs` is its self-contained ESM bundle.
That copy needs no transitive dependency at runtime.
Its `package.json` and `LICENSE` remain beside it for provenance.

The tarball's layout is preserved rather than flattened, and `package.json` is copied rather than dropped, because that file is what declares the module format of the `.js` files beside it — `"type": "module"` for one of these packages and `"type": "commonjs"` for the other.
Without it Node has no declared format for them: it either infers one from their syntax, which only the releases carrying module-syntax detection do, or falls back and fails the import.
`SKILL.md` supports Node 18.3.0 and later, and detection is not in every release of that range.
Measured with `node --no-experimental-detect-module`, which is how a release without detection behaves: on 20.20.2 and on 24.20.0 the flattened form fails to start and this layout runs.
A declared format also survives whatever sits above the plugin, which an installed copy cannot choose — it lives in a cache directory on someone else's machine, and an ancestor `package.json` saying `"type": "commonjs"` breaks the flattened form on 24.20.0 with detection left on.
`evidence.test.mjs` runs the CLI under such an ancestor, under both declarations, which is the check that fails if either `package.json` here goes missing.
Both declarations are needed: an ancestor exposes only the package whose need it contradicts, so a test under `commonjs` alone passes with `yaml`'s declaration deleted, and one under `module` alone passes with `smol-toml`'s deleted.
The `js-yaml` entry uses the `.mjs` extension, so its module format does not depend on an ancestor or on its copied `package.json`.

A package declaring `"type": "commonjs"` is imported by its default export rather than by name, because named exports out of CommonJS depend on the loader detecting them and the declaration is the thing there is no detection question about.

To reproduce a copy, with `<name>` and `<version>` from its row:

```bash
npm pack <name>@<version> --pack-destination "$TMPDIR"
tar xzf "$TMPDIR/<name>-<version>.tgz" -C "$TMPDIR"
dest=skills/rn-upgrade-pulse/vendor/<name>
rsync -a --include='*/' --include='*.js' --exclude='*' "$TMPDIR/package/dist/" "$dest/dist/"
cp "$TMPDIR/package/package.json" "$TMPDIR/package/LICENSE" "$dest/"
```

For `@zkochan/js-yaml`, copy the self-contained ESM bundle and its provenance files:

```bash
npm pack @zkochan/js-yaml@0.0.11 --pack-destination "$TMPDIR"
tar xzf "$TMPDIR/zkochan-js-yaml-0.0.11.tgz" -C "$TMPDIR"
dest=skills/rn-upgrade-pulse/vendor/js-yaml
mkdir -p "$dest/dist"
cp "$TMPDIR/package/dist/js-yaml.mjs" "$dest/dist/"
cp "$TMPDIR/package/package.json" "$TMPDIR/package/LICENSE" "$dest/"
```

`npm pack` verifies what it downloads against the registry's own integrity for that exact version, and the row records that value, so a tarball that no longer matches is visible here rather than only in a fetch that fails.
The copy itself is checked by re-running that `rsync` into an empty directory and comparing it with `diff -r`, which must print nothing.
Comparing against the tarball's `dist` directly does not work as a check, because it reports every file the rule leaves out and a real difference reads the same as those.
