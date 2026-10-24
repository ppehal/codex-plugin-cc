import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { runAppServerTurn, validateReadonlyPolicy } from "../plugins/codex/scripts/lib/codex.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { loadBrokerSession, sendBrokerShutdown } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");
const ORACLE = JSON.parse(fs.readFileSync(new URL("./fixtures/readonly-policy.json", import.meta.url), "utf8"));

function fixture(t, behavior = "review-ok") {
  const root = makeTempDir("np-");
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  for (const dir of [repo, bin, home]) fs.mkdirSync(dir);
  initGitRepo(repo);
  installFakeCodex(bin, behavior);
  const native = path.join(root, "native.json");
  const policy = path.join(root, "expected.json");
  fs.writeFileSync(native, JSON.stringify(ORACLE));
  fs.writeFileSync(policy, JSON.stringify(ORACLE.expected));
  const previous = { ...process.env };
  Object.assign(process.env, buildEnv(bin), { HOME: home, CODEX_HOME: path.join(home, "native"),
    CLAUDE_PLUGIN_DATA: path.join(root, "plugin"), FAKE_CODEX_NATIVE_FIXTURE: native });
  t.after(async () => {
    try {
      const session = loadBrokerSession(repo);
      if (session) await sendBrokerShutdown(session.endpoint);
    } finally {
      for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key];
      Object.assign(process.env, previous);
    }
  });
  return { root, repo, bin, home, native, policy,
    trace: () => fs.existsSync(path.join(bin, "requests.jsonl")) ? fs.readFileSync(path.join(bin, "requests.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [],
    state: () => JSON.parse(fs.readFileSync(path.join(bin, "fake-codex-state.json"), "utf8")),
    change: mutate => { const f = structuredClone(ORACLE); mutate(f); fs.writeFileSync(native, JSON.stringify(f)); },
    cli: (...args) => run(process.execPath, [SCRIPT, ...args], { cwd: repo, env: process.env }) };
}

function namedArgs(f) {
  return ["task", "--fresh", "--permissions", ORACLE.profile, "--permissions-policy-file", f.policy,
    "--model", "fixture-model", "--effort", "high", "--json", "inspect fixture"];
}

function assertNamedRequests(trace, expected = ORACLE.expected) {
  const requests = trace.filter(r => ["config/read", "account/read", "thread/start", "turn/start"].includes(r.method));
  assert.deepEqual(requests.map(r => r.method), ["config/read", "account/read", "thread/start", "config/read", "account/read", "turn/start"]);
  for (const r of requests.filter(r => r.method === "account/read")) assert.equal(r.params.refreshToken, false);
  for (const r of requests.filter(r => r.method === "config/read")) assert.equal(r.params.includeLayers, false);
  const thread = requests.find(r => r.method === "thread/start").params;
  const turn = requests.find(r => r.method === "turn/start").params;
  assert.equal(thread.permissions, expected.profile);
  assert.equal(turn.permissions, expected.profile);
  assert.equal(Object.hasOwn(thread, "sandbox"), false);
  assert.equal(Object.hasOwn(turn, "sandboxPolicy"), false);
  assert.equal(thread.model, "fixture-model");
  assert.equal(turn.model, "fixture-model");
  assert.equal(turn.effort, "high");
  assert.deepEqual(thread.config, { "memories.use_memories": false, "memories.generate_memories": false });
}

test("named foreground observes both native phases and preserves legacy resume", async t => {
  const f = fixture(t);
  const result = f.cli(...namedArgs(f));
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.activePermissionProfile, ORACLE.activePermissionProfile);
  assert.deepEqual(payload.effectiveToolPolicy, ORACLE.expected);
  assert.deepEqual(payload.policyObservations, { beforeThread: ORACLE.expected, beforeTurn: ORACLE.expected });
  assertNamedRequests(f.trace());
  assert.ok(loadBrokerSession(f.repo), "named mode requires a real owned fixture broker");
  const resumed = await runAppServerTurn(f.repo, { resumeThreadId: payload.threadId, prompt: "continue" });
  assert.equal(Object.hasOwn(resumed, "effectiveToolPolicy"), false);
  const request = f.trace().find(r => r.method === "thread/resume").params;
  assert.equal(request.sandbox, "read-only");
  assert.deepEqual(request.config, { "memories.use_memories": false, "memories.generate_memories": false });
});

test("named background snapshots policy before enqueue and persists native result", t => {
  const f = fixture(t, "slow-task");
  const launch = f.cli(...namedArgs(f), "--background");
  assert.equal(launch.status, 0, launch.stderr);
  const queued = JSON.parse(launch.stdout);
  const jobFile = path.join(path.dirname(queued.logFile), queued.jobId + ".json");
  assert.deepEqual(JSON.parse(fs.readFileSync(jobFile, "utf8")).request.permissionsPolicy, ORACLE.expected);
  fs.unlinkSync(f.policy);
  const waited = f.cli("status", queued.jobId, "--wait", "--timeout-ms", "15000", "--json");
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).job.status, "completed");
  const result = JSON.parse(f.cli("result", queued.jobId, "--json").stdout);
  assert.deepEqual(result.storedJob.result.effectiveToolPolicy, ORACLE.expected);
  assert.deepEqual(result.storedJob.result.activePermissionProfile, ORACLE.activePermissionProfile);
  assertNamedRequests(f.trace());
});

test("closed readonly v1 rejects unsafe, omitted and unknown caller-approved fields", () => {
  validateReadonlyPolicy(ORACLE.profile, ORACLE.expected);
  const changes = [p => p.features.apps = true, p => delete p.features.apps, p => p.features.extra = false,
    p => p.mcp_enabled.push("remote"), p => p.permissions.filesystem["/fixture/project"] = "write",
    p => p.permissions.filesystem["/fixture/project"] = { access: "read", write: true },
    p => p.permissions.filesystem.glob_scan_max_depth = 2, p => p.permissions.network.proxy_url = "http://localhost",
    p => p.permissions.network.enabled = true, p => p.permissions.workspace_roots = ["/fixture"],
    p => p.permissions.extends = ":workspace-write", p => p.permissions.filesystem[":root"] = "read",
    p => p.shell_environment_policy.inherit = "all", p => p.shell_environment_policy.set.PATH = null,
    p => p.allow_login_shell = true, p => p.web_search = "live", p => p.approval_policy = "on-request",
    p => p.cli_auth_credentials_store = "auto", p => p.account_type = "apiKey", p => p.account_fingerprint = "",
    p => p.provider = "custom", p => p.endpoint = "https://example.invalid/", p => p.extra = "ignored"];
  for (const mutate of changes) {
    const policy = structuredClone(ORACLE.expected); mutate(policy);
    assert.throws(() => validateReadonlyPolicy(ORACLE.profile, policy), /complete restrictive/);
  }
  assert.throws(() => validateReadonlyPolicy(":read-only", ORACLE.expected), /complete restrictive/);
});

test("named CLI invalid inputs fail before jobs, broker or native requests", t => {
  const f = fixture(t);
  const base = ["task", "--json", "inspect"];
  for (const args of [["--permissions", ORACLE.profile], ["--permissions-policy-file", f.policy],
    ["--permissions", "", "--permissions-policy-file", ""],
    ["--permissions", ORACLE.profile, "--permissions-policy-file", f.policy, "--write"],
    ["--permissions", ORACLE.profile, "--permissions-policy-file", f.policy, "--resume"]]) {
    const result = f.cli(...base, ...args); assert.notEqual(result.status, 0);
  }
  const bad = structuredClone(ORACLE.expected); bad.features.apps = true;
  fs.writeFileSync(f.policy, JSON.stringify(bad));
  assert.notEqual(f.cli(...namedArgs(f), "--background").status, 0);
  fs.writeFileSync(f.policy, " ".repeat(1024 * 1024 + 1));
  assert.notEqual(f.cli(...namedArgs(f)).status, 0);
  assert.deepEqual(f.trace(), []);
  assert.equal(fs.existsSync(path.join(process.env.CLAUDE_PLUGIN_DATA, "state")), false);
});

test("named library rejects legacy/resume overrides before native and freezes mutable inputs", async t => {
  const f = fixture(t);
  const base = { permissions: ORACLE.profile, permissionsPolicy: structuredClone(ORACLE.expected), prompt: "inspect", model: "fixture-model", effort: "high" };
  for (const mixed of [{ sandbox: "read-only" }, { sandboxPolicy: {} }, { write: true }, { resumeThreadId: "old" },
    { resume: true }, { resumeLast: true }, { approvalPolicy: "on-request" }, { permissions: null }, { permissionsPolicy: null }]) {
    await assert.rejects(runAppServerTurn(f.repo, { ...base, ...mixed }));
  }
  assert.deepEqual(f.trace(), []);
  const options = { ...base, permissionsPolicy: structuredClone(ORACLE.expected) };
  options.onProgress = () => { options.permissions = "changed"; options.permissionsPolicy.features.apps = true; };
  const result = await runAppServerTurn(f.repo, options);
  assert.deepEqual(result.effectiveToolPolicy, ORACLE.expected);
  assertNamedRequests(f.trace());
});

for (const [name, mutate, threadCount] of [
  ["initial policy mismatch", f => f.config.features.apps = true, 0],
  ["initial API key account", f => f.account = { type: "apiKey" }, 0],
  ["custom provider", f => f.config.model_provider = "custom", 0],
  ["OpenAI override", f => f.config.model_providers = { openai: { base_url: "https://example.invalid" } }, 0],
  ["endpoint override", f => f.config.chatgpt_base_url = "https://example.invalid/", 0],
  ["initial config RPC error", f => f.configError = true, 0],
  ["initial account RPC error", f => f.accountError = true, 0],
  ["missing active profile", f => f.activePermissionProfile = null, 1],
  ["wrong active profile", f => f.activePermissionProfile.id = "wrong", 1],
  ["wrong profile parent", f => f.activePermissionProfile.extends = ":workspace-write", 1],
  ["second policy drift", f => { f.secondConfig = structuredClone(f.config); f.secondConfig.features.apps = true; }, 1],
  ["second account drift", f => f.secondAccount = { ...f.account, email: "changed@example.invalid" }, 1],
  ["unknown non-null observed control", f => f.config.permissions[f.profile].network.proxy_url = "http://localhost", 0],
  ["observed environment mismatch", f => f.config.shell_environment_policy.set.HOME = "/other", 0]
]) test("named rejects " + name + " before turn", t => {
  const f = fixture(t); f.change(mutate);
  const result = f.cli(...namedArgs(f));
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(f.trace().filter(r => r.method === "thread/start").length, threadCount);
  assert.equal(f.trace().filter(r => r.method === "turn/start").length, 0);
});

test("busy broker fallback observes the direct runtime afresh", async t => {
  const f = fixture(t);
  const endpoint = createBrokerEndpoint(f.root);
  const seen = [];
  const server = net.createServer(socket => {
    let input = "";
    socket.on("data", data => {
      input += data;
      let newline;
      while ((newline = input.indexOf("\n")) >= 0) {
        const message = JSON.parse(input.slice(0, newline)); input = input.slice(newline + 1);
        seen.push(message.method);
        if (message.id !== undefined) socket.write(JSON.stringify(message.method === "initialize"
          ? { id: message.id, result: { userAgent: "owned-busy" } }
          : { id: message.id, error: { code: BROKER_BUSY_RPC_CODE, message: "owned broker busy" } }) + "\n");
      }
    });
  });
  await new Promise(resolve => server.listen(parseBrokerEndpoint(endpoint).path, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  process.env.CODEX_COMPANION_APP_SERVER_ENDPOINT = endpoint;
  const result = await runAppServerTurn(f.repo, { permissions: ORACLE.profile, permissionsPolicy: ORACLE.expected,
    prompt: "inspect", model: "fixture-model", effort: "high" });
  assert.ok(seen.includes("config/read"));
  assert.deepEqual(result.effectiveToolPolicy, ORACLE.expected);
  assertNamedRequests(f.trace());
});

test("managed startup keeps canonical rules, relative paths and private state while disabling MCP", { skip: process.platform === "win32" }, async t => {
  const f = fixture(t);
  const original = path.join(f.home, ".codex");
  fs.mkdirSync(path.join(original, "rules"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(original, "rules", "default.rules"), 'prefix_rule(pattern=["python3"], decision="forbidden")\n');
  fs.writeFileSync(path.join(original, "instructions.md"), "fixture instructions\n");
  fs.writeFileSync(path.join(original, "auth.json"), '{"fixture":true}\n');
  const config = 'model = "fixture"\nmodel_instructions_file = "instructions.md"\ncli_auth_credentials_store = "file"\n[mcp_servers.fixture]\ncommand = "unused"\n';
  fs.writeFileSync(path.join(original, "config.toml"), config, { mode: 0o600 });
  process.env.CODEX_HOME = original;
  process.env.FAKE_CODEX_MCP_LIST = JSON.stringify(["fixture", "a.b", 'quote"name'].map(name => ({ name, enabled: true, transport: { secret: "must-not-be-forwarded" } })));
  const launch = async () => {
    const client = await CodexAppServerClient.connect(f.repo, { disableBroker: true });
    await client.close();
    return f.state().launches.at(-1);
  };
  const first = await launch();
  assert.equal(first.codexHome, original);
  assert.equal(fs.existsSync(path.join(f.home, ".codex-appserver")), false);
  assert.equal(fs.readFileSync(path.join(first.codexHome, "config.toml"), "utf8"), config);
  assert.equal(fs.statSync(path.join(original, "config.toml")).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(path.join(first.codexHome, "rules", "default.rules"), "utf8"), /forbidden/);
  assert.equal(fs.readFileSync(path.join(first.codexHome, "instructions.md"), "utf8"), "fixture instructions\n");
  const memoryArgs = ["app-server", "-c", "memories.use_memories=false", "-c", "memories.generate_memories=false"];
  assert.deepEqual(first.argv, [...memoryArgs, "-c", "features.plugins=false", "-c", "features.apps=false", "-c",
    'mcp_servers={"fixture"={enabled=false},"a.b"={enabled=false},"quote\\"name"={enabled=false}}']);
  assert.equal(first.argv.some(arg => arg.includes("must-not-be-forwarded")), false);
  f.change(value => value.config.mcp_servers = { unexpected: { enabled: true } });
  await assert.rejects(launch(), /Cannot verify MCP\/plugin startup controls/);
  f.change(() => {});
  process.env.FAKE_CODEX_MCP_LIST = "invalid JSON";
  assert.deepEqual((await launch()).argv, memoryArgs);
  process.env.CODEX_HOME = path.join(f.home, "explicit");
  process.env.FAKE_CODEX_MCP_LIST = '[]';
  const explicit = await launch();
  assert.equal(explicit.codexHome, process.env.CODEX_HOME);
  assert.deepEqual(explicit.argv, memoryArgs);
});

test("managed broker recycles only known idle auth changes and recovers inner death", async t => {
  const f = fixture(t);
  fs.mkdirSync(process.env.CODEX_HOME);
  const auth = path.join(process.env.CODEX_HOME, "auth.json");
  fs.writeFileSync(auth, '{"fixture":1}\n');
  const changeAuth = value => fs.writeFileSync(auth, JSON.stringify({ fixture: value }));
  const open = () => CodexAppServerClient.connect(f.repo);
  let client = await open();
  await client.request("config/read", { cwd: f.repo, includeLayers: false });
  await client.close();
  changeAuth(2);
  client = await open();
  await client.request("config/read", { cwd: f.repo, includeLayers: false });
  assert.equal(f.state().appServerStarts, 2, "known idle auth change replaces inner");
  changeAuth(3);
  const other = await open();
  await other.request("config/read", { cwd: f.repo, includeLayers: false });
  assert.equal(f.state().appServerStarts, 2, "connected inner user prevents recycling");
  await other.close(); await client.close();
  f.change(value => value.loadedListError = true);
  client = await open();
  await client.request("config/read", { cwd: f.repo, includeLayers: false });
  assert.equal(f.state().appServerStarts, 2, "unknown idle status prevents recycling");
  f.change(() => {});
  const deadPid = f.state().launches.at(-1).pid;
  process.kill(deadPid, "SIGTERM");
  let timer;
  try {
    await Promise.race([client.exitPromise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("dead inner stranded its client")), 3000); })]);
  } finally { clearTimeout(timer); await client.close(); }
  client = await open();
  await client.request("config/read", { cwd: f.repo, includeLayers: false });
  assert.equal(f.state().appServerStarts, 3, "request after death starts a fresh inner");
  await client.close();
});
