# PLAN — hardening dbeaver-mcp for public use

> **Status: Phases 1 and 2 implemented in v1.5.0.** All twelve items below are done.
> 45 tests pass; verified end-to-end against a live SSH-tunnelled Postgres 15.
> Phase 3 (CI, package metadata, `dbeaver.js` parser tests) is still open.

Audit of v1.4.0 (1,251 lines, 9 tests passing, no secrets in repo).

**Verdict:** usable by others, but not yet safe to hand to strangers unsupervised. The
architecture is sound — no credentials in the repo, passwords never in tool results,
banner discipline, stderr-only logging so the stdio protocol stays clean. The four items
in Phase 1 are genuine security risks, not style notes.

Suggested order: **Phase 1 as one pass, Phase 2 as a second, Phase 3 before publishing.**

---

## Phase 1 — Security. Fix before publishing

### 1. SSH host keys are accepted unconditionally
`src/tunnel.js:33` calls `conn.connect()` with no `hostVerifier`. Any host on the path can
impersonate the bastion and harvest the SSH password *and* the Postgres credentials
flowing through the tunnel. DBeaver itself checks `known_hosts`; this plugin silently
does not.

- Verify against `~/.ssh/known_hosts`.
- Fail closed on mismatch or unknown host.
- Offer TOFU only on explicit opt-in (env flag), never by default.

### 2. TLS verification is disabled
`src/query.js:156` sets `ssl: { rejectUnauthorized: false }` for *every* non-`disable`
sslmode. A user who configured `verify-full` in DBeaver gets silent MITM exposure here.

- Honor the actual sslmode from the JDBC URL.
- Only `require` may skip verification; `verify-ca` / `verify-full` must verify.

### 3. The read-only guard is regex theatre
`execute_query` blocks writes via `WRITE_HEAD` / `WRITE_FUNCS` pattern matching
(`src/query.js:4-7`). `SELECT my_volatile_fn()` where that function inserts — or any
VOLATILE function wrapper — walks straight through.

- Wrap non-write paths in `BEGIN READ ONLY` and let Postgres enforce the boundary.
- Keep the regex as a fast pre-filter for a better error message.

### 4. Fuzzy connection matching can write to the wrong database
`findConnection` (`src/dbeaver.js:137`) falls back to `includes()`. `"prod"` happily
resolves to `prod-staging` — or to `PROD LIVE`, whichever enumerates first. On
`write_query` / `run_script` that is a data-loss vector.

- Make ambiguous substring matches an error that lists the candidates.
- Reserve fuzzy matching for read paths only.

---

## Phase 2 — Stability, cross-platform, blast radius

### 5. No statement timeout
Nothing sets `statement_timeout` or `idle_in_transaction_session_timeout`. One bad join
hangs the agent indefinitely, and a failed transaction can leave the session
idle-in-transaction holding locks on a live database.

### 6. `bytea` and wide rows will detonate the context window
`shapeResult` caps rows (max 2000) but not bytes. A Buffer column serializes as
`{"type":"Buffer","data":[...]}` — thousands of integers per cell. Add a total payload
byte cap plus per-cell truncation.

### 7. `install-hosts.mjs` deletes home directories without checking what they are
`linkDir` (`scripts/install-hosts.mjs:57`) runs `rmSync(dest, { recursive: true, force:
true })` on `~/.codex/plugins/dbeaver-mcp` and friends. If that path is a real directory
rather than a stale link, its contents are gone. Stat it, confirm it is a
symlink/junction, otherwise refuse.

### 8. `~/.claude.json` is rewritten with no backup
`upsertClaudeJson` reparses and rewrites the user's entire global config. Malformed JSON
throws mid-setup; a bug there costs them every other MCP server. Write a `.bak` first,
and write atomically (temp file + rename).

### 9. Non-Postgres connections fail incoherently
Every DBeaver connection is handed to `pg` regardless of driver. A MySQL or SQLite entry
produces a confusing protocol error. Filter on `driver` in `loadConnections`, and say so
in `list_connections`.

### 10. Credential decryption failure kills everything
`loadConnections` lets `decryptCredentialsFile` throw, so `list_connections` dies entirely
if the user enabled a DBeaver master password or a version changed the format. Degrade:
return connections with `hasPassword: false` plus a diagnostic.

### 11. Linux Snap/Flatpak workspaces aren't found
`workspaceCandidates` misses `~/snap/dbeaver-ce/current/.local/share/DBeaverData/workspace6`
and the Flatpak equivalent — the two most common Linux installs. `DBEAVER_WORKSPACE` is
the documented escape hatch, but `doctor` should hint at those paths.

### 12. Shutdown only handles SIGINT
`main()` registers `SIGINT` alone; on Windows, host processes typically terminate children
without it. SSH tunnels and the pg client leak. Add `SIGTERM` and stdin-close handling.

---

## Phase 3 — Polish before distribution

- **No CI.** A GitHub Actions matrix across windows/macos/ubuntu on Node 20/22 would catch
  most of the above regressing.
- **`package.json` metadata.** Missing `repository`, `bugs`, `homepage`, `files`. No
  CHANGELOG despite a version history.
- **Test coverage.** Currently SQL-splitting and the banner only. Nothing covers
  `dbeaver.js` parsing — JDBC URLs, SSH config extraction, credential shapes — which is
  where real-world workspace variation will bite.
- **`SECURITY.md`.** Honest about the published AES key and EE being unsupported, which is
  good. It should also disclose items 1 and 2 as current limitations until fixed, plus a
  vulnerability-reporting address.

---

## Priority

Highest value per hour: **1, 3, 4, 5.** Those four convert "works on my machine" into
"safe against a live production database."

---

## Implementation log — v1.5.0

| # | Where | What shipped |
|---|-------|--------------|
| 1 | `src/knownhosts.js` (new), `src/tunnel.js` | Full OpenSSH `known_hosts` verification: wildcards, `!` negation, HMAC-SHA1 hashed hosts, `@revoked`, `@cert-authority`, `[host]:port`. Policies `strict` (default) / `tofu` / `insecure`; a *changed* key is refused even under TOFU. Rejection reason replaces ssh2's generic handshake error. Also fixed key/agent auth, which referenced an `ssh.privateKey` field nothing ever populated. |
| 2 | `src/query.js` `sslOptions()` | libpq semantics per mode; `verify-ca` verifies the chain, `verify-full` also the hostname. Through a tunnel, `ssl.servername` carries the real host so verification is meaningful behind `127.0.0.1`. Root cert from `DBEAVER_MCP_SSL_ROOT_CERT`, the JDBC `sslrootcert`, or libpq's default paths. Unknown modes fail closed. |
| 3 | `src/query.js` `runQuery()` | Reads run in `BEGIN TRANSACTION READ ONLY`; the regex is now only a pre-filter for a friendly message. Verified live: `SHOW transaction_read_only` returns `on` inside `execute_query`. Statements Postgres cannot run in a transaction (VACUUM, `CREATE INDEX CONCURRENTLY`, `ALTER SYSTEM`, …) are detected so auto-transaction does not break them. |
| 4 | `src/dbeaver.js` `resolveConnection()` | Ambiguity is an error listing candidates, never a silent first-match. Writes pass `fuzzy: false`. Duplicate exact names are also caught. |
| 5 | `src/query.js` | `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`, client-side `query_timeout`, and `application_name=dbeaver-mcp`. Per-call `timeoutMs` on the query tools. |
| 6 | `src/query.js` `capCell()` / `shapeResult()` | `bytea` becomes `{type, bytes, preview, truncated}` instead of a byte array; BigInt and Date made JSON-safe; per-cell and per-call byte budgets shared across statements, reported as `truncatedBytes`. |
| 7 | `scripts/install-hosts.mjs` `linkDir()` | Only ever removes a symlink/junction. A real directory is refused with a message; an already-correct link is a no-op. |
| 8 | `scripts/install-hosts.mjs` | `.dbeaver-mcp.bak` backup plus temp-file-and-rename for every config write, including the Codex TOML. Malformed JSON aborts that step without writing. Each host is an independent step, so one failure no longer stops the rest. |
| 9 | `src/dbeaver.js` `isPostgresDriver()` | Non-Postgres connections are listed with `supported: false` and refused at query time with a clear reason; a workspace-level warning names them. |
| 10 | `src/decrypt.js`, `src/dbeaver.js` | `CredentialsError` with actionable hints (master password / PRO workspace / format change); plain-JSON credential files supported. Failure degrades to `hasPassword: false` plus a warning instead of killing `list_connections`. |
| 11 | `src/dbeaver.js` `workspaceCandidates()` | Snap, Flatpak, `XDG_DATA_HOME`, `LOCALAPPDATA`, macOS `Application Support`, and a scan for any `workspace*` directory under each `DBeaverData` root. `doctor` prints every path it tried. |
| 12 | `src/index.js` | `SIGINT`/`SIGTERM`/`SIGHUP`/`SIGBREAK`, stdin `end`/`close`, transport `onclose`, and a synchronous `process.on('exit')` sweep. Shutdown is idempotent. Tunnels are now keyed by promise so parallel queries share one tunnel instead of racing. |

**Bonus, found during the work:** catalog lookups in `list_tables` / `describe_table` used string
interpolation with hand-rolled quote escaping — now bound parameters. `splitStatements` did not
track double-quoted identifiers, so a `;` inside a quoted identifier split a statement in two.

**Verification:** 45 unit tests (up from 9) covering known_hosts matching and host-key decisions,
connection resolution, driver detection, cell capping and byte budgets, sslmode mapping, and
transaction-blocking statements. `npm run doctor` clean against a real 11-connection workspace;
MCP handshake plus `tools/list` over stdio; live read through an SSH tunnel to Postgres 15 with
strict host-key verification; installer exercised in a sandboxed `HOME` for the backup, the
malformed-config refusal, and the real-directory refusal.
