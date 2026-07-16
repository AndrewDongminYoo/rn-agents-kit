#!/usr/bin/env bash
# Capture the screen of a connected device/simulator to a predictable PNG path
# so an agent can Read it immediately and verify what actually rendered.
#
# Usage:
#   device-shot.sh [-s <serial>] [-u <udid>] [target] [out.png]
#     target : auto (default) | android | sim | ios
#       android : Android device/emulator (adb)
#       sim     : booted iOS simulator (xcrun simctl)
#       ios     : iOS 17+ physical device (pymobiledevice3 + a sudo tunnel daemon)
#       auto    : android -> ios device -> sim; first connected target wins
#     out.png  : output path; explicit path is used verbatim (may overwrite). If omitted, defaults to logs/screenshot.png, or a timestamped name when that already exists (never clobbers a prior capture).
#     -s <serial> : pick a specific adb device when several are attached
#     -u <udid>   : pick a specific iOS device when several are attached (else multi-device fails fast)
set -euo pipefail

# pipx-installed pymobiledevice3 is often not on PATH; add the common location.
export PATH="${HOME}/.local/bin:${PATH}"

IOS_ERR="$(mktemp)"
trap 'rm -f "${IOS_ERR}"' EXIT

usage() {
	sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
}

ADB_SERIAL=""
IOS_UDID=""
while [[ ${1-} == "-s" || ${1-} == "-u" ]]; do
	case "$1" in
	-s)
		[[ -n ${2-} ]] || {
			echo "[device-shot] -s requires a serial argument." >&2
			exit 1
		}
		ADB_SERIAL="${2}"
		shift 2
		;;
	-u)
		[[ -n ${2-} ]] || {
			echo "[device-shot] -u requires a UDID argument." >&2
			exit 1
		}
		IOS_UDID="${2}"
		shift 2
		;;
	esac
done

case "${1-}" in
-h | --help | help)
	usage
	exit 0
	;;
esac

TARGET="${1:-auto}"

# Output path. An explicit second arg is used verbatim (it may overwrite). When
# no path is given, default to logs/screenshot.png; if that file already exists,
# use a timestamped name, bumping a counter until the name is free so a prior
# capture is never clobbered (covers same-second runs and stale timestamped files).
if [[ -n ${2-} ]]; then
	OUT="${2}"
elif [[ -e "logs/screenshot.png" ]]; then
	ts="$(date +%Y%m%d-%H%M%S)"
	OUT="logs/screenshot-${ts}.png"
	n=2
	while [[ -e ${OUT} ]]; do
		OUT="logs/screenshot-${ts}-${n}.png"
		n=$((n + 1))
	done
else
	OUT="logs/screenshot.png"
fi

adb_cmd() {
	if [[ -n ${ADB_SERIAL} ]]; then
		adb -s "${ADB_SERIAL}" "$@"
	else
		adb "$@"
	fi
}

# Count Android targets in state "device" (ignores the header line and any
# offline/unauthorized entries).
android_device_count() {
	adb devices 2>/dev/null | awk 'NR>1 && $2 == "device" { n++ } END { print n + 0 }'
}

has_android() {
	command -v adb >/dev/null 2>&1 || return 1
	[[ -n ${ADB_SERIAL} ]] && return 0
	[[ "$(android_device_count)" -ge 1 ]]
}

has_ios_device() {
	command -v pymobiledevice3 >/dev/null 2>&1 &&
		pymobiledevice3 usbmux list 2>/dev/null | grep -q '"ConnectionType": "USB"'
}

# Count USB-attached iOS devices (one "ConnectionType": "USB" entry each).
ios_device_count() {
	command -v pymobiledevice3 >/dev/null 2>&1 || {
		echo 0
		return
	}
	pymobiledevice3 usbmux list 2>/dev/null | grep -c '"ConnectionType": "USB"'
}

has_sim() {
	xcrun simctl list devices booted 2>/dev/null | grep -q "(Booted)"
}

# A valid capture is a non-empty file beginning with the 8-byte PNG signature.
validate_png() {
	[[ -s $1 ]] || return 1
	local sig
	sig="$(head -c 8 "$1" | od -An -tx1 | tr -d ' \n')"
	[[ ${sig} == "89504e470d0a1a0a" ]]
}

finalize() {
	if ! validate_png "${OUT}"; then
		rm -f "${OUT}"
		echo "[device-shot] capture produced no valid PNG; removed broken output." >&2
		return 1
	fi
	echo "${OUT}"
}

capture_android() {
	if [[ -z ${ADB_SERIAL} ]]; then
		local n
		n="$(android_device_count)"
		if [[ ${n} -eq 0 ]]; then
			echo "[device-shot] no Android device connected." >&2
			return 1
		fi
		if [[ ${n} -ge 2 ]]; then
			echo "[device-shot] ${n} Android devices connected; pass -s <serial> to choose one:" >&2
			adb devices >&2
			return 1
		fi
	fi
	echo "[device-shot] capturing Android..." >&2
	adb_cmd exec-out screencap -p >"${OUT}"
}

capture_sim() {
	echo "[device-shot] capturing iOS simulator..." >&2
	xcrun simctl io booted screenshot "${OUT}" >/dev/null
}

# Run the iOS screenshot, pinning a specific tunneled device when -u was given.
ios_screenshot() {
	if [[ -n ${IOS_UDID} ]]; then
		pymobiledevice3 developer dvt screenshot --tunnel "${IOS_UDID}" "${OUT}" 2>"${IOS_ERR}"
	else
		pymobiledevice3 developer dvt screenshot "${OUT}" 2>"${IOS_ERR}"
	fi
}

capture_ios() {
	# With several iOS devices and no -u, pymobiledevice3 would prompt for a
	# selection and hang in a non-interactive shell — fail fast instead.
	if [[ -z ${IOS_UDID} ]]; then
		local n
		n="$(ios_device_count)"
		if [[ ${n} -ge 2 ]]; then
			echo "[device-shot] ${n} iOS devices connected; pass -u <udid> to choose one" >&2
			echo "[device-shot] (without it pymobiledevice3 prompts interactively and hangs here)." >&2
			pymobiledevice3 usbmux list >&2 2>/dev/null || true
			return 1
		fi
	fi
	echo "[device-shot] capturing iOS device..." >&2
	if ! ios_screenshot; then
		cat "${IOS_ERR}" >&2
		cat >&2 <<'EOF'

[device-shot] iOS device capture failed.
  iOS 17+ devices need a RemoteXPC tunnel running.
  In a separate terminal (leave it open), run:

      sudo pymobiledevice3 remote tunneld

  then retry.
EOF
		return 1
	fi
}

mkdir -p "$(dirname "${OUT}")"

dispatch() {
	case "${TARGET}" in
	android) capture_android ;;
	sim) capture_sim ;;
	ios) capture_ios ;;
	auto)
		if has_android; then
			capture_android
		elif has_ios_device && capture_ios; then
			:
		elif has_sim; then
			capture_sim
		else
			echo "[device-shot] no connected device/simulator found (android/ios/sim)." >&2
			return 1
		fi
		;;
	*)
		echo "[device-shot] unknown target: ${TARGET} (auto|android|sim|ios)" >&2
		return 1
		;;
	esac
}

if dispatch; then
	finalize
else
	rc=$?
	# A capture tool may have exited non-zero after the shell already truncated
	# OUT to 0 bytes via redirect; remove any invalid partial artifact.
	if [[ -e ${OUT} ]] && ! validate_png "${OUT}"; then
		rm -f "${OUT}"
		echo "[device-shot] capture produced no valid PNG; removed broken output." >&2
	fi
	exit "${rc}"
fi
