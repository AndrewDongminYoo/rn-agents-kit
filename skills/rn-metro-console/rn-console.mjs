#!/usr/bin/env node
// Capture React Native console output from Metro's Chrome DevTools Protocol (CDP)
// endpoint and print it for an agent to read. Bounded by default so a caller is
// never blocked; pass --follow to stream until interrupted.
//
// Usage:
//   node rn-console.mjs [options]
//     --level,    -l  log|info|warn|error|all   filter by level (default all)
//     --filter,   -f  <substring>               case-insensitive message filter
//     --device,   -d  <substring>               pick target by device name / app id
//     --duration, -t  <seconds>                 bounded: stop after N seconds (default 10)
//     --max,      -m  <count>                    bounded: stop after N matching logs
//     --follow,   -F                             stream unbounded (until Ctrl-C)
//     --host,     -H  <host:port>                Metro host (default localhost:8081)
//     --help,     -h
//   Run from the project root so a 'ws' fallback resolves from node_modules.
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const DEFAULT_HOST = "localhost:8081";
const DEFAULT_DURATION_S = 10;
const RESET = "\x1b[0m";
const COLORS = {
  log: "\x1b[37m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const REACT_NATIVE_APP_TARGET = /\b(?:hermes\s+)?react\s+native\b/i;
const AUXILIARY_TARGET = /\b(?:reanimated|page=-1|do not use|don.?t use)\b/i;

// CDP reports console.warn events as type "warning"; expose the friendly "warn".
export function normalizeType(cdpType) {
  return cdpType === "warning" ? "warn" : cdpType;
}

// Decode CDP RemoteObject args into a single plain string (ANSI stripped).
export function formatArgs(cdpArgs) {
  return (cdpArgs ?? [])
    .map((a) => {
      if (a == null) return "";
      if (a.type === "string") return a.value ?? "";
      if (a.description != null) return a.description;
      if (a.value !== undefined) return String(a.value);
      return JSON.stringify(a);
    })
    .join(" ")
    .replace(ANSI, "");
}

function targetDescriptor(t) {
  return [t?.title, t?.description, t?.url, t?.webSocketDebuggerUrl]
    .filter(Boolean)
    .join(" ");
}

function isReactNativeAppTarget(t) {
  const text = targetDescriptor(t);
  return REACT_NATIVE_APP_TARGET.test(text) && !AUXILIARY_TARGET.test(text);
}

function matchesDevice(t, device) {
  const query = device.toLowerCase();
  return [t?.deviceName, t?.appId].some((value) =>
    String(value ?? "")
      .toLowerCase()
      .includes(query),
  );
}

// Prefer the RN app target within the device/appId match; fall back to first.
export function selectTarget(targets, device) {
  if (!Array.isArray(targets) || targets.length === 0) return null;
  const query = String(device ?? "").trim();
  const candidates = query
    ? targets.filter((t) => matchesDevice(t, query))
    : targets;
  const pool = candidates.length > 0 ? candidates : targets;
  return pool.find(isReactNativeAppTarget) ?? pool[0];
}

// Should this event be emitted given the level/filter options?
export function matches(type, text, { level, filter }) {
  if (level && level !== "all" && type !== level) return false;
  if (!text || !text.trim()) return false;
  if (filter && !text.toLowerCase().includes(filter.toLowerCase()))
    return false;
  return true;
}

function pad(n, w = 2) {
  return String(n).padStart(w, "0");
}

export function formatLine(type, text, timestamp, useColor) {
  const d = new Date(timestamp ?? 0);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  const line = `[${time}] [${type.toUpperCase().padEnd(5)}] ${text}`;
  if (!useColor) return line;
  return `${COLORS[type] ?? COLORS.log}${line}${RESET}`;
}

// Prefer the built-in WebSocket (Node >= 22); else the project's ws; else null.
async function resolveWebSocket() {
  if (typeof globalThis.WebSocket === "function") return globalThis.WebSocket;
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(`${process.cwd()}/package.json`);
    return require("ws");
  } catch {
    return null;
  }
}

// Wire open/message/close/error uniformly across the built-in WebSocket
// (EventTarget: addEventListener, message event carries .data) and the `ws`
// package (EventEmitter: .on, message handler receives the raw data).
function wire(ws, { onOpen, onMessage, onClose, onError }) {
  const toText = (d) =>
    typeof d === "string" ? d : (d?.toString?.("utf8") ?? "");
  if (typeof ws.on === "function") {
    ws.on("open", () => onOpen(ws));
    ws.on("message", (d) => onMessage(toText(d)));
    ws.on("close", () => onClose());
    ws.on("error", (e) => onError(e?.message ?? "websocket error"));
  } else {
    ws.addEventListener("open", () => onOpen(ws));
    ws.addEventListener("message", (e) => onMessage(toText(e.data)));
    ws.addEventListener("close", () => onClose());
    ws.addEventListener("error", (e) =>
      onError(e?.message ?? "websocket error"),
    );
  }
}

function printUsage() {
  process.stdout.write(
    [
      "rn-console.mjs — collect RN console output via Metro CDP (bounded by default)",
      "",
      "  --level,-l    log|info|warn|error|all   (default all)",
      "  --filter,-f   <substring>               case-insensitive message filter",
      "  --device,-d   <substring>               pick target by device name / app id",
      "  --duration,-t <seconds>                 stop after N seconds (default 10)",
      "  --max,-m      <count>                    stop after N matching logs",
      "  --follow,-F                             stream unbounded (until Ctrl-C)",
      "  --host,-H     <host:port>                Metro host (default localhost:8081)",
      "  --help,-h",
      "",
      'Run from the project root so a "ws" fallback resolves from node_modules.',
      "",
    ].join("\n"),
  );
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      level: { type: "string", short: "l" },
      filter: { type: "string", short: "f" },
      device: { type: "string", short: "d" },
      duration: { type: "string", short: "t" },
      max: { type: "string", short: "m" },
      follow: { type: "boolean", short: "F" },
      host: { type: "string", short: "H" },
      help: { type: "boolean", short: "h" },
    },
    strict: false,
    allowPositionals: true,
  });

  if (values.help) {
    printUsage();
    return 0;
  }

  const host = values.host || DEFAULT_HOST;
  const level = values.level || "all";
  const filter = values.filter || "";
  const follow = Boolean(values.follow);
  let durationMs = 0;
  if (!follow) {
    const dRaw = values.duration ?? String(DEFAULT_DURATION_S);
    const d = Number(dRaw);
    if (!Number.isFinite(d) || d <= 0) {
      process.stderr.write(
        `[rn-console] --duration must be a positive number (got "${dRaw}")\n`,
      );
      return 1;
    }
    durationMs = d * 1000;
  }
  let max = 0;
  if (values.max != null) {
    const m = Number(values.max);
    if (!Number.isFinite(m) || m <= 0) {
      process.stderr.write(
        `[rn-console] --max must be a positive number (got "${values.max}")\n`,
      );
      return 1;
    }
    max = m;
  }
  const useColor = Boolean(process.stdout.isTTY);

  let targets;
  try {
    const res = await fetch(`http://${host}/json`);
    targets = await res.json();
  } catch (e) {
    process.stderr.write(
      `[rn-console] cannot reach Metro at ${host} (${e.message}). Is Metro running? (npm start)\n`,
    );
    return 1;
  }

  const target = selectTarget(targets, values.device || "");
  if (!target || !target.webSocketDebuggerUrl) {
    process.stderr.write(
      `[rn-console] no CDP target at ${host}. Is the app running and connected to Metro?\n`,
    );
    return 1;
  }

  const WebSocketImpl = await resolveWebSocket();
  if (!WebSocketImpl) {
    process.stderr.write(
      '[rn-console] no WebSocket available: use Node >= 22 (built-in) or install "ws" in your project.\n',
    );
    return 1;
  }

  const bound = follow
    ? "(follow)"
    : `duration=${durationMs / 1000}s${max ? ` max=${max}` : ""}`;
  process.stderr.write(
    `[rn-console] connected: ${target.title ?? ""} (${target.deviceName ?? ""}) level=${level} filter="${filter || "none"}" ${bound}\n`,
  );

  return await new Promise((resolve) => {
    let count = 0;
    let timer = null;
    let id = 1;
    const ws = new WebSocketImpl(target.webSocketDebuggerUrl);
    const finish = (code) => {
      if (timer) clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      resolve(code);
    };
    wire(ws, {
      onOpen: (sock) => {
        sock.send(
          JSON.stringify({ id: id++, method: "Runtime.enable", params: {} }),
        );
        sock.send(
          JSON.stringify({ id: id++, method: "Console.enable", params: {} }),
        );
        if (!follow && durationMs > 0)
          timer = setTimeout(() => finish(0), durationMs);
      },
      onMessage: (text) => {
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (msg.method !== "Runtime.consoleAPICalled") return;
        const { type: rawType, args, timestamp } = msg.params ?? {};
        const type = normalizeType(rawType);
        const decoded = formatArgs(args);
        if (!matches(type, decoded, { level, filter })) return;
        process.stdout.write(
          `${formatLine(type, decoded, timestamp, useColor)}\n`,
        );
        count += 1;
        if (!follow && max > 0 && count >= max) finish(0);
      },
      onClose: () => finish(0),
      onError: (m) => {
        process.stderr.write(`[rn-console] websocket error: ${m}\n`);
        finish(1);
      },
    });
    process.on("SIGINT", () => finish(0));
  });
}

const invokedDirectly =
  import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`[rn-console] ${e?.message ?? e}\n`);
      process.exit(1);
    });
}
