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

function sessionStart(envFile, data, input) {
  const result = spawnSync(process.execPath, [HOOK, "SessionStart"], {
    input: JSON.stringify(input),
    env: { ...process.env, CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: data },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return fs.readFileSync(envFile, "utf8").split("\n").filter(Boolean);
}

// SessionStart fires again on every resume and compaction with the same CLAUDE_ENV_FILE. Appending
// unconditionally grew the file until every Bash spawn of the session failed with E2BIG.
test("SessionStart keeps CLAUDE_ENV_FILE bounded and last-wins", () => {
  const root = makeTempDir("ss-env-");
  const envFile = path.join(root, "env.sh");
  const data = path.join(root, "data");
  const input = { session_id: "s-1", transcript_path: path.join(root, "t.jsonl") };

  const first = sessionStart(envFile, data, input);
  assert.equal(first.length, 3);
  assert.deepEqual(sessionStart(envFile, data, input), first);

  const changed = sessionStart(envFile, data, { ...input, session_id: "s-2" });
  assert.equal(changed.length, 4);
  assert.equal(changed.at(-1), "export CODEX_COMPANION_SESSION_ID='s-2'");
  assert.deepEqual(sessionStart(envFile, data, { ...input, session_id: "s-2" }), changed);

  // Back to an earlier value: it must be appended again, so the last assignment stays effective.
  const reverted = sessionStart(envFile, data, input);
  assert.equal(reverted.length, 5);
  assert.equal(reverted.at(-1), "export CODEX_COMPANION_SESSION_ID='s-1'");
});
