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

- Never print database or SSH passwords.
- Prefer `dbeaver__execute_query` for reads.
- Confirm before `dbeaver__write_query` on live data.
