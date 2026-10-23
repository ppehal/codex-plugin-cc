#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";

// --- local patch: codex-broker-auth-recycle-v1 ------------------------------
// Why: the inner `codex app-server` reads auth.json once and keeps the OAuth
// refresh token in memory. After `codex login` (or another app-server rotating
// the single-use refresh token) every later turn through this broker fails with
// "access token could not be refreshed". Upstream: openai/codex-plugin-cc#281, #789.
// Fix: snapshot auth.json identity when the inner app-server starts. When a new
// client connection makes its first request, no other connected client has used
// the inner app-server, no request is unanswered and the inner reports no active
// thread (thread/loaded/list + thread/read; even one whose client disconnected),
// replace the inner app-server if auth.json changed. A broker serving another client's job is never recycled. An
// inner that exits on its own is replaced on the next request; a failed restart
// shuts the broker down so the next job starts a fresh one.
// Preserved in this managed fork; provenance and delivery: docs/managed-fork.md.
function authFingerprint() {
  const home = os.homedir();
  const candidates = [
    path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "auth.json"),
    // MCP-free CODEX_HOME used by the local app-server.mjs patch; auth.json there is a symlink.
    path.join(home, ".codex-appserver", "auth.json")
  ];
  // Resolve symlinks first, so creating the alternate-home link is not mistaken for new auth.
  const files = new Set();
  for (const file of candidates) {
    try {
      files.add(fs.realpathSync(file));
    } catch {
      // Missing: nothing to fingerprint.
    }
  }
  return [...files]
    .sort()
    .map((file) => {
      try {
        const st = fs.statSync(file);
        // ctime cannot be set back by the writer, so it catches a rewrite that restores mtime.
        return `${file}:${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
      } catch {
        return `${file}:missing`;
      }
    })
    .join("|");
}

function brokerLog(message) {
  process.stdout.write(`[broker ${new Date().toISOString()}] ${message}\n`);
}
// --- end local patch ---------------------------------------------------------

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);
// local patch codex-broker-auth-recycle-v1: methods whose response means the work is done (or
// that start no work). Any other non-streaming method may queue work that starts after its
// response, so it holds off a recycle like a stream without a turn id.
const SYNCHRONOUS_METHODS = new Set([
  "account/read",
  "config/read",
  "model/list",
  "thread/list",
  "thread/loaded/list",
  "thread/name/set",
  "thread/read",
  "thread/resume",
  "thread/start",
  "turn/interrupt"
]);

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function isInterruptRequest(message) {
  return message?.method === "turn/interrupt";
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  writePidFile(pidFile);

  let innerAuthFingerprint = authFingerprint();
  let appClient = null;
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  // local patch codex-broker-auth-recycle-v1: turns the inner app-server is running, fed by its
  // own turn notifications and turn/start responses. The recycle asks the inner directly
  // (innerReportsIdle); this map covers work started during that check and keeps a turn that
  // already completed from claiming the stream.
  const runningTurns = new Map(); // turnId -> threadId
  const completedTurns = new Set();
  // Streams answered without a turn id (thread/compact/start): threadId -> answer time. Until
  // their turn/started arrives (or 60 s pass) the inner may be about to run work for them.
  const awaitingTurnStart = new Map();
  let turnStartsSeen = 0;
  const lastTurnStartByThread = new Map(); // threadId -> time of its latest turn/started
  let inFlightRequests = 0;
  let recycling = null;
  let shuttingDown = false;
  const sockets = new Set();

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
    }
  }

  function noteTurnStarted(turnId, threadId) {
    if (threadId) {
      awaitingTurnStart.delete(threadId);
      lastTurnStartByThread.delete(threadId);
      lastTurnStartByThread.set(threadId, Date.now());
      if (lastTurnStartByThread.size > 512) {
        lastTurnStartByThread.delete(lastTurnStartByThread.keys().next().value);
      }
    }
    if (turnId && !completedTurns.has(turnId)) {
      runningTurns.set(turnId, threadId ?? null);
    }
  }

  function noteTurnCompleted(turnId, threadId) {
    if (!turnId) {
      // No turn id to match: release every turn of that thread rather than block forever.
      for (const [id, owner] of runningTurns) {
        if (!threadId || owner === threadId) runningTurns.delete(id);
      }
      return;
    }
    runningTurns.delete(turnId);
    completedTurns.add(turnId);
    if (completedTurns.size > 256) {
      completedTurns.delete(completedTurns.values().next().value);
    }
  }

  function routeNotification(message) {
    if (message.method === "turn/started") {
      turnStartsSeen += 1;
      noteTurnStarted(message.params?.turn?.id, message.params?.threadId);
    } else if (message.method === "turn/completed") {
      noteTurnCompleted(message.params?.turn?.id, message.params?.threadId);
    }
    const target = activeRequestSocket ?? activeStreamSocket;
    if (target) {
      send(target, message);
    }
    // local patch codex-broker-auth-recycle-v1: release the stream on its turn/completed even when
    // the notification was routed elsewhere (its owner disconnected and another request is active);
    // otherwise the slot stays claimed forever and every later client gets "busy".
    if (message.method === "turn/completed" && activeStreamSocket) {
      const threadId = message.params?.threadId ?? null;
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        const owner = activeStreamSocket;
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        if (activeRequestSocket === owner) {
          activeRequestSocket = null;
        }
      }
    }
  }

  function adoptInner(client) {
    appClient = client;
    // Only the current inner may route or track anything; a replaced or dead inner can still
    // flush buffered stdout after its exit event.
    client.setNotificationHandler((message) => {
      if (appClient === client) {
        routeNotification(message);
      }
    });
    // An inner that exits on its own has nothing left to protect: drop the connections that
    // used it (their threads and turns died with it, and a client waiting for turn/completed
    // would hang) and start a new inner on the next request. A protocol error on a process
    // that is still alive also resolves exitPromise; the client keeps working after it, so
    // leave that inner alone until the process really exits.
    client.exitPromise.then(() => {
      if (client.proc && client.proc.exitCode === null && client.proc.signalCode === null) {
        client.proc.once("exit", () => dropInner(client));
        return;
      }
      dropInner(client);
    });
  }

  function dropInner(client) {
    if (appClient !== client) {
      return;
    }
    appClient = null;
    runningTurns.clear();
    awaitingTurnStart.clear();
    for (const socket of sockets) {
      if (socket.innerUsed) {
        socket.destroy();
      }
    }
    activeRequestSocket = null;
    activeStreamSocket = null;
    activeStreamThreadIds = null;
    brokerLog("inner app-server exited; dropped its clients, the next request starts a new one");
  }

  async function closeInner(client) {
    // Wait for the process itself, not only the client: after a protocol error exitPromise is
    // already resolved while the process may still run.
    const proc = client.proc;
    const exited = new Promise((resolve) => {
      if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
        resolve();
      } else {
        proc.once("exit", resolve);
      }
    });
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve(true), 5000);
    });
    const closed = Promise.all([client.close().catch(() => {}), exited]).then(() => false);
    const hung = await Promise.race([closed, timedOut]);
    clearTimeout(timer);
    if (hung) {
      try {
        proc?.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      brokerLog("inner app-server ignored close for 5 s; sent SIGKILL");
    }
  }

  // Ask the inner itself whether any loaded thread is still running. It is authoritative where
  // notification-based tracking is not (a turn/completed that never came, e.g. after the client
  // inferred completion, or a compaction that reports no turn id). If the inner cannot answer,
  // keep it: an unverifiable recycle could kill work, and keeping it is the unpatched behavior.
  // "systemError" stays on a thread after a failed turn until its next turn (a failed auth
  // refresh leaves exactly this), so it means "running" only while a turn of that thread is
  // still tracked; "active" always means running.
  function threadStatusIsIdle(threadId, status) {
    if (status === "idle" || status === "notLoaded") {
      return true;
    }
    if (status === "systemError") {
      return ![...runningTurns.values()].includes(threadId);
    }
    return false;
  }

  // A hung probe must never wedge the broker: give up after 10 s.
  function probeInner(client, method, params) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${method} timed out`)), 10000);
    });
    return Promise.race([client.request(method, params), timeout]).finally(() => clearTimeout(timer));
  }

  // The stream slot of a client that disconnected is released by its turn/completed, which may
  // never come (the client can infer completion). When such a slot makes the broker busy, ask the
  // inner once whether the stream's threads are still active and release the slot if not.
  let deadStreamCheck = null;
  function releaseDeadStreamIfIdle() {
    const owner = activeStreamSocket;
    const client = appClient;
    const threadIds = activeStreamThreadIds ? [...activeStreamThreadIds] : [];
    if (deadStreamCheck || !owner || sockets.has(owner) || !client || threadIds.length === 0) {
      return;
    }
    deadStreamCheck = (async () => {
      for (const threadId of threadIds) {
        const read = await probeInner(client, "thread/read", { threadId });
        if (!threadStatusIsIdle(threadId, read?.thread?.status?.type)) {
          return;
        }
      }
      if (activeStreamSocket === owner && appClient === client) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        if (activeRequestSocket === owner) {
          activeRequestSocket = null;
        }
        brokerLog("released the stream of a disconnected client; the inner reports its thread idle");
      }
    })()
      .catch(() => {})
      .finally(() => {
        deadStreamCheck = null;
      });
  }

  async function innerReportsIdle(client) {
    const probe = (method, params) => probeInner(client, method, params);
    const listLoaded = async () => {
      const ids = [];
      let cursor = null;
      do {
        const page = await probe("thread/loaded/list", cursor ? { cursor } : {});
        ids.push(...(page?.data ?? []));
        cursor = page?.nextCursor ?? null;
      } while (cursor);
      return ids;
    };
    const trackedBefore = new Set(runningTurns.keys());
    const startsBefore = turnStartsSeen;
    const now = Date.now();
    for (const [threadId, answeredAt] of awaitingTurnStart) {
      if (now - answeredAt > 60000) {
        awaitingTurnStart.delete(threadId);
      }
    }
    if (awaitingTurnStart.size > 0) {
      return false;
    }
    try {
      const threadIds = await listLoaded();
      for (const threadId of threadIds) {
        const read = await probe("thread/read", { threadId });
        if (!threadStatusIsIdle(threadId, read?.thread?.status?.type)) {
          return false;
        }
      }
      // A thread loaded after the first listing (e.g. a subagent spawned meanwhile) was not read.
      const verified = new Set(threadIds);
      const loadedNow = new Set(await listLoaded());
      if ([...loadedNow].some((threadId) => !verified.has(threadId))) {
        return false;
      }
      // Any turn that started while the probe ran was not covered by its reads.
      if (turnStartsSeen !== startsBefore || awaitingTurnStart.size > 0) {
        return false;
      }
      // Forget only turns of threads the inner just reported idle or no longer has loaded (an
      // unloaded thread cannot run); anything else stays tracked and makes the caller's
      // recheck keep the inner.
      for (const [turnId, threadId] of runningTurns) {
        if (trackedBefore.has(turnId) && threadId && (verified.has(threadId) || !loadedNow.has(threadId))) {
          runningTurns.delete(turnId);
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  // local patch codex-broker-auth-recycle-v1: callers guarantee no client is using the inner.
  // Single-flight: concurrent callers share one recycle, so at most one inner is ever spawned.
  function recycleInnerIfAuthChanged() {
    recycling ??= (async () => {
      if (shuttingDown) {
        throw new Error("Shared Codex broker is shutting down.");
      }
      const current = authFingerprint();
      if (appClient && current === innerAuthFingerprint) {
        return;
      }
      const previous = appClient;
      if (previous && !(await innerReportsIdle(previous))) {
        brokerLog("auth.json changed, but the inner app-server is busy or could not confirm it is idle; keeping it");
        return;
      }
      // The idle check awaited the inner; recheck what may have started meanwhile. Nothing
      // below awaits before appClient is cleared, so no request can slip in after this.
      if (previous && (inFlightRequests > 0 || activeStreamSocket || runningTurns.size > 0 || awaitingTurnStart.size > 0)) {
        brokerLog("auth.json changed, but work started during the idle check; keeping the inner app-server");
        return;
      }
      appClient = null;
      if (previous) {
        await closeInner(previous);
      }
      let next;
      let snapshot = current;
      for (let attempt = 1; ; attempt += 1) {
        try {
          next = await CodexAppServerClient.connect(cwd, { disableBroker: true });
        } catch (error) {
          // A failed start can leave a child without an owner. Exiting the broker closes its
          // stdin, and the next job starts a fresh broker (ensureBrokerSession) or goes direct.
          brokerLog(`inner app-server failed to start (${error.message}); shutting the broker down`);
          setImmediate(() => {
            void shutdown(server).finally(() => process.exit(1));
          });
          throw error;
        }
        if (shuttingDown) {
          await closeInner(next);
          throw new Error("Shared Codex broker is shutting down.");
        }
        // auth.json changed while the new inner was starting, so it may hold the older token.
        // Nothing uses it yet (the requester holds the broker), so start another; bounded.
        const after = authFingerprint();
        if (after === snapshot || attempt >= 3) {
          break;
        }
        brokerLog("auth.json changed while the new inner app-server was starting; starting another");
        await closeInner(next);
        snapshot = after;
      }
      innerAuthFingerprint = snapshot;
      adoptInner(next);
      brokerLog(`recycled idle inner app-server (${previous ? "auth.json changed since it started" : "no live inner app-server"})`);
    })().finally(() => {
      recycling = null;
    });
    return recycling;
  }

  async function shutdown(server) {
    shuttingDown = true;
    for (const socket of sockets) {
      socket.end();
    }
    await recycling?.catch(() => {});
    if (appClient) {
      await closeInner(appClient);
    }
    await new Promise((resolve) => server.close(resolve));
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  }

  adoptInner(await CodexAppServerClient.connect(cwd, { disableBroker: true }));

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
        }

        if (message.id === undefined) {
          continue;
        }

        const allowInterruptDuringActiveStream =
          isInterruptRequest(message) && activeStreamSocket && activeStreamSocket !== socket && !activeRequestSocket;

        if (
          ((activeRequestSocket && activeRequestSocket !== socket) || (activeStreamSocket && activeStreamSocket !== socket)) &&
          !allowInterruptDuringActiveStream
        ) {
          releaseDeadStreamIfIdle();
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }

        if (allowInterruptDuringActiveStream) {
          socket.innerUsed = true;
          inFlightRequests += 1;
          try {
            const result = await appClient.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
            });
          } finally {
            inFlightRequests -= 1;
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        activeRequestSocket = socket;
        // local patch codex-broker-auth-recycle-v1: only a fresh connection may swap the inner
        // app-server, and only while no other connection has used it and no request is
        // unanswered; a connection that used it may hold a thread that lives only in that
        // process. The recycle itself also asks the inner whether any thread is still running
        // (including one whose client disconnected). With no live inner there is nothing to protect.
        const mayRecycleInner =
          !socket.innerUsed &&
          ![...sockets].some((other) => other !== socket && other.innerUsed) &&
          !activeStreamSocket &&
          inFlightRequests === 0;
        socket.innerUsed = true;

        try {
          if (mayRecycleInner || !appClient) {
            await recycleInnerIfAuthChanged();
          }
          inFlightRequests += 1;
          const sentAt = Date.now();
          let result;
          try {
            result = await appClient.request(message.method, message.params ?? {});
          } finally {
            inFlightRequests -= 1;
          }
          // A turn that already completed (the notification can beat the response) must not
          // claim the stream, or nothing would release it.
          let turnAlreadyDone = false;
          if ((isStreaming && !result?.turn?.id) || (!isStreaming && !SYNCHRONOUS_METHODS.has(message.method))) {
            // Work may start after this response; unless its turn already started, wait for it.
            const workThreadId = message.params?.threadId ?? result?.reviewThreadId ?? "*";
            if (!((lastTurnStartByThread.get(workThreadId) ?? 0) >= sentAt)) {
              awaitingTurnStart.set(workThreadId, Date.now());
            }
          }
          if (isStreaming && result?.turn?.id) {
            if (result.turn.status === "inProgress" && !completedTurns.has(result.turn.id)) {
              noteTurnStarted(result.turn.id, message.params?.threadId);
            } else {
              noteTurnCompleted(result.turn.id, message.params?.threadId);
              turnAlreadyDone = true;
            }
          }
          send(socket, { id: message.id, result });
          if (isStreaming && !turnAlreadyDone) {
            activeStreamSocket = socket;
            activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          if (activeStreamSocket === socket && !isStreaming) {
            activeStreamSocket = null;
          }
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });

    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });
  });

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  server.listen(listenTarget.path);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
