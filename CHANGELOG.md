# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
