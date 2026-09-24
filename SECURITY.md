# Security

This repo stores **no** database passwords, SSH passwords, connection URLs, or dumps.

## What stays on the user's machine

DBeaver Community keeps credentials in its workspace, typically:

- Windows: `%APPDATA%\DBeaverData\workspace6\General\.dbeaver\credentials-config.json`
- macOS: `~/Library/DBeaverData/workspace6/…`
- Linux: `~/.local/share/DBeaverData/workspace6/…`

This plugin decrypts that file **locally** and never writes secrets back to disk or into tool results. `list_connections` only returns `hasPassword` / `hasSshPassword`.

## What is in this repo

`src/decrypt.js` includes DBeaver Community's published AES key (`DefaultSecureStorage.LOCAL_KEY_CACHE` in the DBeaver source). That key is public by design. Anyone with filesystem access to a Community workspace can already read those passwords. DBeaver **EE / PRO** uses a different store; this plugin does not support that.

## Transport security

- **SSH tunnels.** Host keys are verified against `~/.ssh/known_hosts` before any credential is
  sent. An unknown host, a changed key, or an `@revoked` entry aborts the connection.
  `DBEAVER_MCP_SSH_HOST_KEY_POLICY=tofu` trusts an unknown host on first use (a *changed* key is
  still refused); `=insecure` disables verification entirely and prints a warning on every
  connection. Do not use `insecure` against production.
- **TLS.** `sslmode` is honoured as libpq defines it. `require` encrypts without authenticating;
  `verify-ca` verifies the chain; `verify-full` also verifies the hostname — including through an
  SSH tunnel, where the real server name is used for verification rather than `127.0.0.1`.
  Unknown modes fail closed.

## Query safety

- `execute_query`, `list_*`, `describe_table` and `inspect_sequences` run inside
  `BEGIN TRANSACTION READ ONLY`. The read-only guarantee is enforced by Postgres, not by a regular
  expression, so a `SELECT` over a volatile data-modifying function cannot slip through.
- Writes require an exact connection name or id; substring matching is read-only.
- `statement_timeout`, `lock_timeout` and `idle_in_transaction_session_timeout` are set on every
  session so a runaway query cannot hold locks on a live database.
- Catalog lookups use bound parameters.

## Platform coverage

These controls are verified end-to-end on **Windows only**. The code paths are shared and unit
tested, but host key verification, TLS and the SSH tunnel have not been exercised against a real
server on macOS or Linux. Treat behaviour there as unproven and report anything that looks wrong.

## Reporting a vulnerability

Open a private security advisory on the repository, or contact the maintainer directly. Please do
not file a public issue with a working exploit against a live database.

## Safe to publish

Yes. Clone the plugin, run `npm run setup` on each PC. That PC's own DBeaver connections are used. Do not commit a DBeaver workspace, `.env`, or SQL dumps into this repo.
