# dbeaver-mcp

Standalone MCP plugin for **Grok**, **Claude Code**, **Codex**, and **Agy** (Antigravity).

Reads **DBeaver Community** connections on this PC, decrypts credentials locally, opens SSH tunnels, then talks to Postgres. Passwords never leave the process.

Works on any machine that has Node 20+ and DBeaver Community with saved connections.

## Other PC — one command

```bash
git clone <this-repo> dbeaver-mcp
cd dbeaver-mcp
npm run setup
```

That installs dependencies and points every agent it can find at **this checkout**. Restart Grok / Claude / Codex / Agy, then ask:

> list DBeaver connections

You should see `dbeaver__list_connections`, `dbeaver__execute_query`, `dbeaver__list_schemas`.

### Check the machine first

```bash
npm run doctor
```

If DBeaver is not in the default workspace:

```bash
# Windows
set DBEAVER_WORKSPACE=%APPDATA%\DBeaverData\workspace6

# macOS
export DBEAVER_WORKSPACE="$HOME/Library/DBeaverData/workspace6"

# Linux
export DBEAVER_WORKSPACE="$HOME/.local/share/DBeaverData/workspace6"
```

The workspace folder must contain `General/.dbeaver/data-sources.json`.

## Point one agent only

```bash
node scripts/install-hosts.mjs --hosts=grok
node scripts/install-hosts.mjs --hosts=claude
node scripts/install-hosts.mjs --hosts=codex
node scripts/install-hosts.mjs --hosts=agy
```

Or paste the same stdio server by hand (replace `NODE` and `ENTRY`):

| Agent | File | What to add |
|-------|------|-------------|
| **Grok** | plugin: `grok plugin install . --trust` then `grok plugin enable dbeaver-mcp` | also works via `~/.grok/plugins/dbeaver-mcp` link |
| **Claude Code** | `~/.claude.json` → `mcpServers.dbeaver` | `{ "command": "NODE", "args": ["ENTRY"] }` |
| **Codex** | `~/.codex/config.toml` | `[mcp_servers.dbeaver]` `command` + `args` |
| **Agy** | `~/.gemini/config/mcp_config.json` | `{ "mcpServers": { "dbeaver": { "command": "NODE", "args": ["ENTRY"] } } }` |

`ENTRY` is `…/dbeaver-mcp/src/index.js`. `NODE` is `node` on PATH, or the full `node.exe` path.

## Tools

| Tool | Role |
|------|------|
| `list_connections` | Names, hosts, SSH hop |
| `test_connection` | Open tunnel + `SELECT 1` |
| `execute_query` | Read-only SQL |
| `write_query` | INSERT / UPDATE / DELETE / DDL |
| `list_schemas` | Non-system schemas |
| `list_tables` | Tables in a schema |
| `describe_table` | Columns |

`name` matches connection name, id, or a unique substring.

## CLI (no agent)

```bash
npm run cli -- list
npm run cli -- test "My Connection"
npm run cli -- query "My Connection" "SELECT 1"
```

## Layout

```
.claude-plugin/     Grok + Claude Code
.codex-plugin/      Codex / ChatGPT
plugin.json         Agy marker
.mcp.json           plugin MCP (uses ${CLAUDE_PLUGIN_ROOT})
mcp_config.json     Agy MCP
src/                server
scripts/install-hosts.mjs
```
