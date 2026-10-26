# Installation observation, 2026-10-26

This is a durable record of observed effects. It grants no installation, probe, model, or mailbox
permission to another session; receiving sessions use their own operator instructions.

## Installed source identity

- User plugin identity: `codex@openai-codex`, version `1.0.7-ppehal.2`.
- Marketplace: `ppehal/codex-plugin-cc`, pinned to `v1.0.7-ppehal.2`.
- Tag object: `76a2bb478426e5bd099453547d25f89471ff09c2`.
- Installed source commit: `dfdf424351669c9fcf2ee9d908812ae2f96786ee`.
- Source tree: `c5fe6146b1b01b0906a2f42c3962da2bce29efb0`.
- Independent post-effect readback: all 43 payload files, 255220 bytes, zero mismatches.
- Readback receipt SHA256: `d9502d64045ea64ab6c11a8e65e1a2d74f4704aa03ef47a48257a374611fcf04`.

The existing 1.0.4 and 1.0.6 cache source files and metadata were retained. Unrelated settings,
marketplace entries and plugin registrations stayed equal. The persistent data directory retained
its identity; data contents and secure-store values were not inspected. No uninstall, cache edit,
foreign process stop, session restart, CLI upgrade or skill installation was performed.

GitHub marketplace admission rejected a source that differed from the user declaration. A private
real-GitHub control reproduced the rejection, then succeeded after aligning that declaration. The
matching user setting was changed to the specified source before the supported add/update commands;
all bytes outside that setting were preserved. Registry and cache writes came from the manager.

## Validation boundary

Source PR [#4](https://github.com/ppehal/codex-plugin-cc/pull/4) passed 125 tests with zero failures
or skips and the generated build in [CI40091357577](https://github.com/ppehal/codex-plugin-cc/actions/runs/40091357577).
Its primary review finding about missing procfs was fixed; final pinned source review was CLEAN.

The actual installed environment has Claude Code 2.1.310 and Codex CLI 0.164.0. Source-native
foreground/background enforcement evidence used private CLI 0.163 and unchanged admission modules.
Fresh owned-broker, effective-policy, lifecycle and foreground/background acceptance against the
installed plugin/actual CLI remains NOT_RUN. No new model call or mailbox admission was performed.
The existing operations owner retains the mailbox mission; installation alone does not resume it.
