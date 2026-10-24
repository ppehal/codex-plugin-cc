import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { initGitRepo, makeTempDir } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = process.env.CODEX_TEST_SESSION_HOOK || path.join(ROOT, "plugins/codex/scripts/session-lifecycle-hook.mjs");
const job = (id, sessionId, extra = {}) => ({ id, sessionId, status: "running", pid: null, ...extra });

async function fixture(t, state, files = {}) {
  const root = makeTempDir("se-");
  const cwd = path.join(root, "repo");
  fs.mkdirSync(cwd);
  initGitRepo(cwd);
  const data = path.join(root, "data");
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  let stateDir;
  try {
    process.env.CLAUDE_PLUGIN_DATA = data;
    stateDir = resolveStateDir(cwd);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  const endpoint = createBrokerEndpoint(root);
  const requests = [];
  const server = net.createServer(socket => {
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      requests.push(request);
      socket.end(JSON.stringify({ id: request.id, result: {} }) + "\n");
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(parseBrokerEndpoint(endpoint).path, resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const brokerFile = path.join(stateDir, "broker.json");
  const logFile = path.join(root, "broker.log");
  fs.writeFileSync(brokerFile, JSON.stringify({ endpoint, logFile, pid: null, sessionDir: null }));
  const write = (file, value) => fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  if (state !== undefined) write(path.join(stateDir, "state.json"), state);
  for (const [name, value] of Object.entries(files)) write(path.join(stateDir, "jobs", name), value);
  const invoke = (sessionId, missingProcfs = false) => new Promise((resolve, reject) => {
    const args = missingProcfs ? ["--input-type=module", "-e", `
      import fs from "node:fs";
      const exists = fs.existsSync;
      const read = fs.readFileSync;
      fs.existsSync = file => file === "/proc/self" ? false : exists(file);
      fs.readFileSync = (file, ...options) => {
        if (String(file).startsWith("/proc/")) throw Object.assign(new Error("No procfs"), { code: "ENOENT" });
        return read(file, ...options);
      };
      await import(process.argv[1]);
    `, HOOK, "SessionEnd"] : [HOOK, "SessionEnd"];
    const child = spawn(process.execPath, args, {
      cwd, env: { ...process.env, CLAUDE_PLUGIN_DATA: data, CODEX_COMPANION_SESSION_ID: "" }, stdio: ["pipe", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", chunk => stderr += chunk);
    const timer = setTimeout(() => child.kill("SIGTERM"), 8000);
    child.on("error", reject);
    child.on("exit", code => { clearTimeout(timer); resolve({ code, stderr }); });
    child.stdin.end(JSON.stringify({ cwd, ...(sessionId ? { session_id: sessionId } : {}) }));
  });
  return { invoke, requests, brokerFile, stateDir, logFile };
}

for (const [name, state, files, session = "B"] of [
  ["foreign running record", { jobs: [job("foreign", "A")] }],
  ["foreign queued record", { jobs: [job("queued", "A", { status: "queued" })] }],
  ["record without owner", { jobs: [job("unknown", undefined)] }],
  ["unknown status", { jobs: [job("paused", "A", { status: "paused" })] }],
  ["job-file-only record", undefined, { "foreign.json": job("foreign", "A") }],
  ["corrupt state", "{"],
  ["corrupt job file", { jobs: [] }, { "bad.json": "{" }],
  ["malformed jobs list", { jobs: {} }],
  ["missing ending session", { jobs: [job("foreign", "B")] }, {}, null]
]) test("session end keeps broker for " + name, async t => {
  const f = await fixture(t, state, files);
  const result = await f.invoke(session);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(f.brokerFile), true);
  assert.deepEqual(f.requests, []);
  assert.match(fs.readFileSync(f.logFile, "utf8"), /kept broker/);
});

test("session end retains a live foreign PID when procfs is unavailable", async t => {
  const f = await fixture(t, { jobs: [job("foreign", "A", { pid: process.pid })] });
  const result = await f.invoke("B", true);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(f.brokerFile), true);
  assert.deepEqual(f.requests, []);
  assert.match(fs.readFileSync(f.logFile, "utf8"), /kept broker/);
});

test("session end interrupts its own state/file turns and preserves the foreign job", async t => {
  const own = job("own", "B");
  const second = job("second", "B", { threadId: "thread-2", turnId: "turn-2" });
  const foreign = job("foreign", "A");
  const f = await fixture(t, { jobs: [own, second, foreign] }, {
    "own.json": { ...own, threadId: "thread-1", turnId: "turn-1" }, "foreign.json": foreign
  });
  const result = await f.invoke("B");
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.requests.map(request => [request.method, request.params.threadId, request.params.turnId]), [
    ["turn/interrupt", "thread-2", "turn-2"], ["turn/interrupt", "thread-1", "turn-1"]
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.stateDir, "state.json"), "utf8")).jobs.map(record => record.id), ["foreign"]);
  assert.equal(fs.existsSync(path.join(f.stateDir, "jobs/foreign.json")), true);
  assert.equal(fs.existsSync(f.brokerFile), true);
});

test("session end stops an idle broker with only terminal foreign records", async t => {
  const f = await fixture(t, { jobs: [job("done", "A", { status: "completed" })] });
  const result = await f.invoke("B");
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.requests.map(request => request.method), ["broker/shutdown"]);
  assert.equal(fs.existsSync(f.brokerFile), false);
});
