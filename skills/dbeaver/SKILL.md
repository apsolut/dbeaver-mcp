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
| `execute_query` | Read-only (`SELECT` / `WITH` / `EXPLAIN` / `SHOW`). |
| `write_query` | INSERT / UPDATE / DELETE / DDL. Confirm first on live. |
| `list_schemas` | Non-system schemas. |
| `list_tables` | Tables in a schema (default `public`). |
| `describe_table` | Columns for one table. |

`name` accepts a connection name, id, or a unique substring.

## Rules

- Prefer `execute_query` for reads. Writes go through `write_query`.
- Live DBs: backup or confirm before mutating.
- `maxRows` defaults to 200 (cap 2000). `truncated: true` means more rows exist.
- Override workspace with `DBEAVER_WORKSPACE` if DBeaver is not in the default path.

## CLI

```bash
npm run cli -- list
npm run cli -- test "My Connection"
npm run cli -- query "My Connection" "SELECT 1"
```
