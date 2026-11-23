---
name: test-termbridge
description: Run termbridge's self-test (typecheck + integration suite) and interpret results. Use AFTER changing anything in packages/protocol, packages/relay, packages/host, packages/cli, or scripts/test.ts — i.e. anything touching the wire protocol, framing, session lifecycle, relay routing, or node-pty. Run it before telling the user a change is done.
---

# Testing termbridge

termbridge has no unit tests by design — the value is end-to-end (pty → host →
relay → client), so the suite boots **real** relay + host child processes and
drives them at the protocol level. One command runs everything.

## The one command

```bash
# Run from the repository root
pnpm test
```

`pnpm test` = `pnpm typecheck` (all 5 packages) **then** `tsx scripts/test.ts`
(integration). Success ends with `ALL PASS (9 scenarios)` and exit code 0.

If a relay/host from a previous run is stuck, clear orphans first:

```bash
pkill -f 'packages/(relay|host|cli)/src' 2>/dev/null; true
```

## What the integration suite asserts

| Scenario | Guards against |
|----------|----------------|
| 1. PTY round-trip | framing / sid routing — bytes must survive pty→host→relay→client + clean exit code |
| 2+3+4. persistence + reattach + scrollback + list | session must outlive its viewer; reattach by id; scrollback replay; `session_list` |
| 5b. agent preset + default-host routing | host resolves `agent` via config (isolated `TB_CONFIG`); relay routes `''` to the only host |
| 5. multi-viewer broadcast | output fans out to every attached viewer |
| 6. CLI binary: `tb new -- echo` | the shipped `tb` client + dispatcher actually works |
| 7. config set / get | `tb set` persists an agent to the host config; `tb info` reads it; the new agent runs |
| 8. middle settings | `resolveRelayUrl` precedence (env > `tb middle` > local) + `middleToUrl` normalisation (bare ip→`:8001`, `ip:port`/`ws(s)://` preserved) |
| 9. relay password auth | boots a `TB_SECRET` relay+host; right password runs a session, wrong password is rejected pre-hello with `authentication failed` (HMAC challenge-response) |
| 10. self-signed wss + pin | generates a cert, boots a `wss://` relay+host; right fingerprint runs a session, wrong fingerprint is refused at TLS upgrade (no session) |

Tests set `TB_CONFIG` / `TB_SETTINGS` to temp files — they never read/write the
user's `~/.termbridge/{config,settings}.json`.

## When a change needs a NEW scenario

If you add a protocol message, a control flow, or a feature (e.g. P3 reverse
tool injection), add a scenario to `scripts/test.ts`:

- Use `makeClient()` for a protocol-level viewer (`createSession`, `attach`,
  `list`, `input`, `kill`).
- Use `waitOutput(client, /regex/)` to assert on PTY output, `client.state.exit`
  for exit codes, and the `onControl(t)` promise for control replies.
- Wrap it in `await scenario('N. name', async () => { ... })`.
- For long-lived shells use `BASH` (`bash --norc --noprofile -i`) so prompts are
  deterministic; send commands with a trailing `\n`.

A new wire message is not "done" until a scenario exercises it.

## Failure playbook

| Symptom | Cause → fix |
|---------|-------------|
| `posix_spawnp failed` | node-pty `spawn-helper` lost its +x bit → `node scripts/fix-pty-perms.mjs` (postinstall normally handles it), then re-run |
| `host not found` / `[connection error]` with empty msg | orphan relay/host or port race → run the `pkill` above, re-run |
| `unknown frame type N` | a relay↔host message wasn't enveloped, or client↔relay frame WAS enveloped — every relay→host message must be `[clientId][frame]` (clientId 0 = control-plane) AFTER the bare `auth_challenge`; client↔relay is bare frames |
| `authentication failed` everywhere | relay has a secret (`TB_SECRET`/settings) but the peer's doesn't match → set the same with `tb secret set` / `TB_SECRET` + restart, or clear with `tb secret unset`. The bare `auth_challenge` precedes `hello` (don't `decodeEnvelope` it on the host) |
| typecheck error | fix types before touching the runtime; integration won't run until typecheck passes |
| `ERR_PNPM_IGNORED_BUILDS` | approve native builds: `onlyBuiltDependencies` in pnpm-workspace.yaml already lists node-pty/esbuild/msgpackr-extract; run `pnpm install` |

See `docs/troubleshooting.md` for detail and `docs/protocol.md` for the wire
invariants the suite protects.
