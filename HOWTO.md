# HOWTO — dbeaver-mcp

How to use the tools once the plugin is installed. For clone / setup / first ask, stay in [README.md](./README.md).

## Which tool

| You want | Tool |
|----------|------|
| See what DBeaver knows | `list_connections` then `test_connection` |
| One or more `SELECT`s | `execute_query` |
| One `INSERT` / `UPDATE` / `DDL` | `write_query` |
| Several writes that must succeed together | `run_script` with `transaction: true` (default when anything writes) |
| “Why did INSERT fail with duplicate key?” | `inspect_sequences`, then `fix_sequences` |
| Repair every stuck sequence at once | `fix_sequences` (dry run), then `apply: true` |
| “Why is this query slow?” | `explain_query` |
| A tunnel fails with “Unknown SSH host key” | `trust_ssh_host` |
| Columns of a table | `describe_table` |

`name` is the DBeaver connection name or id. Reads also accept a **unique** substring; an ambiguous
one is rejected rather than guessed. `write_query` and `run_script` require the exact name or id.

## Reads: every result set

`pg` keeps only the **last** result if you send `SELECT a; SELECT b` as one simple query. This server splits on top-level `;` and runs each statement, so you get both.

```
execute_query
  name: PSN LIVE
  query: |
    SELECT id, name FROM regions ORDER BY id;
    SELECT id, name FROM cities ORDER BY id;
```

Response shape:

- One statement: `rowCount`, `fields`, `rows`, `truncated` (same as before).
- Several statements: `statementCount`, `results[]` (each with its own `sql`, `rows`, …). The first result is also copied to the top level so old callers still work.

Semicolons inside `'…'`, `E'…'`, `--` comments, `/* */`, and `$tag$…$tag$` are not treated as separators.

`maxRows` (default 200, max 2000) applies **per statement**. `truncated: true` means more rows existed.

## Writes

`execute_query` refuses anything that mutates, including:

- `INSERT` / `UPDATE` / `DELETE` / `ALTER` / `DROP` / `CREATE` / …
- `SELECT setval(...)` and `SELECT nextval(...)`
- `WITH … INSERT` (or `UPDATE` / `DELETE` / `MERGE`)

Use `write_query` for one statement, or `run_script` for a batch.

If `write_query` receives several statements and any of them write, they run in **one transaction** and roll back together on error.

## `run_script`

Use this for “insert lookup row, then attach listings”.

```
run_script
  name: PSN LIVE
  transaction: true
  statements:
    - INSERT INTO regions (name, code, …) SELECT … WHERE NOT EXISTS (…)
    - INSERT INTO cities (name, region_id, …) SELECT … FROM regions r WHERE r.code = 'istanbul'
    - UPDATE properties SET location_region_id = r.id FROM regions r WHERE r.code = 'istanbul' AND …
```

You can pass `script` (one string, split on top-level `;`) instead of or in addition to `statements`. Cap is 50 statements.

`transaction` default:

- **on** when there are 2+ statements and at least one writes
- **off** for a single statement, or an all-read batch
- set `transaction: true` or `false` to force it

## Sequences after a dump or manual INSERT

Postgres sequences do not catch up when you insert explicit ids. The next `INSERT` without an id then hits `duplicate key`.

```
inspect_sequences
  name: PSN LIVE
  schema: public          # optional
  table: pages            # optional — one table
```

Each row:

| Field | Meaning |
|-------|---------|
| `sequence` | e.g. `pages_id_seq` |
| `table` / `column` | Owned serial / identity column |
| `last_value` | Sequence position (`null` if never used) |
| `max_value` | `MAX(column)` on that table |
| `needs_reset` | `true` when the table is ahead of the sequence |

Fix every stuck sequence at once. Dry run first — it reports exactly what it would do and changes
nothing:

```
fix_sequences
  name: PSN LIVE
```

Then apply. This is a **write**, so it needs the exact connection name and runs every `setval` in
one transaction:

```
fix_sequences
  name: PSN LIVE
  apply: true
```

Or do a single one by hand:

```
write_query
  name: PSN LIVE
  query: SELECT setval('pages_id_seq', (SELECT MAX(id) FROM pages), true)
```

## Destructive SQL needs `confirm`

`write_query` and `run_script` refuse `DROP`, `TRUNCATE`, `ALTER SYSTEM`, and `DELETE` / `UPDATE`
without a `WHERE` unless you pass `confirm: true`.

The check runs per statement on the parsed batch, with string literals stripped first — so neither
`SELECT 1; DELETE FROM users` nor `UPDATE posts SET body = 'go where you like'` gets through on a
technicality.

It is a confirmation rather than a hard refusal on purpose: a flat block just teaches an agent to
rephrase the query until it slips past, which is worse than making it say out loud what it is about
to do.

## Restricting access

Set these in the MCP host config, not in the conversation — then the limits hold regardless of what
the agent decides to try.

| Variable | Effect |
|----------|--------|
| `DBEAVER_MCP_READ_ONLY=true` | `write_query`, `run_script`, `fix_sequences` are never registered |
| `DBEAVER_MCP_ALLOWED_CONNECTIONS` | Only these are reachable — others cannot even be named |
| `DBEAVER_MCP_WRITABLE_CONNECTIONS` | Narrower list that accepts writes (read prod, write dev) |
| `DBEAVER_MCP_DISABLED_TOOLS` | Remove named tools from the surface |

Names match connection name or id, case-insensitively, with `*` and `?` wildcards.

## Backup banner

On first run the server prints this to **stderr** (stdout is the MCP protocol) and includes it in the first `list_connections` / write result:

```
BACKUP FIRST YOUR DATABASE
Writes go last.  Dump goes first.
```

After that, a one-line reminder still goes to stderr on every start, and the full art shows once more on the **first write of each process**.

The first-run flag is `~/.dbeaver-mcp/backup-seen`. For tests or a fresh demo:

```bash
# Windows
set DBEAVER_MCP_STATE=%TEMP%\dbeaver-mcp-demo

# macOS / Linux
export DBEAVER_MCP_STATE=/tmp/dbeaver-mcp-demo
```

Delete `backup-seen` in that folder to see the art again.

## Live databases

- Backup or get a clear “yes” before `write_query` / `run_script`.
- Prefer `WHERE NOT EXISTS` / `ON CONFLICT` over blind inserts.
- Prefer `inspect_sequences` before inserting into serial tables after a restore.
- `DROP` / `TRUNCATE` are allowed by the server. Do not run them unless the user asked.

## SSH tunnels

If the DBeaver connection has an SSH hop, the first query opens a local tunnel and later queries reuse it. `test_connection` is the cheapest way to prove the hop works.

The plugin uses the SSH user/password/key **from DBeaver**. It does not read `~/.ssh/config`.

## CLI

```bash
npm run cli -- list
npm run cli -- test "PSN LIVE"
npm run cli -- query "PSN LIVE" "SELECT 1; SELECT current_user"
npm run cli -- sequences "PSN LIVE"
npm run cli -- sequences "PSN LIVE" public pages
```

`query` uses the same splitter as the MCP tools. Writes are allowed on the CLI — you typed them.

## Tests

```bash
npm test
```

Covers statement splitting and write detection. No database required.

## Troubleshooting

| Symptom | What to try |
|---------|-------------|
| Unknown connection | `list_connections`. Matching is case-insensitive; substrings work for reads only. |
| "is ambiguous — it matches N connections" | Use the full name or the id. This is deliberate: a partial match must never pick a database for you. |
| "Writes require an exact name or id" | Pass the exact `name` or `id` from `list_connections`. |
| No database password | Open the connection once in DBeaver and save the password. `hasPassword` must be true. If `list_connections` returns a `credentials-unreadable` warning, a DBeaver master password is blocking the local store. |
| Workspace not found | `npm run doctor`. Set `DBEAVER_WORKSPACE` to the folder that contains `General/.dbeaver/data-sources.json`. Snap and Flatpak installs are auto-detected. |
| "Unknown SSH host key" | `ssh-keyscan -p <port> <host> >> ~/.ssh/known_hosts`, or set `DBEAVER_MCP_SSH_HOST_KEY_POLICY=tofu`. |
| "SSH host key mismatch" | The bastion's key changed. Verify out-of-band, then `ssh-keygen -R <host>`. Do not bypass this. |
| SSH timeout / auth fail | Test the same connection inside DBeaver first. Agent auth needs `SSH_AUTH_SOCK` in the MCP server's environment, which desktop hosts usually do not provide. |
| Query hangs then errors | The 30s `statement_timeout` fired. Pass `timeoutMs`, or raise `DBEAVER_MCP_STATEMENT_TIMEOUT_MS`. |
| `truncatedBytes: true` in a result | The payload cap kicked in. Narrow the `SELECT` or raise `DBEAVER_MCP_MAX_BYTES`. |
| Connection has `supported: false` | That driver is not Postgres. This plugin speaks the Postgres wire protocol only. |
| `execute_query` refuses `SELECT setval` | That is a write. Use `write_query`. |
| Empty result for two SELECTs (old plugin) | Upgrade to 1.3+. You should now get `results[]`. |
| `duplicate key` on INSERT | `inspect_sequences` then `setval`. |
| Agent does not see new tools | Restart the agent after `git pull`. Confirm `ENTRY` still points at this checkout. |

## What this plugin is not

- Not a generic cloud-database MCP. Connections come from **DBeaver Community** on this machine.
- Not DBeaver EE / PRO (different secret store).
- Not a dump / restore / Payload helper. Keep product-specific scripts in the app repo.
