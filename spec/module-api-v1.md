# Courseflow module API v1

**Status:** draft, `moduleApi: 1`. Everything here is a contract between the framework and a
platform module. Both sides may be written in any language; only the wire format is specified.

A module is a **child process** that speaks newline-delimited JSON-RPC on stdin/stdout. It never
opens a socket, never reads a credential, and never touches the database. The framework owns
HTTP, sessions, storage and time.

- Framework: Node.js + TypeScript, one process.
- Module: any executable (this repository ships `courseflow-zhs` in Rust).
- Transport: one JSON object per line, UTF-8, `\n` terminated, on stdin and stdout.
- stderr is for logs and is never parsed. **stdout is protocol-only.**

---

## 1. Artifact and manifest

A module directory contains:

```
courseflow.module.json     manifest (below)
<entry>                    executable or ESM entry point, per manifest.runtime
README.md                  optional
```

Packed as an npm-style `.tgz` (`package/` root) or installed from a directory.

```jsonc
{
  "schemaVersion": 1,
  "id": "zhs",                        // unique, stable, equals the platform id
  "name": "智慧树",
  "version": "0.1.0",
  "moduleApi": 1,                     // integer major gate
  "engines": { "framework": ">=0.1.0-0 <0.2.0" },   // semver range, must not be "*"
  "runtime": {
    "engine": "binary",               // "binary" | "node"
    "entry": "target/release/courseflow-zhs",
    "files": ["assets/"]              // optional extra files copied on install
  },
  "platform": {
    "id": "zhs",
    "name": "智慧树",
    "short": "智慧树",
    "login": ["qr"],                  // qr | password | browser
    "operations": ["study", "review", "meeting", "answer", "mastery", "qa", "ask"],
    "unit_kinds": ["video", "document"],
    "max_speed": 1.5,                 // optional
    "presentation": {
      "tabs": [
        { "id": "qa", "label": "问答区", "when": { "course.kind": "shared" } }
      ],
      "actions": [
        { "id": "trial", "label": "短时试跑", "when": { "course.family": "shared" } }
      ]
    }
  },
  "permissions": {
    "network": ["zhihuishu.com", "*.zhihuishu.com"],  // suffix allowlist
    "browser": false,
    "ai": true,
    "storage": "module"
  }
}
```

There is no `files`, `secrets` or `env` permission. A module cannot read the data directory or a
model key, by construction of the RPC surface in §4.

`when` predicates are evaluated **by the framework**, never by a module: supported keys are
`course.kind` and `course.family` with string equality. Unknown keys are a load-time error.

---

## 2. Framing and message shape

JSON-RPC 2.0 shaped, with two deliberate deviations:

1. `error.code` is a **stable string**, not an integer (see §6).
2. Notifications are used for logs and progress only.

```jsonc
// request  (id is a positive integer, unique per direction)
{"jsonrpc":"2.0","id":7,"method":"catalog.courses","params":{"session":"s_1b2c"}}

// success
{"jsonrpc":"2.0","id":7,"result":{"courses":[]}}

// failure
{"jsonrpc":"2.0","id":7,"error":{"code":"platform_login_expired","message":"智慧树登录已过期"}}

// notification (no id, no response)
{"jsonrpc":"2.0","method":"cw.log","params":{"level":"info","message":"loaded 3 courses"}}
```

The framework starts the process, then immediately calls `platform.describe`. Any non-protocol
line on stdout, or a describe that fails or exceeds 5 s, fails the load.

---

## 3. Framework → module methods

All calls have a **30 s wall-clock limit**. The framework kills a process that overruns twice.

`params.session` is always an opaque handle issued by the framework. A module must treat it as a
string and must not parse it. Handles come in two kinds:

| Kind | Prefix | Issued when | Used for |
| --- | --- | --- | --- |
| challenge | `ch_` | `auth.begin` | login traffic; has its own cookie jar |
| session | `s_` | `auth.complete` | all authenticated traffic |

### 3.1 `platform.describe`

```jsonc
// params
{"module_api": 1, "framework_version": "0.1.0", "limits": {"call_timeout_ms": 30000}}
// result
{
  "module": {"name": "courseflow-zhs", "version": "0.1.0", "module_api": 1},
  "platform": { /* same shape as manifest.platform, authoritative at runtime */ }
}
```

### 3.2 Authentication

```jsonc
// auth.begin {method:"qr", session:"ch_…"}  -> one of the platform's declared login methods
{"challenge": {"id": "ch_…", "kind": "qr", "image": "data:image/png;base64,…", "expires_at": 1794000000}}

// auth.poll {challenge:"ch_…", session:"ch_…"}
{"state": "waiting" | "scanned" | "connected" | "expired" | "failed"}

// auth.complete {challenge:"ch_…", session:"ch_…"}   (call only from "connected")
{"display_name": "张三", "account_raw": "10001"}

// auth.verify {session:"s_…"}  -> re-check a restored session
{"display_name": "张三"}
```

The framework digests `account_raw` into the account key `"<platform_id>/account/<sha256>"`. It is
the only identity a module learns about a user; it must be stable across logins and must not be an
email address, a cookie, or a token.

`auth.complete` never returns cookies. The framework persisted the challenge's cookie jar itself,
so a module cannot exfiltrate credentials even if compromised.

### 3.3 Catalog

```jsonc
// catalog.courses {session}
{"courses": [Course, …]}

// catalog.units {session, course: Course}
{"units": [Unit, …]}
```

### 3.4 Study

```jsonc
// study.step {session, course: Course, unit: Unit, checkpoint: <opaque object|null>, options: {}}
{"status": "in_progress", "progress": {"watched_seconds": 312}, "wait_ms": 15000, "checkpoint": {…}}
{"status": "completed",   "evidence": {"watched_seconds": 600}}
{"status": "needs_human", "reason": "interaction_popup" | "captcha" | "unknown_control" | "unit_limit"}
{"status": "blocked",     "reason": "activity_closed" | "below_pass_line" | "attempts_exhausted"}
{"status": "unknown",     "reason": "commit_unconfirmed"}
```

Rules:

- A step must not exceed 30 s of wall clock. Longer work is split across steps.
- `checkpoint` is opaque to the framework; it is sealed at rest and passed back verbatim.
- `wait_ms` is capped by the framework (60 s) and re-checked against quiet hours.
- A step must be safe to re-invoke after a framework restart: re-read state before writing.
- `completed` must carry evidence the framework can record. Readback verification (`catalog.units`
  later showing `state == "completed"`) is a framework policy, not a module obligation: a fixture
  source may be unable to reflect progress, so the framework takes the evidence from the step.

---

## 4. Module → framework services

Every service is `cw.`-prefixed and is the module's only way to reach the outside world.
Calls are synchronous from the module's point of view (request/response with an id).

### 4.1 `cw.net.fetch`

```jsonc
// params
{
  "session": "ch_…" | "s_…",
  "method": "GET" | "POST" | "PUT",
  "url": "https://passport.zhihuishu.com/qrCodeLogin/getLoginQrImg",
  "headers": {"Origin": "https://onlineweb.zhihuishu.com"},   // optional
  "body": <string | object>,                                  // optional
  "encoding": "raw" | "json" | "form" | "query",              // default "raw"
  "stage": "read" | "open_study" | "save_study" | "submit",   // default "read"
  "commit": false                                             // write-ledger commit point
}
// result
{"status": 200, "headers": {"content-type": "application/json"}, "body": "{…}"}
```

The framework:

- rejects any URL whose host is not in `permissions.network` (`net_blocked`);
- rejects `open_study` / `save_study` / `submit` during quiet hours (`quiet_hours`);
- injects cookies from the handle's jar and a bearer token if the session has one;
- refuses `Cookie`, `Host` and `Content-Length` in `headers` (`net_blocked`);
- follows at most 8 redirects, staying within the allowlist;
- maps `401` → `platform_login_expired`, `403/418/429` → `platform_verification_required`;
- records `commit: true` calls in the write ledger before sending.

`body` is always returned as a UTF-8 string. Binary payloads are base64 within the platform's own
JSON, as 智慧树 does.

### 4.2 `cw.state`

```jsonc
// get
{"namespace": "study", "key": "queue", "session": "s_…"}
{"value": <any|null>}
// set  (returns {})
{"namespace": "study", "key": "queue", "value": <any>, "session": "s_…"}
```

Scoped to `(module id, owner, namespace)`, sealed at rest, never readable by another module.
`cw.state` is the canonical method — the presence of `value` makes it a write; `cw.state.get` and
`cw.state.set` are accepted aliases with identical parameters.

### 4.3 `cw.session.identity`

```jsonc
// params
{"session": "s_…"}
// result — the identity the framework stored at auth.complete; never a cookie or token
{"account_raw": "10001", "display_name": "张三", "connected_at": 1794000000}
```

A module needs a stable platform identity for request fields that the platform expects to match the
logged-in user. This is the only place it can get one. For a challenge handle the values are empty.

### 4.4 `cw.clock.now`

```jsonc
{"now": 1794000000}   // unix seconds
```

### 4.5 `cw.log`

Notification, either direction. `{"level":"debug"|"info"|"warn"|"error","message":"…","fields":{}}`.

---

## 5. Data types

All field names are `snake_case` (they are the wire format, not an internal style).

```ts
interface Course {
  id: string;                 // platform course id
  recruit_id: string;         // class / recruit id, "0" when the platform has none
  name: string;
  kind: string;               // "shared" | "smart" | "chapter" | "catalog"
  kind_label?: string;        // display label, e.g. "共享课"
  family?: string;            // stable machine taxonomy for framework rules
  progress?: number | null;   // 0..100
  outline_available: boolean;
}

interface Unit {
  id: string;
  name: string;
  chapter_id: string;
  chapter_name: string;
  lesson_id: string;
  kind: string;               // "video" | "audio" | "document" | "reading" | "empty"
  duration_seconds?: number | null;
  watched_seconds?: number | null;
  state: "not_started" | "in_progress" | "completed" | "unknown";
  video_id?: string | null;
  selectable: boolean;        // framework renders selection from this, never infers it
  selectable_note?: string;   // shown when selectable is false
}
```

There is deliberately no `native` field in the wire types. A module that needs to remember
platform-shaped data puts it in `checkpoint` (per job) or `cw.state` (per user).

---

## 6. Error codes

| Code | Meaning | Framework HTTP mapping |
| --- | --- | --- |
| `unsupported_operation` | method not implemented by this module | 501 |
| `invalid_params` | bad or missing parameters | 400 |
| `platform_login_expired` | session no longer valid | 409 |
| `platform_verification_required` | platform wants a challenge solved | 409 |
| `platform_protocol_changed` | response shape not understood | 502 |
| `platform_rejected` | platform refused the action | 502 |
| `platform_unavailable` | network or platform outage | 502 |
| `not_found` | course / unit / resource missing | 404 |

Framework-generated codes (never sent by a module): `module_timeout`, `module_crashed`,
`module_unavailable`, `module_version_changed`, `net_blocked`, `quiet_hours`.

---

## 7. Lifecycle

1. **Install** — manifest validated, `moduleApi` and `engines.framework` checked, network
   permissions shown to the admin, files placed under `modules/<id>/<version>/`, sha256 pinned in
   `modules.lock.json`. A directory install copies only the manifest, `runtime.entry` and
   `runtime.files` — never a build tree that happens to sit beside them; a `.tgz` install is
   unpacked as-is. The sha256 covers exactly the declared files, so both paths agree.
2. **Spawn** — `node` engine: `node --permission --allow-fs-read=<dir> <entry>`; `binary` engine:
   `<entry>` directly. Working directory is the module directory. Environment is empty except
   `PATH`, `TZ=UTC`, `CF_MODULE_ID` and `CF_MODULE_SETTINGS` (a JSON object from the module's
   configuration in `modules.lock.json`, `{}` when unset).
3. **Handshake** — `platform.describe` within 5 s; the result must match the manifest's
   `platform.id`, and every declared operation must be dispatchable.
4. **Calls** — multiplexed; each limited to 30 s.
5. **Restart** — exponential backoff 1 s → 30 s, max 5 attempts, then `module_unavailable` until
   an admin re-enables it. In-flight jobs pause, they do not fail.
6. **Stop** — `SIGTERM`, then `SIGKILL` after 5 s. Piped stdin is closed first.

The framework keeps at most one process per module (a pool may come later without a contract change).

---

## 8. Versioning

- `moduleApi` is the integer major gate. The framework supports `N` and `N-1`.
- Additive changes do not bump `moduleApi`; a module declares the framework range it was built
  against in `engines.framework`.
- A breaking change bumps `moduleApi`, ships a migration note, and the previous major is supported
  for one release cycle.
- The framework refuses to load a module whose `moduleApi` or engine range does not match, naming
  both versions in the error.

---

## 9. Conformance checklist

A module is v1-conformant when:

- [ ] `platform.describe` answers within 5 s and matches its manifest.
- [ ] stdout contains only protocol lines; every line parses.
- [ ] every `id` in a response matches a request the framework sent.
- [ ] unknown methods return `unsupported_operation`, never a crash.
- [ ] every declared `login` method and `operations` entry either works or returns a typed error.
- [ ] no call exceeds 30 s.
- [ ] `study.step` is safe to re-invoke with the same input.
- [ ] the process exits on stdin EOF (framework stop) with code 0.
- [ ] a test pass exists against a mock host (no network, no account).

`courseflow-zhs` implements this checklist and its `tests/` double as the reference.
