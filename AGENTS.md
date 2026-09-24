# AGENTS — dbeaver-mcp

Standalone MCP plugin. Source of truth is this folder.

## On a new PC

```bash
npm run setup
```

Then restart the agent and ask: `list DBeaver connections`.

If DBeaver is missing or in a custom path, set `DBEAVER_WORKSPACE` to the folder that contains `General/.dbeaver/data-sources.json`. Run `npm run doctor`.

## Point this agent at the server

Do **not** invent connection strings. The server reads DBeaver's local workspace.

| You are | Register with |
|---------|----------------|
| Grok | `grok plugin install <this-dir> --trust` and `grok plugin enable dbeaver-mcp` |
| Claude Code | `~/.claude.json` `mcpServers.dbeaver` → `node <this-dir>/src/index.js` |
| Codex | `~/.codex/config.toml` `[mcp_servers.dbeaver]` |
| Agy / Antigravity | `~/.gemini/config/mcp_config.json` `mcpServers.dbeaver` |

Or run `node scripts/install-hosts.mjs` from this directory. It writes those files using this checkout's absolute path.

## Rules

- On first run and before the first write, surface the BACKUP FIRST YOUR DATABASE banner and dump before mutating.
- Never print database or SSH passwords.
- Prefer `dbeaver__execute_query` for reads. Several SELECTs in one call return every result set. Reads run inside a Postgres `READ ONLY` transaction.
- Confirm before `dbeaver__write_query` or `dbeaver__run_script` on live data. Both require the **exact** connection name or id — substring matching is reads-only so a partial match cannot hit the wrong database.
- If a connection name is ambiguous, the server says so. Ask the user which one; do not retry with a different guess.
- An "Unknown SSH host key" error is a real security check, not a bug. Run `dbeaver__trust_ssh_host`, **show the fingerprint to the user and wait for them to confirm it** — do not echo it back into `confirmFingerprint` on your own initiative, that defeats the entire point. Never suggest `DBEAVER_MCP_SSH_HOST_KEY_POLICY=insecure`.
- Destructive SQL needs `confirm: true`. Do not set it reflexively: state plainly what will be dropped, truncated, or rewritten, confirm a backup exists, and get the user's agreement first.
- If a tool you expect is missing, the operator disabled it (`DBEAVER_MCP_READ_ONLY` / `DBEAVER_MCP_DISABLED_TOOLS`). Say so and stop — don't route around it with `execute_query`.
- `dbeaver__fix_sequences` is a dry run by default. Show the plan, then re-run with `apply: true`.
- `SELECT setval` / `nextval` are writes. Use `write_query`.
- After a dump or manual ids, `dbeaver__inspect_sequences` before inserting into serial tables.
- Full tool notes: `HOWTO.md`.
