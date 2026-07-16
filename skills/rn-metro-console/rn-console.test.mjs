// Tests for rn-console.mjs: pure-helper unit tests + a mock-CDP integration test.
// Run: node --test skills/rn-metro-console/rn-console.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  formatArgs,
  selectTarget,
  matches,
  normalizeType,
} from "./rn-console.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "rn-console.mjs");

test("formatArgs decodes RemoteObject args and strips ANSI", () => {
  assert.equal(
    formatArgs([
      { type: "string", value: "hi" },
      { type: "number", value: 7 },
    ]),
    "hi 7",
  );
  assert.equal(
    formatArgs([{ type: "object", description: "Error: x" }]),
    "Error: x",
  );
  assert.equal(
    formatArgs([{ type: "string", value: "\x1b[31mred\x1b[0m" }]),
    "red",
  );
  assert.equal(formatArgs(null), "");
});

test("selectTarget prefers the React Native app target", () => {
  const targets = [
    {
      title: "Reanimated Runtime",
      deviceName: "Pixel 7",
      appId: "com.a",
    },
    {
      title: "don't use",
      url: "http://localhost:8081/debugger-ui?page=-1",
      deviceName: "Pixel 7",
      appId: "com.a",
    },
    {
      title: "Hermes React Native",
      deviceName: "Pixel 7",
      appId: "com.a",
    },
  ];
  assert.equal(selectTarget(targets, ""), targets[2]);
  assert.equal(selectTarget(targets, "pixel"), targets[2]);
  assert.equal(selectTarget(targets, "com.a"), targets[2]);
});

test("selectTarget scopes app preference to the matching device/appId", () => {
  const targets = [
    { title: "Hermes React Native", deviceName: "Pixel 7", appId: "com.a" },
    { title: "Reanimated Runtime", deviceName: "iPhone 15", appId: "com.b" },
    { title: "Hermes React Native", deviceName: "iPhone 15", appId: "com.b" },
  ];
  assert.equal(selectTarget(targets, "iPhone"), targets[2]);
  assert.equal(selectTarget(targets, "com.b"), targets[2]);
});

test("selectTarget falls back to first when no app target is identifiable", () => {
  const targets = [
    { title: "Unknown runtime", deviceName: "Pixel 7", appId: "com.a" },
    { title: "Other runtime", deviceName: "iPhone 15", appId: "com.b" },
  ];
  assert.equal(selectTarget(targets, ""), targets[0]);
  assert.equal(selectTarget(targets, "iPhone"), targets[1]);
  assert.equal(selectTarget(targets, "nope"), targets[0]);
  assert.equal(selectTarget([], "x"), null);
});

test("matches applies level, non-empty, and substring filter", () => {
  assert.equal(matches("error", "boom", { level: "error", filter: "" }), true);
  assert.equal(matches("log", "boom", { level: "error", filter: "" }), false);
  assert.equal(matches("log", "   ", { level: "all", filter: "" }), false);
  assert.equal(
    matches("log", "Login ok", { level: "all", filter: "login" }),
    true,
  ); // case-insensitive
  assert.equal(
    matches("log", "Login ok", { level: "all", filter: "zzz" }),
    false,
  );
});

test('normalizeType maps CDP "warning" to the friendly "warn"', () => {
  assert.equal(normalizeType("warning"), "warn");
  assert.equal(normalizeType("error"), "error");
  assert.equal(normalizeType("log"), "log");
});

// --- mock Metro: GET /json + hand-rolled WS upgrade that pushes frames ---
function wsAccept(key) {
  return crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}
function encodeTextFrame(str) {
  const payload = Buffer.from(str, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  }
  return Buffer.concat([header, payload]);
}
function consoleFrame(type, text) {
  return encodeTextFrame(
    JSON.stringify({
      method: "Runtime.consoleAPICalled",
      params: {
        type,
        args: [{ type: "string", value: text }],
        timestamp: 1700000000000,
      },
    }),
  );
}

function startMockMetro(frames, targets) {
  const server = http.createServer((req, res) => {
    if (req.url === "/json") {
      const targetList =
        typeof targets === "function"
          ? targets(req.headers.host)
          : (targets ?? [
              {
                webSocketDebuggerUrl: `ws://${req.headers.host}/inspector`,
                deviceName: "Mock",
                appId: "com.mock",
                title: "Mock App",
              },
            ]);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(targetList));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.on("upgrade", (req, socket) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${wsAccept(req.headers["sec-websocket-key"])}\r\n\r\n`,
    );
    socket.once("data", () => {
      // client's Runtime.enable/Console.enable arrived
      socket.on("data", () => {}); // keep draining further client frames
      const framesForTarget =
        typeof frames === "function" ? frames(req.url) : frames;
      for (const f of framesForTarget) socket.write(f);
    });
    socket.on("error", () => {});
  });
  return server;
}

function runScript(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

test("integration: bounded by --max collects N lines then exits 0", async () => {
  const server = startMockMetro([
    consoleFrame("log", "hello from mock"),
    consoleFrame("error", "boom error"),
    consoleFrame("warn", "careful"),
  ]);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const { code, out } = await runScript([
      "--host",
      `127.0.0.1:${port}`,
      "--max",
      "2",
    ]);
    const lines = out.trim().split("\n").filter(Boolean);
    assert.equal(code, 0);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /\[LOG  \] hello from mock/);
    assert.match(lines[1], /\[ERROR\] boom error/);
  } finally {
    server.close();
  }
});

test("integration: prefers app target over auxiliary targets", async () => {
  const server = startMockMetro(
    (path) => (path === "/app" ? [consoleFrame("log", "from app target")] : []),
    (host) => [
      {
        webSocketDebuggerUrl: `ws://${host}/reanimated`,
        deviceName: "Mock",
        appId: "com.mock",
        title: "Reanimated Runtime",
      },
      {
        webSocketDebuggerUrl: `ws://${host}/app`,
        deviceName: "Mock",
        appId: "com.mock",
        title: "Hermes React Native",
      },
    ],
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const { code, out } = await runScript([
      "--host",
      `127.0.0.1:${port}`,
      "--max",
      "1",
      "--duration",
      "1",
    ]);
    const lines = out.trim().split("\n").filter(Boolean);
    assert.equal(code, 0);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\[LOG  \] from app target/);
  } finally {
    server.close();
  }
});

test("integration: --level error --max 1 keeps only the error line", async () => {
  const server = startMockMetro([
    consoleFrame("log", "hello from mock"),
    consoleFrame("error", "boom error"),
  ]);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const { code, out } = await runScript([
      "--host",
      `127.0.0.1:${port}`,
      "--level",
      "error",
      "--max",
      "1",
    ]);
    const lines = out.trim().split("\n").filter(Boolean);
    assert.equal(code, 0);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\[ERROR\] boom error/);
  } finally {
    server.close();
  }
});

test("integration: --duration exits 0 even with no matching logs", async () => {
  const server = startMockMetro([consoleFrame("log", "irrelevant")]);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const { code, out } = await runScript([
      "--host",
      `127.0.0.1:${port}`,
      "--filter",
      "NEVERMATCH",
      "--duration",
      "1",
    ]);
    assert.equal(code, 0);
    assert.equal(out.trim(), "");
  } finally {
    server.close();
  }
});

test("rejects a non-numeric --duration before connecting", async () => {
  const { code, err } = await runScript(["--duration", "foo"]);
  assert.equal(code, 1);
  assert.match(err, /--duration must be a positive number/);
});

test("rejects a non-positive --max before connecting", async () => {
  const { code, err } = await runScript(["--max", "0", "--duration", "1"]);
  assert.equal(code, 1);
  assert.match(err, /--max must be a positive number/);
});

test('integration: --level warn captures CDP "warning" events', async () => {
  const server = startMockMetro([
    consoleFrame("log", "noise"),
    consoleFrame("warning", "heads up"),
  ]);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const { code, out } = await runScript([
      "--host",
      `127.0.0.1:${port}`,
      "--level",
      "warn",
      "--max",
      "1",
    ]);
    const lines = out.trim().split("\n").filter(Boolean);
    assert.equal(code, 0);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\[WARN \] heads up/);
  } finally {
    server.close();
  }
});
