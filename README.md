# Courseflow framework

A Node.js server that hosts **platform modules**. Every platform integration (智慧树, 超星, MOOC,
资源库) is a separate repository shipping a signed artifact that this framework downloads, verifies
and runs as a child process. The framework owns the parts that must not vary: HTTP, sessions,
encryption, storage and scheduling.

This is the **v0.1 draft** of the modularization direction described in
[`courseweave/docs/MODULARIZATION.md`](../courseweave/docs/MODULARIZATION.md). It runs, it hosts a
module end to end, and it deliberately stops short of the full feature set — see
[Not in this draft](#not-in-this-draft).

- Contract: [`spec/module-api-v1.md`](spec/module-api-v1.md)
- Reference module (Node): [`modules/simulator`](modules/simulator)
- Reference module (Rust): [`../courseflow-zhs`](../courseflow-zhs) — live 智慧树 (real QR login,
  course list, shared-course outline, video study); its default source is the real platform, and
  `{"source":"fixture"}` runs offline against recorded fixtures.

---

## Run it

Requires Node ≥ 24 (TypeScript runs natively; there is no build step) and `npm`.

```sh
npm install
npm start                       # http://127.0.0.1:8099
```

First run prints a one-time administrator setup code in the terminal. Open the URL, paste the code,
create the admin account.

`argon2` ships prebuilt binaries. If your npm blocks install scripts and the prebuild is missing for
your platform, approve and rebuild it: `npm install-scripts approve argon2 && npm rebuild argon2`.

Runtime data lives outside the checkout (`$XDG_DATA_HOME/courseflow` or `~/.local/share/courseflow`):

```
courseflow.db        SQLite: users, sessions, modules, tasks, sealed state
secret.key           AES-256-GCM master key, 32 bytes, mode 0600
modules/<id>/<ver>/  installed module versions
```

## Install a platform module

```sh
npm run cli -- module add ../courseflow-zhs   # directory or .tgz
npm run cli -- module list
npm run cli -- module config zhs '{"source":"fixture"}'
npm run cli -- module disable zhs
```

Installing validates the manifest (`moduleApi`, `engines.framework`, permissions), pins a sha256 of
the declared files, copies them into the data directory and records it. A directory install copies
only `courseflow.module.json`, `runtime.entry` and `runtime.files` — pointing it at a Rust checkout
does not drag `target/` along. Enabling spawns the process and completes the handshake.

## Test

```sh
npm test          # unit + end-to-end (installs the simulator module, runs a study job)
npm run typecheck # tsc --noEmit; Node strips types without checking them
```

The integration test covers: setup code, session cookie + CSRF, module install and handshake, QR
login round trip, courses, units with server-resolved presentation, a two-unit study job driven by
`study.step`, sealed checkpoints, and module disable.

---

## How it works

```
browser ──HTTPS──▶ Fastify 5 process
                     ├─ auth · vault · SQLite · CSRF/Origin · quiet hours
                     ├─ module manager: install, verify, spawn, restart, stop
                     ├─ job engine: study.step loop, checkpoints, cancellation
                     └─ host services (cw.*) ── the only way a module can reach the outside
                          │
                          │ NDJSON JSON-RPC over stdio
                          ├─▶ cw-module-zhs      (Rust child process)
                          └─▶ simulator          (Node child process)
```

A module never opens a socket and never receives a credential. Everything it does goes through the
framework:

| Service | What the framework enforces |
| --- | --- |
| `cw.net.fetch` | https only, host suffix allowlist from the manifest, cookie/token injection, redirect allowlist, quiet hours on write stages, write-ledger commit points, `401`/`403`/`418`/`429` mapping |
| `cw.session.identity` | the platform identity the framework stored at `auth.complete` (`account_raw`, `display_name`) — never a cookie or token |
| `cw.state` | namespaced per `(module, owner, namespace, key)`, sealed with the vault, unreadable by other modules |
| `cw.clock.now` | one clock, so tests can freeze time |
| `cw.log` | logs to stderr of the framework, tagged by module |

And the framework can call into the module for `platform.describe`, `auth.*`, `catalog.*`,
`study.step`, all with a 30 s cap. Session handles (`ch_…`, `s_…`) are issued by the framework, so a
module cannot name a session it was not given, nor read another platform's cookies.

### Where the invariants live

- **Quiet hours** are fixed UTC+8 23:00–07:00 and are checked when a task is created, between study
  steps, and inside every non-read `cw.net.fetch`. `CF_QUIET_HOURS_DISABLED_UNTIL=<unix>` is a
  time-boxed development override, never a permanent switch.
- **Encryption** is byte-compatible with the Rust server it replaces: AES-256-GCM,
  `0x01 | nonce(12) | ciphertext|tag(16)`, AAD `["<owner>","<scope>"]`, scopes `"<pid>/session"` and
  `"job/<id>"`. A data directory written here can be read by the Rust binary and vice versa.
- **Passwords** are Argon2id at the same parameters as the Rust implementation
  (`m=19456,t=2,p=1`), so existing hashes verify without a migration.
- **Checkpoints and sessions** are sealed at rest; the API never returns cookies, keys or sealed
  blobs.

### Module lifecycle

```
install → validate manifest → sha256 pin → copy to modules/<id>/<version>/
enable  → spawn (node --permission, or the binary directly)
        → platform.describe within 5 s  (validate moduleApi + platform id)
        → ready; calls multiplexed with a 30 s cap
crash   → backoff 1s, 2s, 5s, 15s, 30s → give up until an admin re-enables
disable → SIGTERM, SIGKILL after 5 s
```

For the `node` engine the child runs under Node's permission model with no `--allow-net`,
`--allow-child-process` or `--allow-worker`, so its only egress is `cw.net.fetch`. That is not a
kernel sandbox (Node says so itself) — it is a blast-radius and accident control; see the direction
document for the honest ceiling.

---

## Not in this draft

Deliberately out of scope, in rough priority order:

- **Answer/exam jobs** — only `study` is driven today. The `exam.*` methods are specified but not
  implemented in the framework or the modules.
- **Scheduler parity** — no per-account leases, no cross-course parallelism, no submission locks
  beyond the `write_ledger` table, no automatic resume after the night pause (the task stays
  `paused` until a user resumes it).
- **Readback verification** — the Rust executor re-reads the outline up to 6 times before accepting
  a completed unit. This draft trusts `study.step`'s evidence and records it.
- **Browser and AI services** — `cw.browser.*` and `cw.ai.generate` are specified but not wired.
- **Module signatures** — install pins a sha256 but there is no ed25519 verification yet, and no
  `.tgz` upload through the web UI (the CLI accepts one). The admin-only `POST /api/modules/install`
  takes a server-side path, so it is a scripting convenience, not a distribution channel.
- **Data migration from the Rust server** — the formats line up (§Encryption above) but the schema
  is a fresh `user_version = 1`; the additive v7 migration is still a design in the direction doc.
- **Frontend** — a single vanilla page for setup, connection, courses and tasks. No SSE, no answer
  or record views.

## Layout

```
spec/module-api-v1.md      the contract both this repo and every module repo implement
src/main.ts                CLI: serve, module add/list/enable/disable/remove/config, doctor
src/runtime.ts             Fastify app + routes + wiring
src/modules/protocol.ts    manifest validation, semver gate, DTOs, presentation resolution
src/modules/runner.ts      child process, NDJSON, request correlation, timeouts, restart hooks
src/modules/net.ts         cookie jar, allowlist, redirects, the single outbound path
src/modules/manager.ts     install/enable/disable, host services, platform operations
src/sessions.ts            challenge and session handles; sealed `"<pid>/session"` records
src/jobs.ts                study driver: steps, checkpoints, cancellation, quiet pause
src/db.ts                  node:sqlite schema
src/vault.ts               AES-256-GCM, byte-compatible with the Rust server
src/auth.ts                Argon2id, sessions, CSRF, legacy PBKDF2 verification
src/domain.ts              clock, digest, quiet-hours policy
src/errors.ts              AppError and the module-error → HTTP status mapping
modules/simulator/         reference module used by the tests
test/                      unit + end-to-end
```

## Writing a module

1. Read [`spec/module-api-v1.md`](spec/module-api-v1.md).
2. Implement `platform.describe` and answer every method you declare; return `unsupported_operation`
   for the rest.
3. Never write anything but JSON-RPC to stdout; log to stderr; exit 0 on stdin EOF.
4. Test against a mock host: no network, no account. The simulator (Node) and
   `courseflow-zhs` (Rust) are the two reference implementations.
5. Ship `courseflow.module.json` next to your entry point, and pin `engines.framework`.
