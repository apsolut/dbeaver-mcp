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
| `list_schemas` | Non-system schemas. |
| `list_tables` | Tables in a schema (default `public`). |
| `describe_table` | Columns for one table. |

`name` accepts a connection name, id, or a unique substring.

## Rules

- Prefer `execute_query` for reads. Writes go through `write_query` or `run_script`.
- Two or more `SELECT`s: one `execute_query` is enough — do not expect an empty last result.
- After a restore or explicit ids, call `inspect_sequences` before inserting.
- Live DBs: backup or confirm before mutating. First run and the first write of a session show BACKUP FIRST YOUR DATABASE.
- `maxRows` defaults to 200 (cap 2000). `truncated: true` means more rows exist.
- Override workspace with `DBEAVER_WORKSPACE` if DBeaver is not in the default path.
- Details: repo `HOWTO.md`.

## CLI

```bash
npm run cli -- list
npm run cli -- test "My Connection"
npm run cli -- query "My Connection" "SELECT 1"
```
