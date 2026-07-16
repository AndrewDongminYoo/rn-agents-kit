#!/usr/bin/env bash
# Dev-only verification for device-shot.sh. Drives each branch with PATH stubs;
# no real device required. Run: bash skills/rn-device-capture/test-device-shot.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="${HERE}/device-shot.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

BIN="${WORK}/bin"
mkdir -p "${BIN}"

# 8-byte PNG signature + a trivial payload, written by the "good" stubs.
# shellcheck disable=SC2329
# Invoked from generated stub scripts via `export -f`; not called directly here.
write_png() {
	printf '\x89PNG\r\n\x1a\n' >"$1"
	printf 'ok' >>"$1"
}
export -f write_png

fail() {
	echo "FAIL: $1" >&2
	exit 1
}

make_stub() { # name, body
	cat >"${BIN}/$1"
	chmod +x "${BIN}/$1"
}

reset_stubs() { rm -f "${BIN:?}"/*; }

run() { # target out -> runs SUT with stub PATH, returns its exit code
	# HOME is overridden so device-shot.sh's `export PATH="${HOME}/.local/bin:${PATH}"` resolves
	# to a nonexistent dir, keeping the stub BIN authoritative for all tool lookups.
	(cd "${WORK}" && HOME="${WORK}" PATH="${BIN}:${PATH}" bash "${SUT}" "$@") 2>"${WORK}/err.txt"
}

# --- Case A: two Android devices -> ambiguity, non-zero, no artifact ---
reset_stubs
make_stub adb <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == "devices" ]]; then
  printf 'List of devices attached\nAAAA\tdevice\nBBBB\tdevice\n'
  exit 0
fi
exit 0
STUB
if run android "${WORK}/a.png"; then fail "two-device case should be non-zero"; fi
grep -q "pass -s <serial>" "${WORK}/err.txt" || fail "two-device case missing -s hint"
[[ ! -e "${WORK}/a.png" ]] || fail "two-device case must not write an artifact"

# --- Case B: 0-byte capture -> PNG validation rejects + removes output ---
reset_stubs
make_stub adb <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == "devices" ]]; then printf 'List of devices attached\nAAAA\tdevice\n'; exit 0; fi
# exec-out screencap -p : emit nothing (simulate a broken capture)
exit 0
STUB
if run android "${WORK}/b.png"; then fail "0-byte capture should be non-zero"; fi
grep -q "no valid PNG" "${WORK}/err.txt" || fail "0-byte case missing validation message"
[[ ! -e "${WORK}/b.png" ]] || fail "0-byte case must remove the broken artifact"

# --- Case C: single Android device, valid PNG -> stdout is the path ---
reset_stubs
make_stub adb <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == "devices" ]]; then printf 'List of devices attached\nAAAA\tdevice\n'; exit 0; fi
if [[ "$1" == "exec-out" ]]; then write_png /dev/stdout; exit 0; fi
exit 0
STUB
OUT_PATH="$(run android "${WORK}/c.png")" || fail "valid capture should succeed"
[[ ${OUT_PATH} == "${WORK}/c.png" ]] || fail "stdout must be the saved path, got: ${OUT_PATH}"
[[ -s "${WORK}/c.png" ]] || fail "valid capture must leave a PNG"

# --- Case D: iOS device tunnel down -> guidance + non-zero ---
reset_stubs
make_stub adb <<'STUB'
#!/usr/bin/env bash
[[ "$1" == "devices" ]] && { printf 'List of devices attached\n'; exit 0; }
exit 0
STUB
make_stub pymobiledevice3 <<'STUB'
#!/usr/bin/env bash
[[ "$1" == "usbmux" ]] && { printf '[{"ConnectionType": "USB"}]\n'; exit 0; }
# developer dvt screenshot : fail (tunnel missing)
echo "RemoteXPC tunnel not found" >&2
exit 1
STUB
if run ios "${WORK}/d.png"; then fail "ios tunnel-down should be non-zero"; fi
grep -q "remote tunneld" "${WORK}/err.txt" || fail "ios case missing tunnel setup guidance"

# --- Case E: auto falls back to sim when android absent AND ios fails ---
reset_stubs
make_stub adb <<'STUB'
#!/usr/bin/env bash
[[ "$1" == "devices" ]] && { printf 'List of devices attached\n'; exit 0; }
exit 0
STUB
make_stub pymobiledevice3 <<'STUB'
#!/usr/bin/env bash
[[ "$1" == "usbmux" ]] && { printf '[{"ConnectionType": "USB"}]\n'; exit 0; }
# developer dvt screenshot : fail (tunnel missing) so auto falls through to sim
echo "RemoteXPC tunnel not found" >&2
exit 1
STUB
make_stub xcrun <<'STUB'
#!/usr/bin/env bash
# simctl list devices booted
if [[ "$2" == "list" ]]; then echo "iPhone 15 (XXXX) (Booted)"; exit 0; fi
# simctl io booted screenshot <path>
if [[ "$2" == "io" ]]; then write_png "${!#}"; exit 0; fi
exit 0
STUB
OUT_PATH="$(run auto "${WORK}/e.png")" || fail "auto should fall back to sim and succeed"
[[ -s "${WORK}/e.png" ]] || fail "auto-sim fallback must leave a PNG"

# --- Case F: single device, capture tool exits non-zero -> 0-byte file removed ---
reset_stubs
make_stub adb <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == "devices" ]]; then printf 'List of devices attached\nAAAA\tdevice\n'; exit 0; fi
if [[ "$1" == "exec-out" ]]; then exit 1; fi   # fails AFTER the shell truncated OUT to 0 bytes
exit 0
STUB
if run android "${WORK}/f.png"; then fail "tool-failure case should be non-zero"; fi
grep -q "removed broken output" "${WORK}/err.txt" || fail "tool-failure case missing removal message"
[[ ! -e "${WORK}/f.png" ]] || fail "tool-failure case must remove the 0-byte artifact"

# --- Case G: no out path given -> logs/screenshot.png first, timestamped on collision (no clobber) ---
reset_stubs
make_stub adb <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == "devices" ]]; then printf 'List of devices attached\nAAAA\tdevice\n'; exit 0; fi
if [[ "$1" == "exec-out" ]]; then write_png /dev/stdout; exit 0; fi
exit 0
STUB
G1="$(run android)" || fail "first default-path capture should succeed"
[[ ${G1} == "logs/screenshot.png" ]] || fail "first default capture must be logs/screenshot.png, got: ${G1}"
[[ -s "${WORK}/logs/screenshot.png" ]] || fail "first default capture must leave logs/screenshot.png"
G2="$(run android)" || fail "second default-path capture should succeed"
[[ ${G2} != "logs/screenshot.png" ]] || fail "second default capture must not reuse logs/screenshot.png"
case "${G2}" in logs/screenshot-*.png) : ;; *) fail "second default capture must be a timestamped name, got: ${G2}" ;; esac
[[ -s "${WORK}/${G2}" ]] || fail "second default capture must leave its timestamped file"
[[ -s "${WORK}/logs/screenshot.png" ]] || fail "second default capture must not clobber the first capture"

# --- Case H: multiple iOS devices, no -u -> fail fast (never invokes the blocking prompt) ---
reset_stubs
make_stub pymobiledevice3 <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == "usbmux" ]]; then
  printf '[\n  {"ConnectionType": "USB"},\n  {"ConnectionType": "USB"}\n]\n'
  exit 0
fi
# A real pymobiledevice3 would prompt here and hang; flag it if reached.
if [[ "$1" == "developer" ]]; then echo "SCREENSHOT-SHOULD-NOT-RUN" >&2; exit 0; fi
exit 0
STUB
if run ios "${WORK}/h.png"; then fail "multi-iOS-device case should be non-zero"; fi
grep -q "pass -u <udid>" "${WORK}/err.txt" || fail "multi-iOS case missing -u hint"
if grep -q "SCREENSHOT-SHOULD-NOT-RUN" "${WORK}/err.txt"; then fail "multi-iOS case must not invoke screenshot (would hang)"; fi
[[ ! -e "${WORK}/h.png" ]] || fail "multi-iOS case must not write an artifact"

# --- Case I: -u <udid> bypasses the multi-device guard so capture proceeds ---
reset_stubs
make_stub pymobiledevice3 <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == "usbmux" ]]; then
  printf '[\n  {"ConnectionType": "USB"},\n  {"ConnectionType": "USB"}\n]\n'
  exit 0
fi
# developer dvt screenshot [--tunnel <udid>] <out> : write to the last arg
if [[ "$1" == "developer" ]]; then write_png "${!#}"; exit 0; fi
exit 0
STUB
OUT_PATH="$(run -u ABC123 ios "${WORK}/i.png")" || fail "-u should bypass the multi-device guard and succeed"
[[ ${OUT_PATH} == "${WORK}/i.png" ]] || fail "-u case stdout must be the saved path, got: ${OUT_PATH}"
[[ -s "${WORK}/i.png" ]] || fail "-u case must leave a PNG"

# --- Case J: timestamped default name already taken -> counter keeps it unique (no clobber) ---
reset_stubs
make_stub adb <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == "devices" ]]; then printf 'List of devices attached\nAAAA\tdevice\n'; exit 0; fi
if [[ "$1" == "exec-out" ]]; then write_png /dev/stdout; exit 0; fi
exit 0
STUB
make_stub date <<'STUB'
#!/usr/bin/env bash
echo "20990101-000000"
STUB
(cd "${WORK}" && rm -rf logs && mkdir -p logs && : >logs/screenshot.png && : >logs/screenshot-20990101-000000.png)
J="$(run android)" || fail "collision-loop capture should succeed"
[[ ${J} == "logs/screenshot-20990101-000000-2.png" ]] || fail "collision must bump to -2, got: ${J}"
[[ -s "${WORK}/logs/screenshot-20990101-000000-2.png" ]] || fail "collision-loop must leave the -2 PNG"
[[ -e "${WORK}/logs/screenshot.png" ]] || fail "collision-loop must not clobber screenshot.png"
[[ -e "${WORK}/logs/screenshot-20990101-000000.png" ]] || fail "collision-loop must not clobber the existing timestamped file"

echo "ALL PASS"
