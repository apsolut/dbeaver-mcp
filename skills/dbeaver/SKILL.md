---
name: dbeaver
description: Query DBeaver Community Postgres connections (including SSH tunnels). Use when the user asks to list DBeaver connections, run SQL, inspect a DBeaver database, or test a named connection.
---

# DBeaver MCP

Tools are prefixed `dbeaver__`. Connections come from the local DBeaver workspace. Passwords stay in the MCP process.

## Tools

| Tool | Use |
|------|-----|
| `list_connections` | Names, hosts, SSH hop. No secrets. |
| `test_connection` | Open tunnel if needed, `SELECT 1`. |
| `execute_query` | Reads. Multiple `SELECT`s return every result set. Refuses writes, including `setval`. |
| `write_query` | INSERT / UPDATE / DELETE / DDL. Several writes run in one transaction. Confirm first on live. |
| `run_script` | Ordered statements or a script. Transaction when anything writes. |
| `inspect_sequences` | Sequence `last_value` vs `MAX(column)`. Use before serial INSERTs after a dump. |
| `fix_sequences` | Reset sequences that are behind. Dry run unless `apply: true`. |
| `explain_query` | Query plan as JSON. `analyze: true` executes, so it is refused on writes. |
| `trust_ssh_host` | Show a bastion's host key fingerprint; record it only on confirmation. |
| `list_schemas` | Non-system schemas. |
| `list_tables` | Tables in a schema (default `public`). |
| `describe_table` | Columns for one table. |

`name` accepts a connection name, id, or a unique substring **for reads**. `write_query`,
`run_script` and `fix_sequences --apply` require the exact name or id — a partial match must never
be able to pick the database. An ambiguous name is an error; ask the user which one rather than
guessing again.

## Rules

- Prefer `execute_query` for reads. Writes go through `write_query` or `run_script`.
- Two or more `SELECT`s: one `execute_query` is enough — do not expect an empty last result.
- After a restore or explicit ids, call `inspect_sequences` before inserting, then `fix_sequences`
  (dry run first, show the plan, then `apply: true`).
- Live DBs: backup or confirm before mutating. First run and the first write of a session show
  BACKUP FIRST YOUR DATABASE.
- **Destructive SQL needs `confirm: true`** — `DROP`, `TRUNCATE`, `ALTER SYSTEM`, and `DELETE` /
  `UPDATE` with no `WHERE`. Do not set it reflexively. Say plainly what will be destroyed, check a
  backup exists, get the user's agreement, *then* re-send with `confirm: true`.
- **"Unknown SSH host key" is a security check, not a bug.** Call `trust_ssh_host`, show the
  fingerprint to the **user**, and wait for them to confirm it. Do not copy the fingerprint into
  `confirmFingerprint` yourself — that defeats the whole purpose. Never suggest
  `DBEAVER_MCP_SSH_HOST_KEY_POLICY=insecure`.
- If an expected tool is missing, the operator disabled it (`DBEAVER_MCP_READ_ONLY` or
  `DBEAVER_MCP_DISABLED_TOOLS`). Say so and stop — do not route around it with `execute_query`.
- `maxRows` defaults to 200 (cap 2000). `truncated: true` means more rows exist;
  `truncatedBytes: true` means the payload cap hit — narrow the SELECT.
- Override workspace with `DBEAVER_WORKSPACE` if DBeaver is not in the default path.
- Details: repo `HOWTO.md`.

## CLI

```bash
npm run cli -- list
npm run cli -- test "My Connection"
npm run cli -- query "My Connection" "SELECT 1"
```
