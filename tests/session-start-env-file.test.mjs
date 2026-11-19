import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK =
  process.env.CODEX_TEST_SESSION_HOOK ||
  path.join(ROOT, "plugins/codex/scripts/session-lifecycle-hook.mjs");

function setup(t) {
  const root = makeTempDir("ss-env-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const envFile = path.join(root, "env.sh");
  const data = path.join(root, "data");
  const start = (input) => {
    const result = spawnSync(process.execPath, [HOOK, "SessionStart"], {
      input: JSON.stringify(input),
      env: { ...process.env, CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: data },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return fs.readFileSync(envFile, "utf8");
  };
  return { root, envFile, data, start };
}

// SessionStart fires again on every resume and compaction with the same CLAUDE_ENV_FILE. Appending
// unconditionally grew the file until every Bash spawn of the session failed with E2BIG.
test("SessionStart leaves CLAUDE_ENV_FILE unchanged on a repeat and keeps last-wins", (t) => {
  const { root, data, start } = setup(t);
  const transcript = path.join(root, "t.jsonl");
  const exports = (id) =>
    `export CODEX_COMPANION_SESSION_ID='${id}'\n` +
    `export CODEX_COMPANION_TRANSCRIPT_PATH='${transcript}'\n` +
    `export CLAUDE_PLUGIN_DATA='${data}'\n`;
  const input = { session_id: "s-1", transcript_path: transcript };

  const first = start(input);
  assert.equal(first, exports("s-1"));
  assert.equal(start(input), first);

  const changed = start({ ...input, session_id: "s-2" });
  assert.equal(changed, `${first}export CODEX_COMPANION_SESSION_ID='s-2'\n`);
  assert.equal(start({ ...input, session_id: "s-2" }), changed);

  // Back to an earlier value: appended again, so the last assignment stays the effective one.
  assert.equal(start(input), `${changed}export CODEX_COMPANION_SESSION_ID='s-1'\n`);
});

test("SessionStart compares against any writer's last assignment and keeps one line per export", (t) => {
  const { root, envFile, start } = setup(t);
  const transcript = path.join(root, "a\nCODEX_COMPANION_TRANSCRIPT_PATH=b'c.jsonl");
  const input = { session_id: "s-1", transcript_path: transcript };

  // Another hook's plain assignment after ours, and no trailing newline.
  fs.writeFileSync(envFile, "export CODEX_COMPANION_SESSION_ID='s-1'\nCODEX_COMPANION_SESSION_ID='other'");
  const first = start(input);
  assert.ok(first.startsWith("export CODEX_COMPANION_SESSION_ID='s-1'\nCODEX_COMPANION_SESSION_ID='other'\nexport CODEX_COMPANION_SESSION_ID='s-1'\n"));
  // A value with a newline stays on one line, so it cannot fake an assignment, and repeats do not grow.
  assert.equal(first.split("\n").filter((entry) => entry.includes("CODEX_COMPANION_TRANSCRIPT_PATH=")).length, 1);
  assert.equal(start(input), first);
  const sourced = spawnSync("bash", ["--noprofile", "--norc", "-c", `source "$1"; printf '%s' "$CODEX_COMPANION_TRANSCRIPT_PATH"`, "bash", envFile], { encoding: "utf8" });
  assert.equal(sourced.status, 0, sourced.stderr);
  assert.equal(sourced.stdout, transcript);
});
