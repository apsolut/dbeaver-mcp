# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.7.1] - 2026-09-26

### Fixed

- **A connection URL pasted into DBeaver's Host box produced an unusable host.** DBeaver stores
  exactly what was typed, and Supabase hands you a URL, so the host field could hold
  `https://ref.supabase.co` — which then failed as an opaque `ENOTFOUND https://…`. Scheme,
  embedded credentials and any path are now stripped, and a port found along the way is used only
  when nothing more explicit is configured. IPv6 literals in brackets are handled.
  Found in a real workspace, not in a test.

### Verified

- Live on PostgreSQL 17.7: `SHOW transaction_read_only` returns `on` inside `execute_query`, and
  the 1.7.0 read-only bypass was confirmed to be real before the fix — `COMMIT` and
  `SET TRANSACTION READ WRITE` each flipped it to `off` mid-session. Both are now refused.
- Live through an SSH tunnel: host key verification, port forward, and read-only enforcement.
- `pg_authid` and `pg_read_file` confirmed reachable inside a read-only transaction on a superuser
  connection, which is what the new refusals exist to stop.
- Still not verified anywhere: macOS and Linux against a real database.

## [1.7.0] - 2026-09-26

### Security

- **Fixed: the read-only guarantee could be ended from inside the SQL.** Reads run in
  `BEGIN TRANSACTION READ ONLY`, but transaction-control statements were not recognised as writes,
  so `COMMIT; SELECT writes_via_volatile_function()` committed the read-only transaction and ran the
  rest of the batch unprotected. `SET TRANSACTION READ WRITE` did the same, since Postgres accepts
  it before a transaction's first query. Transaction control (`BEGIN`, `COMMIT`, `ROLLBACK`, `END`,
  `ABORT`, `SAVEPOINT`, `RELEASE`, `PREPARE TRANSACTION`, `SET TRANSACTION`, `DISCARD`) is now
  refused on every path, reads and writes alike — a mid-batch `COMMIT` also quietly broke
  `run_script`'s single-transaction promise.
- **Fixed: statements could disarm the safety timeouts and change identity.**
  `SET statement_timeout = 0`, `RESET ALL`, `SET ROLE`, `SET SESSION AUTHORIZATION` and
  `SET session_replication_role` are refused for the same reason.
- **Credential stores and server-side file readers are blocked.** `pg_authid`, `pg_shadow`,
  `pg_user_mappings`, `pg_read_file`, `pg_read_binary_file`, `pg_stat_file` and the `pg_ls_*`
  family. These are plain reads that a read-only transaction permits, so on a superuser connection
  an agent could simply ask for the password verifiers. Opt back in with
  `DBEAVER_MCP_ALLOW_SENSITIVE_READS=true`. `explain_query` is covered too, since
  `analyze: true` executes.
- **Fixed: a quoted identifier could defeat the unbounded-write check.** Literal stripping ignored
  double-quoted identifiers, so `UPDATE t SET "where" = 1` contained the word `where` and was not
  flagged as rewriting every row.
- **Widened destructive-statement detection.** `DROP` now covers sequences, functions, procedures,
  routines, aggregates, triggers, types, domains, extensions, policies, publications,
  subscriptions, foreign tables, servers, rules, operators, casts and `DROP OWNED`. Previously only
  tables, schemas, roles, users, indexes and views required confirmation — `DROP SEQUENCE` and
  `DROP FUNCTION` went through unconfirmed. `ALTER TABLE … DROP COLUMN` / `DROP CONSTRAINT` is now
  flagged, and `CASCADE` is called out.

### Fixed

- **Sequence values lost precision past 2^53.** `inspectSequences` and `fix_sequences` ran bigint
  values through `Number()`, so a sequence on a large-id table could be reported as fine when it was
  behind, and `setval` could be issued with a *rounded* target — reintroducing exactly the
  duplicate-key failures the tool exists to fix. Both now compare and emit exact integers.
- **`fix_sequences` did not escape the identifiers it interpolated.** The generated
  `setval('schema.sequence'::regclass, …)` placed quoted identifiers inside a string literal without
  escaping single quotes, so a sequence or schema whose name contained `'` produced broken or
  injectable SQL. Non-integer `MAX()` values are now refused rather than guessed at.
- **Appending to `known_hosts` could destroy an existing entry.** A file not ending in a newline —
  common after hand-editing — had the new host key spliced onto its last line, corrupting both that
  host's key and the new one. A separator is now added when needed.
- **A host key of an unrecorded type was reported as a man-in-the-middle attack.** When
  `known_hosts` held only an `ssh-rsa` entry and the server negotiated `ssh-ed25519`, the mismatch
  path fired with attack wording. It is still refused — it genuinely cannot be verified — but the
  message now says which types are on file and how to record the missing one. Crying wolf here
  trains people to ignore the warning that matters; a *same-type* key change still reports as an
  attack.
- **`sslmode=prefer` and `sslmode=allow` could not connect to a server without TLS.** Both mean
  "encrypt if possible", but handing node-postgres an `ssl` object demands TLS, so these failed
  where DBeaver and `psql` succeed. They now fall back to plaintext, and only when the server itself
  reports no TLS support. `require` and the `verify-*` modes never fall back.
- `TRUNCATE`'s warning claimed it was "not recoverable by rollback". In PostgreSQL `TRUNCATE` is
  transactional; the real hazards are the `ACCESS EXCLUSIVE` lock and the skipped per-row triggers.

### Changed

- Test suite grows from 67 to 94.

## [1.6.1] - 2026-09-26

### Changed
- Examples use the placeholder connection name `ACME LIVE` / `ACME STAGING`. Earlier versions
  shipped a real connection name in `README.md`, `HOWTO.md` and in the `execute_query` tool
  schema. No credentials were ever involved — the name alone was the concern.
- `npm test` no longer depends on shell glob expansion, so the suite runs on Windows with
  Node 20. It previously passed `test/*.test.js`, which PowerShell does not expand and Node 20
  does not expand internally.
- Dependency updates closing 9 advisories: `fast-uri` (4 high, SSRF and host confusion), `hono`
  and `qs`. All transitive and on the HTTP layer; none on the credential or tunnel path.

### Note
- `1.6.0` was published to npm and unpublished the same day for the reason above. Use `1.6.1`.

## [1.6.0] - 2026-09-24

### Security
- **Fixed: TLS configured through DBeaver's SSL tab was ignored.** Only plain connection
  properties and the JDBC URL were read, so a connection whose SSL lives in the
  `handlers.postgre_ssl` block resolved to `sslMode: null` and connected in cleartext. The
  handler block is now read, and an enabled handler with no explicit mode is treated as
  `require`. A *disabled* handler's leftover settings are correctly ignored.
- Client certificate authentication (`sslcert` / `sslkey`) is now supported alongside the CA.
- Destructive statements require an explicit `confirm: true`: `DROP`, `TRUNCATE`,
  `ALTER SYSTEM`, and `DELETE` / `UPDATE` with no `WHERE`. Detection runs per statement on the
  parsed batch, and string literals are stripped first so a `WHERE` inside a value cannot pass
  as a predicate.

### Added
- **Connection policy**, all via environment so it does not depend on the agent cooperating:
  - `DBEAVER_MCP_READ_ONLY` — the whole server refuses to mutate; write tools are not registered
  - `DBEAVER_MCP_ALLOWED_CONNECTIONS` — only these connections are reachable, or even nameable
  - `DBEAVER_MCP_WRITABLE_CONNECTIONS` — separate, narrower list for writes
  - `DBEAVER_MCP_DISABLED_TOOLS` — remove named tools from the surface entirely
  - Names match by connection name or id, case-insensitively, with `*` / `?` wildcards
- `trust_ssh_host` — probes a bastion's host key **without authenticating**, reports the
  SHA256 fingerprint, and records it in `known_hosts` only when the caller echoes that exact
  fingerprint back. A key that differs from a recorded one is refused outright rather than
  offered for confirmation.
- `explain_query` — query plan as JSON. `analyze: true` is refused on writes, since
  `EXPLAIN ANALYZE` executes the statement.
- `fix_sequences` — resets sequences that have fallen behind `MAX(column)`. Dry run by default;
  `apply: true` runs the `setval` calls in one transaction.
- `list_connections` now reports per-connection `writable`, a `policy` summary, and how many
  connections were hidden.

### Changed
- `write_query` and `run_script` take an optional `confirm` flag, required for destructive SQL.
- A connection excluded by policy is not resolvable by name at all — the error no longer
  confirms that it exists.

### Fixed
- `splitStatements` now tracks double-quoted identifiers, so a `;` inside a quoted identifier
  no longer splits one statement into two.

## [1.5.0] - 2026-09-22

Security-hardening release.

### Security
- SSH host keys are now verified against `~/.ssh/known_hosts`. Strict verification is the default; `tofu` and `insecure` policies are available via `DBEAVER_MCP_SSH_HOST_KEY_POLICY`.
- `sslmode` is now honoured per libpq semantics, so `verify-ca` and `verify-full` actually verify — including the correct servername when connecting through an SSH tunnel.
- Reads run inside `BEGIN TRANSACTION READ ONLY`, so the read-only guarantee is enforced by Postgres rather than by a regex.
- Catalog lookups use bound parameters.

### Added
- Statement, lock, and idle-transaction timeouts, plus a per-call `timeoutMs`.
- Result byte budgets, with `bytea` values summarised instead of dumped.
- Detection and reporting of non-Postgres drivers.
- Snap/Flatpak/XDG DBeaver workspace detection.

### Changed
- **BREAKING:** SSH tunnels to hosts absent from `known_hosts` now fail until the key is added.
- **BREAKING:** `verify-ca`/`verify-full` connections may now fail where verification was previously skipped silently.
- **BREAKING:** `write_query` and `run_script` require an exact connection name or id; substring matching is reads-only.

### Fixed
- Credential decryption failure degrades to a warning instead of killing `list_connections`.
- Installer backs up configs and refuses to delete real directories.
- Shutdown handles `SIGTERM`, `SIGBREAK`, and stdin close, so SSH tunnels no longer leak.

## [1.4.0]

- Added `run_script`, multi-result reads, and sequence inspection.

## [1.3.0]

- Initial standalone dbeaver-mcp plugin for Grok, Claude Code, Codex, and Agy.
