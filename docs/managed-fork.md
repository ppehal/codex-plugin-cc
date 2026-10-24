# Managed fork

This is `ppehal/codex-plugin-cc`, maintained from `openai/codex-plugin-cc` commit
`db52e28f4d9ded852ab3942cea316258ae4ef346` (1.0.6). Version `1.0.7-ppehal.1` identifies this fork's
changes; it is not an upstream OpenAI release. Original license and attribution remain intact.

## Named readonly tasks

The internal companion CLI supports this fresh opt-in:

```bash
node plugins/codex/scripts/codex-companion.mjs task \
  --fresh --permissions <named-profile-id> --permissions-policy-file <expected-policy.json> \
  --model <model> --effort <effort> --background --json --prompt-file <prompt.md>
```

Both named flags are required. Write/resume are rejected. Policy input is a regular file bounded to
1 MiB. Background requests store validated JSON, so workers never reopen the policy file. The library
also validates its own input snapshot before asynchronous work. Ordinary tasks, writes, resumes,
custom providers/API keys, reviews and native session transfer keep their existing behavior.

The expected `local-review-policy/v1` object has exactly these keys: `version`, `profile`,
`permissions`, `shell_environment_policy`, `allow_login_shell`, `web_search`, `approval_policy`,
`cli_auth_credentials_store`, `features`, `mcp_enabled`, `account_type`, `account_fingerprint`,
`provider`, `endpoint`. Supply the independently intended policy; do not approve an observed policy
merely because it happens to be enabled.

- Permissions have exactly `extends=":read-only"`, `filesystem`, `network={"enabled":false}`.
  Grants are scalar `read`/`deny`, with `:root=deny`, on absolute paths or `:root`/`:minimal`.
  Writable exceptions and nested controls fail. The caller owns intended readable paths and exclusion
  of credentials/private control records.
- Environment has exactly `inherit="none"` and a nonempty explicit string-valued `set`. Login shell
  is false, web search disabled, approval never, credential store file, and `mcp_enabled` empty.
- All 18 fixed features must be false: apps, plugins, hooks, browser_use, browser_use_external,
  browser_use_full_cdp_access, browser_annotation_api, computer_use, skill_mcp_dependency_install,
  multi_agent, multi_agent_v2, multi_agent_v2_dynamic_tools, remote_plugin, plugin_sharing,
  in_app_browser, in_app_local_automation, image_generation, shell_snapshot.
- Account type is ChatGPT; fingerprint is lowercase SHA256 of trimmed, lowercased account email,
  not an auth-token hash. Provider is OpenAI; endpoint is `https://chatgpt.com/backend-api/`.
  Alternate providers/endpoints and provider overrides cannot satisfy this opt-in.

Actual config/account are read before thread creation and again before the turn, using
`config/read(cwd,includeLayers=false)` and `account/read(refreshToken=false)`. Full projected policy
and actual subscription authority must match expectation. Schema null defaults normalize away;
unknown non-null controls fail closed. Both native requests use `permissions`, omitting legacy
sandbox fields. Missing/wrong `activePermissionProfile` stops before inference. Busy/refused broker
fallback observes its direct runtime anew; policy errors never downgrade to legacy execution.

Named task JSON and background results contain actual `activePermissionProfile`, `effectiveToolPolicy`
and `policyObservations.beforeThread`/`beforeTurn`. These are configuration admission evidence.
Successful turns and actual allowed/denied tool canaries separately prove model access/enforcement.
Protocol validation targets native CLI 0.163.0. Clients, including broker inner, negotiate
`experimentalApi=true`; builds generate experimental protocol types. An unsupported old warm broker
fails before the turn and is not globally modified or killed.

## Preserved patches and provenance

Three customizations from deployed 1.0.4 are maintained on upstream 1.0.6. Review required replacing
configuration relocation in the first customization:

1. On POSIX, the default home with a config uses bounded native MCP metadata discovery and startup
   overrides to disable apps/plugins and every discovered MCP server, including loaded project/system
   servers. The native config is checked before admitting requests. Literal dotted/quoted server names
   remain intact; transport credentials never enter the command line or error output. Discovery failure
   retains ordinary canonical-home startup; failed post-start verification closes only the owned child
   and refuses admission. Windows retains canonical-home startup because its launcher uses a shell.
   Explicit alternate homes stay explicit. No config/auth copy, directory relocation or state sharing
   occurs: native execution rules, relative paths, sessions, import ledger and writer locks keep their
   original home. Startup always disables memory use/generation.
2. Broker auth-file metadata changes recycle only a known idle inner, without another connected
   user or unanswered/unknown work. Recycle is single flight; close is bounded. An inner death
   releases its clients; later requests recover. Tests change dummy auth files only.
3. Fresh and resumed thread requests both disable memory use/generation, including warm brokers.

Compared with the old mirror, default-profile MCP suppression also covers loaded project/system
servers. Existing mirror-only sessions in `~/.codex-appserver` are retained and are not automatically
migrated or exposed in the default picker. Their owner can explicitly select that existing home for
recovery. Installation must coordinate old warm brokers; source preparation does not restart them.

The initial named-permissions input was the two-file F4 candidate derived from deployed 1.0.4. Its
expected/actual equality accepted matching enabled apps/MCP or omitted feature checks. This fork
closes that v1 schema at CLI/library boundaries and preserves newer transfer/import source. The
unchanged email isolation producer fixture is a delivery compatibility oracle; the checked-in fixture
uses synthetic paths and account data. No whole older file replaces an upstream 1.0.6 file.

## Delivery and installation boundary

Install a reviewed fork commit through the supported marketplace manager. Existing consumer identity
is `openai-codex` / `codex@openai-codex`; explicitly approve retargeting its source before doing so.
Do not create a competing same-name registration or silently overwrite custom configuration. Record
exact source commit/version, installed registry path/digests, preserved customizations, recovery source
and cooperative owner/broker window. Never hand-edit the active cache or stop another owner's broker.

Source checks/review, published CI, accepted installed bytes, native runtime acceptance and mailbox
admission are separate receipts. Source readiness grants no install, account/credential, production
or mailbox effects. Retain the prior accepted registry/source/version; rollback uses that supported
source under the same ownership/window rules.

## Verification

Run `npm ci`, `npm test`, `npm run build`, `npm run check-version`. The complete original suite remains
the upstream compatibility oracle; new cases exercise public CLI, detached status/result, admission,
input snapshots, fallback and preserved patches. No new CI runner/workflow is introduced. Keep fixture
HOME/TMPDIR/plugin data private; reclaim detached fake brokers only through their exact owned scope.

Real subscription proof keeps original auth readonly and all writable native state private. A setup
that prevents the native tool sandbox from starting is BLOCKED, not denial evidence. Collect successful
same-outer-environment controls, then actual allowed/denied commands under native named permissions,
with source/broker/thread/turn attribution and canary readback. Auth copies/login, API-key fallback
and global policy relaxation are never implicit setup steps.
