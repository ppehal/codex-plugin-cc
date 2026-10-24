#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import { BROKER_BUSY_RPC_CODE, BROKER_ENDPOINT_ENV } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
// Separate import, so this patch applies to 1.0.4 and 1.0.6 (their state.mjs import lines differ in context).
import { readJobFile, resolveJobsDir } from "./lib/state.mjs";
import {
  clearBrokerSession,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import { loadState, resolveStateFile, saveState } from "./lib/state.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const state = loadState(workspaceRoot);
  const removedJobs = state.jobs.filter((job) => job.sessionId === sessionId);
  if (removedJobs.length === 0) {
    return;
  }

  for (const job of removedJobs) {
    const stillRunning = job.status === "queued" || job.status === "running";
    if (!stillRunning) {
      continue;
    }
    try {
      terminateProcessTree(job.pid ?? Number.NaN);
    } catch {
      // Ignore teardown failures during session shutdown.
    }
  }

  saveState(workspaceRoot, {
    ...state,
    jobs: state.jobs.filter((job) => job.sessionId !== sessionId)
  });
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

// local patch codex-session-end-keep-busy-broker-v1: one broker serves every session of a workspace,
// so a session that ends must not stop it while a job of another session (or of none) still runs.
// Upstream stops it unconditionally; a short `claude -p` in the repo then killed a running
// validation (2026-10-23). Any doubt about another session's job keeps the broker.
// Upstream exports no terminal-status predicate; these are the statuses it writes.
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);
const INTERRUPT_BUDGET_MS = 2000;

function readJobStateFile(file) {
  let value;
  try {
    value = readJobFile(file);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (value === null || typeof value !== "object") {
    throw new Error(`${path.basename(file)} is not a JSON object`);
  }
  return value;
}

// A job pid is a companion process (task worker or foreground task). A pid that now runs something
// else, or a zombie, marks a stale record; without a readable /proc the pid alone decides.
function isJobProcessAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
  }
  if (!fs.existsSync("/proc/self")) {
    return true;
  }
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("codex-companion");
  } catch (error) {
    return error?.code !== "ENOENT";
  }
}

// state.json and jobs/*.json can each miss a live job or its turn ids (unlocked read-modify-write,
// pruning), so both count. A job file whose id state.json marks terminal is skipped: it can hold a
// large result.
function jobFilePaths(cwd, stateJobs) {
  const settled = new Set(stateJobs.filter((job) => TERMINAL_JOB_STATUSES.has(job?.status)).map((job) => `${job.id}.json`));
  const jobsDir = resolveJobsDir(cwd);
  let names = [];
  try {
    names = fs.readdirSync(jobsDir);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  return names.filter((name) => name.endsWith(".json") && !settled.has(name)).map((name) => path.join(jobsDir, name));
}

function readJobRecords(cwd) {
  const state = readJobStateFile(resolveStateFile(cwd));
  if (state && !Array.isArray(state.jobs)) {
    throw new Error("state.json has no jobs array");
  }
  const records = [...(state?.jobs ?? [])];
  for (const file of jobFilePaths(cwd, records)) {
    const job = readJobStateFile(file);
    if (job) {
      records.push(job);
    }
  }
  for (const job of records) {
    if (!job || typeof job !== "object") {
      throw new Error("malformed job record");
    }
  }
  return records;
}

// A record without a pid, or with an unknown status, counts as live.
function foreignLiveJobIds(cwd, sessionId) {
  const ids = new Set();
  for (const job of readJobRecords(cwd)) {
    if (TERMINAL_JOB_STATUSES.has(job.status) || (sessionId && job.sessionId === sessionId)) {
      continue;
    }
    if (Number.isFinite(job.pid) && !isJobProcessAlive(job.pid)) {
      continue;
    }
    ids.add(String(job.id ?? "<no id>"));
  }
  return [...ids];
}

function brokerRequest(endpoint, method, params, timeoutMs) {
  return new Promise((resolve) => {
    let socket;
    let buffer = "";
    let timer = null;
    const finish = (outcome) => {
      clearTimeout(timer);
      socket?.destroy();
      resolve(outcome);
    };
    try {
      socket = net.createConnection({ path: parseBrokerEndpoint(endpoint).path });
    } catch (error) {
      finish(`error: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    timer = setTimeout(() => finish("timeout"), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: 1, method, params })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        let message = null;
        try {
          message = JSON.parse(buffer.slice(0, newlineIndex));
        } catch {
          // Not a JSON line; keep reading.
        }
        buffer = buffer.slice(newlineIndex + 1);
        if (message?.id === 1) {
          finish(!message.error ? "ok" : message.error.code === BROKER_BUSY_RPC_CODE ? "busy" : `error: ${message.error.message}`);
          return;
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
    socket.on("error", (error) => finish(`error: ${error.message}`));
    socket.on("close", () => finish("closed"));
  });
}

function ownTurnJobs(cwd, sessionId) {
  const turns = new Map();
  const consider = (job) => {
    if (job?.sessionId === sessionId && !TERMINAL_JOB_STATUSES.has(job.status) && job.threadId && job.turnId) {
      turns.set(`${job.threadId} ${job.turnId}`, job);
    }
  };
  const stateJobs = loadState(cwd).jobs;
  stateJobs.forEach(consider);
  let files = [];
  try {
    files = jobFilePaths(cwd, stateJobs);
  } catch {
    // An unreadable jobs dir leaves the turns state.json names.
  }
  for (const file of files) {
    try {
      consider(readJobFile(file));
    } catch {
      // An unreadable job file names no turn to interrupt.
    }
  }
  return [...turns.values()];
}

// Upstream's shutdown ended this session's own turns together with the inner app-server. A kept
// broker would let them run on after the session, so interrupt them before their workers are
// killed. One at a time (a concurrent second request gets the broker's busy reply), a busy reply
// caused by another client is retried, and all of it shares one deadline inside the hook's 5 s.
async function interruptOwnTurns(endpoint, cwd, sessionId) {
  if (!endpoint || !sessionId) {
    return [];
  }
  const deadline = Date.now() + INTERRUPT_BUDGET_MS;
  const outcomes = [];
  try {
    for (const job of ownTurnJobs(cwd, sessionId)) {
      let outcome = "skipped, no time left";
      while (Date.now() < deadline) {
        outcome = await brokerRequest(endpoint, "turn/interrupt", { threadId: job.threadId, turnId: job.turnId }, deadline - Date.now());
        if (outcome !== "busy") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      outcomes.push(`interrupt ${job.id}: ${outcome}`);
    }
  } catch (error) {
    outcomes.push(`interrupt failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return outcomes;
}

function noteKeptBroker(logFile, sessionId, reason) {
  if (!logFile) {
    return;
  }
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] session-end ${sessionId ?? "<unknown>"}: kept broker, ${reason}\n`, "utf8");
  } catch {
    // The note is diagnostic only.
  }
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || process.env[SESSION_ID_ENV];
  const brokerSession =
    loadBrokerSession(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null
        }
      : null);
  const brokerEndpoint = brokerSession?.endpoint ?? null;
  const pidFile = brokerSession?.pidFile ?? null;
  const logFile = brokerSession?.logFile ?? null;
  const sessionDir = brokerSession?.sessionDir ?? null;
  const pid = brokerSession?.pid ?? null;

  if (brokerSession) {
    let keepReason = null;
    try {
      const ids = foreignLiveJobIds(cwd, sessionId);
      if (ids.length > 0) {
        keepReason = `live jobs of other sessions: ${ids.join(",")}`;
      }
    } catch (error) {
      keepReason = `job state unreadable: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (keepReason) {
      const interrupts = await interruptOwnTurns(brokerEndpoint, cwd, sessionId);
      noteKeptBroker(logFile, sessionId, [keepReason, ...interrupts].join("; "));
      cleanupSessionJobs(cwd, sessionId);
      return;
    }
  }

  if (brokerEndpoint) {
    await sendBrokerShutdown(brokerEndpoint);
  }

  cleanupSessionJobs(cwd, sessionId);
  teardownBrokerSession({
    endpoint: brokerEndpoint,
    pidFile,
    logFile,
    sessionDir,
    pid,
    killProcess: terminateProcessTree
  });
  clearBrokerSession(cwd);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
