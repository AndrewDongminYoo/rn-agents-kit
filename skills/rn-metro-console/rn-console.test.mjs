// Tests for rn-console.mjs: pure-helper unit tests + a mock-CDP integration test.
// Run: node --test skills/rn-metro-console/rn-console.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
const SERVER_SOCKETS = new WeakMap();

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

test("selectTarget uses a unique device name when app IDs repeat", () => {
  const targets = [
    {
      title: "Hermes React Native",
      deviceName: "iPhone 15",
      appId: "com.mock",
    },
    {
      title: "Hermes React Native",
      deviceName: "iPhone 16 Pro",
      appId: "com.mock",
    },
  ];
  assert.equal(selectTarget(targets, "iPhone 16 Pro"), targets[1]);
  assert.equal(selectTarget(targets, "com.mock"), null);
});

test("selectTarget falls back to first when no selector is supplied", () => {
  const targets = [
    { title: "Unknown runtime", deviceName: "Pixel 7", appId: "com.a" },
    { title: "Other runtime", deviceName: "iPhone 15", appId: "com.b" },
  ];
  assert.equal(selectTarget(targets, ""), targets[0]);
  assert.equal(selectTarget([], "x"), null);
});

test("selectTarget rejects a selector without a React Native target", () => {
  const targets = [
    { title: "Unknown runtime", deviceName: "Pixel 7", appId: "com.a" },
    { title: "Other runtime", deviceName: "iPhone 15", appId: "com.b" },
  ];
  assert.equal(selectTarget(targets, "iPhone"), null);
  assert.equal(selectTarget(targets, "nope"), null);
});

test("selectTarget rejects an ambiguous React Native selector", () => {
  const targets = [
    { title: "Hermes React Native", deviceName: "iPhone 15", appId: "com.a" },
    { title: "Hermes React Native", deviceName: "iPhone 15", appId: "com.b" },
  ];
  assert.equal(selectTarget(targets, "iPhone"), null);
  assert.equal(selectTarget(targets, "com.a"), targets[0]);
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

function respondWithTargets(req, res, targets) {
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
}

function startMockMetro(
  frames,
  targets,
  {
    stallJson = false,
    stallUpgrade = false,
    jsonDelayMs = 0,
    ackIds = [1, 2],
    enableErrorId = 0,
    preReadyFrames = [],
    closeBeforeAck = false,
    destroyBeforeAck = false,
    requiredOrigin = "",
  } = {},
) {
  const server = http.createServer((req, res) => {
    if (req.url === "/json") {
      if (stallJson) return;
      if (jsonDelayMs > 0) {
        setTimeout(() => respondWithTargets(req, res, targets), jsonDelayMs);
        return;
      }
      respondWithTargets(req, res, targets);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const sockets = new Set();
  SERVER_SOCKETS.set(server, sockets);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket) => {
    if (requiredOrigin && req.headers.origin !== requiredOrigin) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    if (stallUpgrade) {
      socket.on("error", () => {});
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${wsAccept(req.headers["sec-websocket-key"])}\r\n\r\n`,
    );
    if (destroyBeforeAck) {
      socket.end();
      return;
    }
    if (closeBeforeAck) {
      // a clean CDP-side close: FIN + opcode 0x8, empty payload
      socket.write(Buffer.from([0x88, 0x00]));
      socket.end();
      return;
    }
    socket.once("data", () => {
      // client's Runtime.enable/Console.enable arrived
      socket.on("data", () => {}); // keep draining further client frames
      for (const f of preReadyFrames) socket.write(f);
      // the client always sends Runtime.enable as id 1 and Console.enable as id 2
      for (const commandId of ackIds) {
        const payload =
          commandId === enableErrorId
            ? {
                id: commandId,
                error: { code: -32601, message: "enable unsupported" },
              }
            : { id: commandId, result: {} };
        socket.write(encodeTextFrame(JSON.stringify(payload)));
      }
      const framesForTarget =
        typeof frames === "function" ? frames(req.url) : frames;
      for (const f of framesForTarget) socket.write(f);
    });
    socket.on("error", () => {});
  });
  return server;
}

function runScript(args, timeoutMs = 5000, { cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, out, err, timedOut });
    });
  });
}

test("integration: project ws receives the Metro origin", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "rn-console-ws-"));
  const wsDir = join(projectDir, "node_modules", "ws");
  await mkdir(wsDir, { recursive: true });
  await writeFile(join(projectDir, "package.json"), '{"private":true}\n');
  await writeFile(
    join(wsDir, "index.js"),
    `const { EventEmitter } = require("node:events");
module.exports = class TestWebSocket extends EventEmitter {
  constructor(_url, options) {
    super();
    if (options?.origin !== process.env.EXPECTED_ORIGIN) {
      throw new Error(\`expected origin \${process.env.EXPECTED_ORIGIN}, got \${options?.origin}\`);
    }
    process.nextTick(() => this.emit("open"));
  }
  send(data) {
    const message = JSON.parse(data);
    process.nextTick(() => {
      this.emit("message", JSON.stringify({ id: message.id, result: {} }));
      if (message.id === 1) {
        this.emit("message", JSON.stringify({
          method: "Runtime.consoleAPICalled",
          params: {
            type: "log",
            args: [{ type: "string", value: "origin accepted" }],
            timestamp: 1700000000000,
          },
        }));
      }
    });
  }
  close() {}
};
`,
  );

  const server = startMockMetro([], undefined, {
    requiredOrigin: "http://invalid-without-ws.example",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const expectedOrigin = `http://127.0.0.1:${port}`;
  try {
    const { code, out, err, timedOut } = await runScript(
      ["--host", `127.0.0.1:${port}`, "--max", "1"],
      5000,
      { cwd: projectDir, env: { EXPECTED_ORIGIN: expectedOrigin } },
    );
    assert.equal(timedOut, false);
    assert.equal(code, 0);
    assert.match(err, /\[rn-console\] ready:/);
    assert.match(out, /origin accepted/);
  } finally {
    await closeServer(server);
    await rm(projectDir, { force: true, recursive: true });
  }
});

test("integration: built-in handshake failure names the Origin limitation", async () => {
  const requiredOrigin = "http://metro.example";
  const server = startMockMetro([], undefined, { requiredOrigin });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const { code, err, timedOut } = await runScript(
      ["--host", `127.0.0.1:${port}`, "--setup-timeout", "1"],
      3000,
    );
    assert.equal(timedOut, false);
    assert.equal(code, 1);
    assert.match(err, /websocket error: connection failed/);
    assert.match(err, /built-in WebSocket cannot send Metro's required Origin/);
    assert.match(err, /make "ws" resolvable from the project root/);
  } finally {
    await closeServer(server);
  }
});

async function closeServer(server) {
  for (const socket of SERVER_SOCKETS.get(server) ?? []) socket.destroy();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
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

test("integration: --preflight reports one selected React Native target", async () => {
  const server = startMockMetro([], (host) => [
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
  ]);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const { code, out, err } = await runScript([
      "--host",
      `127.0.0.1:${port}`,
      "--device",
      "com.mock",
      "--preflight",
      "--duration",
      "0.1",
    ]);
    assert.equal(code, 0);
    assert.equal(err, "");
    assert.deepEqual(JSON.parse(out), {
      title: "Hermes React Native",
      deviceName: "Mock",
      appId: "com.mock",
    });
  } finally {
    server.close();
  }
});

test("integration: --preflight requires a target selector", async () => {
  const { code, err } = await runScript(["--preflight"]);
  assert.equal(code, 1);
  assert.match(err, /--preflight requires --device/);
});

test("integration: reports ready only after the CDP connection opens", async () => {
  const server = startMockMetro([]);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const { code, err } = await runScript([
      "--host",
      `127.0.0.1:${port}`,
      "--duration",
      "0.1",
    ]);
    assert.equal(code, 0);
    assert.match(err, /\[rn-console\] ready:/);
    assert.match(err, /appId=com\.mock/);
  } finally {
    server.close();
  }

  const unavailable = http.createServer();
  unavailable.on("upgrade", (_req, socket) => socket.destroy());
  await new Promise((r) => unavailable.listen(0, "127.0.0.1", r));
  const unavailablePort = unavailable.address().port;

  const failureServer = startMockMetro([], (host) => [
    {
      webSocketDebuggerUrl: `ws://127.0.0.1:${unavailablePort}/unavailable`,
      deviceName: "Mock",
      appId: "com.mock",
      title: "Hermes React Native",
    },
  ]);
  await new Promise((r) => failureServer.listen(0, "127.0.0.1", r));
  const failurePort = failureServer.address().port;
  try {
    const { code, err } = await runScript([
      "--host",
      `127.0.0.1:${failurePort}`,
      "--duration",
      "0.1",
    ]);
    assert.equal(code, 1);
    assert.doesNotMatch(err, /\[rn-console\] ready:/);
  } finally {
    await closeServer(failureServer);
    await closeServer(unavailable);
  }
});

test("integration: times out stalled Metro target discovery before ready", async () => {
  const server = startMockMetro([], undefined, { stallJson: true });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const { code, err, timedOut } = await runScript(
      ["--host", `127.0.0.1:${port}`, "--setup-timeout", "0.1"],
      1500,
    );
    assert.equal(timedOut, false);
    assert.equal(code, 1);
    assert.match(err, /\[rn-console\] setup timed out/);
    assert.doesNotMatch(err, /\[rn-console\] ready:/);
  } finally {
    await closeServer(server);
  }
});

test("integration: times out a stalled CDP handshake before ready", async () => {
  const server = startMockMetro([], undefined, { stallUpgrade: true });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const { code, err, timedOut } = await runScript(
      ["--host", `127.0.0.1:${port}`, "--setup-timeout", "0.1"],
      1500,
    );
    assert.equal(timedOut, false);
    assert.equal(code, 1);
    assert.match(err, /\[rn-console\] setup timed out/);
    assert.doesNotMatch(err, /\[rn-console\] ready:/);
  } finally {
    await closeServer(server);
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

test("integration: a short --duration still allows slow Metro discovery", async () => {
  const server = startMockMetro([], undefined, { jsonDelayMs: 150 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const { code, err, timedOut } = await runScript(
      ["--host", `127.0.0.1:${port}`, "--duration", "0.1"],
      5000,
    );
    assert.equal(timedOut, false);
    assert.equal(code, 0);
    assert.doesNotMatch(err, /setup timed out/);
    assert.match(err, /\[rn-console\] ready:/);
  } finally {
    await closeServer(server);
  }
});

test("rejects a non-positive --setup-timeout before connecting", async () => {
  const { code, err } = await runScript(["--setup-timeout", "0"]);
  assert.equal(code, 1);
  assert.match(err, /--setup-timeout must be a positive number/);
});

test("integration: withholds ready until Runtime.enable is acknowledged", async () => {
  const server = startMockMetro(
    [consoleFrame("log", "before enable ack")],
    undefined,
    { ackIds: [] },
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const { code, out, err, timedOut } = await runScript(
      ["--host", `127.0.0.1:${port}`, "--setup-timeout", "0.5"],
      3000,
    );
    assert.equal(timedOut, false);
    assert.equal(code, 1);
    assert.doesNotMatch(err, /\[rn-console\] ready:/);
    assert.match(err, /setup timed out/);
    assert.equal(out, "");
  } finally {
    await closeServer(server);
  }
});

test("integration: treats a failed Runtime.enable as a setup failure", async () => {
  const server = startMockMetro(
    [consoleFrame("log", "should never print")],
    undefined,
    { enableErrorId: 1 },
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const { code, out, err, timedOut } = await runScript(
      ["--host", `127.0.0.1:${port}`, "--setup-timeout", "1"],
      3000,
    );
    assert.equal(timedOut, false);
    assert.equal(code, 1);
    assert.match(err, /Runtime\.enable failed: enable unsupported/);
    assert.doesNotMatch(err, /\[rn-console\] ready:/);
    assert.equal(out, "");
  } finally {
    await closeServer(server);
  }
});

test("integration: drops console events that arrive before ready", async () => {
  const server = startMockMetro(
    [consoleFrame("log", "after ready")],
    undefined,
    { preReadyFrames: [consoleFrame("log", "before ready")] },
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const { code, out, err, timedOut } = await runScript(
      ["--host", `127.0.0.1:${port}`, "--max", "1"],
      5000,
    );
    assert.equal(timedOut, false);
    assert.equal(code, 0);
    assert.match(err, /\[rn-console\] ready:/);
    assert.doesNotMatch(out, /before ready/);
    assert.match(out, /after ready/);
  } finally {
    await closeServer(server);
  }
});

test("integration: a close before ready is a setup failure", async () => {
  const server = startMockMetro([], undefined, { closeBeforeAck: true });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const { code, out, err, timedOut } = await runScript(
      ["--host", `127.0.0.1:${port}`, "--setup-timeout", "2"],
      5000,
    );
    assert.equal(timedOut, false);
    assert.equal(code, 1);
    assert.match(err, /closed the connection before setup completed/);
    assert.doesNotMatch(err, /\[rn-console\] ready:/);
    assert.equal(out, "");
  } finally {
    await closeServer(server);
  }
});

test("runs when invoked through a symlinked skill directory", async () => {
  const linkDir = await mkdtemp(join(tmpdir(), "rn-console-link-"));
  const linkPath = join(linkDir, "rn-console.mjs");
  await symlink(SCRIPT, linkPath);
  try {
    const child = spawn(process.execPath, [linkPath, "--help"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = await new Promise((resolve) => {
      let buffer = "";
      child.stdout.on("data", (d) => (buffer += d));
      child.on("close", () => resolve(buffer));
    });
    assert.match(out, /collect RN console output via Metro CDP/);
  } finally {
    await rm(linkDir, { force: true, recursive: true });
  }
});

test("integration: a failed Console.enable does not block the capture", async () => {
  const server = startMockMetro(
    [consoleFrame("log", "captured anyway")],
    undefined,
    { enableErrorId: 2 },
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const { code, out, err, timedOut } = await runScript(
      ["--host", `127.0.0.1:${port}`, "--max", "1"],
      5000,
    );
    assert.equal(timedOut, false);
    assert.equal(code, 0);
    assert.match(
      err,
      /Console\.enable failed: enable unsupported \(continuing\)/,
    );
    assert.match(err, /\[rn-console\] ready:/);
    assert.match(out, /captured anyway/);
  } finally {
    await closeServer(server);
  }
});

test("integration: an unanswered Console.enable does not block the capture", async () => {
  const server = startMockMetro(
    [consoleFrame("log", "captured anyway")],
    undefined,
    { ackIds: [1] },
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const { code, out, timedOut } = await runScript(
      ["--host", `127.0.0.1:${port}`, "--max", "1"],
      5000,
    );
    assert.equal(timedOut, false);
    assert.equal(code, 0);
    assert.match(out, /captured anyway/);
  } finally {
    await closeServer(server);
  }
});

test("integration: names an ambiguous selector instead of blaming Metro", async () => {
  const twin = (n) => ({
    webSocketDebuggerUrl: `ws://127.0.0.1:1/inspector${n}`,
    deviceName: "iPhone",
    appId: "com.mock",
    title: `React Native Bridge ${n}`,
  });
  const server = startMockMetro([], [twin(1), twin(2)]);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const { code, err } = await runScript([
      "--host",
      `127.0.0.1:${port}`,
      "--device",
      "iPhone",
    ]);
    assert.equal(code, 1);
    assert.match(err, /matched 2 React Native targets; narrow the selector/);
    assert.doesNotMatch(err, /Is the app running/);
  } finally {
    await closeServer(server);
  }
});

test("integration: says the match was not a React Native target", async () => {
  const server = startMockMetro(
    [],
    [
      {
        webSocketDebuggerUrl: "ws://127.0.0.1:1/inspector",
        deviceName: "iPhone",
        appId: "com.mock",
        title: "Reanimated Runtime",
      },
    ],
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const { code, err } = await runScript([
      "--host",
      `127.0.0.1:${port}`,
      "--device",
      "iPhone",
    ]);
    assert.equal(code, 1);
    assert.match(err, /none of them a React Native app target/);
    assert.doesNotMatch(err, /Is the app running/);
  } finally {
    await closeServer(server);
  }
});

test("integration: an abrupt disconnect reports one cause, not two", async () => {
  const server = startMockMetro([], undefined, { destroyBeforeAck: true });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const { code, err, timedOut } = await runScript(
      ["--host", `127.0.0.1:${port}`, "--setup-timeout", "2"],
      5000,
    );
    assert.equal(timedOut, false);
    assert.equal(code, 1);
    assert.match(err, /websocket error/);
    assert.doesNotMatch(err, /closed the connection before setup completed/);
  } finally {
    await closeServer(server);
  }
});
