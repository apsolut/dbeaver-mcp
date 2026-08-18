# HOWTO — dbeaver-mcp

How to use the tools once the plugin is installed. For clone / setup / first ask, stay in [README.md](./README.md).

## Which tool

| You want | Tool |
|----------|------|
| See what DBeaver knows | `list_connections` then `test_connection` |
| One or more `SELECT`s | `execute_query` |
| One `INSERT` / `UPDATE` / `DDL` | `write_query` |
| Several writes that must succeed together | `run_script` with `transaction: true` (default when anything writes) |
| “Why did INSERT fail with duplicate key?” | `inspect_sequences` |
| Columns of a table | `describe_table` |

`name` is the DBeaver connection name, id, or a unique substring.

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

Fix a stuck sequence (this is a **write**):

```
write_query
  name: PSN LIVE
  query: SELECT setval('pages_id_seq', (SELECT MAX(id) FROM pages), true)
```

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
| Unknown connection | `list_connections`. Name is case-sensitive except for unique substring match. |
| No database password | Open the connection once in DBeaver and save the password. `hasPassword` must be true. |
| Workspace not found | `npm run doctor`. Set `DBEAVER_WORKSPACE` to the folder that contains `General/.dbeaver/data-sources.json`. |
| SSH timeout / auth fail | Test the same connection inside DBeaver first. This plugin does not use your SSH agent unless DBeaver stored that setup. |
| `execute_query` refuses `SELECT setval` | That is a write. Use `write_query`. |
| Empty result for two SELECTs (old plugin) | Upgrade to 1.3+. You should now get `results[]`. |
| `duplicate key` on INSERT | `inspect_sequences` then `setval`. |
| Agent does not see new tools | Restart the agent after `git pull`. Confirm `ENTRY` still points at this checkout. |

## What this plugin is not

- Not a generic cloud-database MCP. Connections come from **DBeaver Community** on this machine.
- Not DBeaver EE / PRO (different secret store).
- Not a dump / restore / Payload helper. Keep product-specific scripts in the app repo.
