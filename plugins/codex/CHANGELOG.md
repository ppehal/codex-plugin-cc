# Changelog

## 1.0.7-ppehal.3

- Keep `CLAUDE_ENV_FILE` bounded across SessionStart repeats: append an export only when the last assignment of its name differs, one line per export (`codex-env-file-idempotent-v1`). Without it, resumes and compactions grew the file until every Bash spawn failed with E2BIG.

## 1.0.7-ppehal.2

- Preserve the newly deployed SessionEnd safety patch: keep brokers serving another session, interrupt known own turns before cleanup, and retain the documented race/best-effort limits.

## 1.0.7-ppehal.1

- Add fresh named readonly tasks with complete policy/account admission before thread and turn, including detached job snapshots and observed policy results.
- Keep canonical rules/configuration/session storage while suppressing default-profile MCP/plugin startup with verified native overrides; retain memory-off startup/start/resume and safe idle broker auth recycling.
- Negotiate the experimental native permissions API and generate its TypeScript protocol types while retaining ordinary task/review/provider behavior.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
