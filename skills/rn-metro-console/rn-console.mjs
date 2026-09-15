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
//     --preflight                             print one selected React Native target as JSON
//     --duration, -t  <seconds>                 bounded: stop after N seconds (default 10)
//     --max,      -m  <count>                    bounded: stop after N matching logs
//     --setup-timeout <seconds>                  give up before ready after N seconds (default 10)
//     --follow,   -F                             stream unbounded (until Ctrl-C)
//     --host,     -H  <host:port>                Metro host (default localhost:8081)
//     --help,     -h
//   Run from the project root so 'ws' resolves from node_modules when present.
import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_HOST = "localhost:8081";
const DEFAULT_DURATION_S = 10;
// The pre-ready budget is independent of --duration: a short collection window
// must not cut Metro discovery or the CDP handshake short.
const DEFAULT_SETUP_TIMEOUT_S = 10;
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

// A supplied selector must retain both device/app and React Native identity.
export function selectTarget(targets, device) {
  if (!Array.isArray(targets) || targets.length === 0) return null;
  const query = String(device ?? "").trim();
  const candidates = query
    ? targets.filter((t) => matchesDevice(t, query))
    : targets;
  if (query && candidates.length === 0) return null;
  const appTargets = candidates.filter(isReactNativeAppTarget);
  if (query) return appTargets.length === 1 ? appTargets[0] : null;
  return appTargets[0] ?? candidates[0];
}

// Why did selectTarget return nothing? The three causes need different actions.
function explainNoTarget(targets, device, host) {
  const names = (list) =>
    list.map((t) => t?.title ?? t?.deviceName ?? "[unnamed]").join(", ");
  if (!Array.isArray(targets) || targets.length === 0) {
    return `no CDP target at ${host}. Is the app running and connected to Metro?`;
  }
  if (!device) {
    return `no React Native target at ${host}. Seen: ${names(targets)}`;
  }
  const matched = targets.filter((t) => matchesDevice(t, device));
  if (matched.length === 0) {
    return `no target matches --device "${device}" at ${host}. Seen: ${names(targets)}`;
  }
  const appTargets = matched.filter(isReactNativeAppTarget);
  if (appTargets.length === 0) {
    return `--device "${device}" matched ${matched.length} target(s), none of them a React Native app target. Matched: ${names(matched)}`;
  }
  return `--device "${device}" matched ${appTargets.length} React Native targets; narrow the selector. Matched: ${names(appTargets)}`;
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

// Prefer the project's `ws` because Metro can require an Origin header.
// The Node >= 22 built-in remains a fallback for servers that accept its
// headerless handshake.
async function resolveWebSocket() {
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(`${process.cwd()}/package.json`);
    return { WebSocketImpl: require("ws"), supportsOrigin: true };
  } catch {
    if (typeof globalThis.WebSocket === "function") {
      return { WebSocketImpl: globalThis.WebSocket, supportsOrigin: false };
    }
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
      "  --preflight                             print one selected React Native target as JSON",
      "  --duration,-t <seconds>                 stop after N seconds (default 10)",
      "  --max,-m      <count>                    stop after N matching logs",
      "  --setup-timeout <seconds>               give up before ready after N seconds (default 10)",
      "  --follow,-F                             stream unbounded (until Ctrl-C)",
      "  --host,-H     <host:port>                Metro host (default localhost:8081)",
      "  --help,-h",
      "",
      'Run from the project root so "ws" resolves from node_modules when present.',
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
      preflight: { type: "boolean" },
      duration: { type: "string", short: "t" },
      "setup-timeout": { type: "string" },
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

  if (values.preflight && !String(values.device ?? "").trim()) {
    process.stderr.write("[rn-console] --preflight requires --device\n");
    return 1;
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
  const setupRaw = values["setup-timeout"] ?? String(DEFAULT_SETUP_TIMEOUT_S);
  const setupSeconds = Number(setupRaw);
  if (!Number.isFinite(setupSeconds) || setupSeconds <= 0) {
    process.stderr.write(
      `[rn-console] --setup-timeout must be a positive number (got "${setupRaw}")\n`,
    );
    return 1;
  }
  const setupTimeoutMs = setupSeconds * 1000;
  const setupDeadlineMs = Date.now() + setupTimeoutMs;
  const setupTimeoutMessage = `[rn-console] setup timed out after ${setupTimeoutMs / 1000}s\n`;
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
    const res = await fetch(`http://${host}/json`, {
      signal: AbortSignal.timeout(setupTimeoutMs),
    });
    targets = await res.json();
  } catch (e) {
    if (e?.name === "TimeoutError") {
      process.stderr.write(setupTimeoutMessage);
      return 1;
    }
    process.stderr.write(
      `[rn-console] cannot reach Metro at ${host} (${e.message}). Is Metro running? (npm start)\n`,
    );
    return 1;
  }

  const requested = values.device || "";
  const target = selectTarget(targets, requested);
  if (!target || !target.webSocketDebuggerUrl) {
    process.stderr.write(
      `[rn-console] ${explainNoTarget(targets, requested, host)}\n`,
    );
    return 1;
  }

  if (values.preflight) {
    process.stdout.write(
      `${JSON.stringify({
        title: target.title ?? null,
        deviceName: target.deviceName ?? null,
        appId: target.appId ?? null,
      })}\n`,
    );
    return 0;
  }

  const transport = await resolveWebSocket();
  if (!transport) {
    process.stderr.write(
      '[rn-console] no WebSocket available: use Node >= 22 (built-in) or install "ws" in your project.\n',
    );
    return 1;
  }
  const { WebSocketImpl, supportsOrigin } = transport;
  const metroOrigin = new URL(`http://${host}`).origin;
  const describeWebSocketFailure = (detail) => {
    const cause = String(detail ?? "").trim() || "connection failed";
    if (supportsOrigin) return cause;
    return `${cause}. The built-in WebSocket cannot send Metro's required Origin; if Metro rejected the handshake, make "ws" resolvable from the project root.`;
  };

  const bound = follow
    ? "(follow)"
    : `duration=${durationMs / 1000}s${max ? ` max=${max}` : ""}`;
  const websocketTimeoutMs = setupDeadlineMs - Date.now();
  if (websocketTimeoutMs <= 0) {
    process.stderr.write(setupTimeoutMessage);
    return 1;
  }

  return await new Promise((resolve) => {
    let count = 0;
    let timer = null;
    let setupTimer = null;
    let id = 1;
    let settled = false;
    let ws;
    const pendingEnables = new Map();
    // Only Runtime.consoleAPICalled is consumed, so Runtime.enable is what
    // readiness depends on; Console.enable is sent for targets that want it
    // but never gates the capture, error or no reply.
    let requiredEnableId = null;
    let ready = false;
    const announceReady = () => {
      if (settled) return;
      ready = true;
      if (setupTimer) {
        clearTimeout(setupTimer);
        setupTimer = null;
      }
      process.stderr.write(
        `[rn-console] ready: ${target.title ?? ""} (${target.deviceName ?? ""}) appId=${target.appId ?? "[UNKNOWN]"} level=${level} filter="${filter || "none"}" ${bound}\n`,
      );
      if (!follow && durationMs > 0)
        timer = setTimeout(() => finish(0), durationMs);
    };
    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (setupTimer) clearTimeout(setupTimer);
      try {
        ws?.close();
      } catch {
        /* already closing */
      }
      resolve(code);
    };
    try {
      ws = supportsOrigin
        ? new WebSocketImpl(target.webSocketDebuggerUrl, {
            origin: metroOrigin,
          })
        : new WebSocketImpl(target.webSocketDebuggerUrl);
    } catch (e) {
      process.stderr.write(
        `[rn-console] websocket error: ${describeWebSocketFailure(e?.message ?? e)}\n`,
      );
      finish(1);
      return;
    }
    setupTimer = setTimeout(() => {
      process.stderr.write(setupTimeoutMessage);
      finish(1);
    }, websocketTimeoutMs);
    wire(ws, {
      onOpen: (sock) => {
        if (settled) return;
        // The setup deadline stays armed until both enables are acknowledged:
        // a target that accepts the socket but defers CDP commands is not ready.
        for (const method of ["Runtime.enable", "Console.enable"]) {
          const commandId = id++;
          if (method === "Runtime.enable") requiredEnableId = commandId;
          pendingEnables.set(commandId, method);
          sock.send(JSON.stringify({ id: commandId, method, params: {} }));
        }
      },
      onMessage: (text) => {
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (msg.id != null && pendingEnables.has(msg.id)) {
          const method = pendingEnables.get(msg.id);
          const required = msg.id === requiredEnableId;
          pendingEnables.delete(msg.id);
          if (msg.error) {
            const detail = msg.error.message ?? JSON.stringify(msg.error);
            process.stderr.write(
              `[rn-console] ${method} failed: ${detail}${required ? "" : " (continuing)"}\n`,
            );
            if (required) finish(1);
            return;
          }
          if (required) announceReady();
          return;
        }
        if (msg.method !== "Runtime.consoleAPICalled") return;
        // Events that arrive before readiness predate the collection window;
        // counting them can end a --max run without ever announcing ready.
        if (!ready) return;
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
      onClose: () => {
        // finish() closes the socket, so a failure already reported would
        // otherwise print a second, unrelated-looking cause here.
        if (settled) return;
        // A close before readiness ends no collection window, so it must not
        // report success.
        if (!ready) {
          process.stderr.write(
            `[rn-console] ${describeWebSocketFailure("target closed the connection before setup completed")}\n`,
          );
          finish(1);
          return;
        }
        finish(0);
      },
      onError: (m) => {
        process.stderr.write(
          `[rn-console] websocket error: ${describeWebSocketFailure(m)}\n`,
        );
        finish(1);
      },
    });
    process.on("SIGINT", () => finish(0));
  });
}

// A symlinked skill directory leaves argv[1] on the link while import.meta.url
// resolves to the real file, so both sides are canonicalized before comparison.
const invokedDirectly = (() => {
  try {
    return (
      process.argv[1] != null &&
      realpathSync(process.argv[1]) ===
        realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`[rn-console] ${e?.message ?? e}\n`);
      process.exit(1);
    });
}
