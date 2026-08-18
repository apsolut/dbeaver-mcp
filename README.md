# dbeaver-mcp

Let an AI agent query **your** Postgres through **DBeaver Community** connections already saved on this PC.

It reads DBeaver’s workspace, decrypts credentials locally, opens an SSH tunnel when the connection uses one, and runs SQL. Passwords never appear in tool results and never leave this process.

Works with **Grok**, **Claude Code**, **Codex**, and **Agy** (Antigravity). Node 20+ required.

Need tools, transactions, sequences, or live-DB rules? See **[HOWTO.md](./HOWTO.md)**.

---

## 1. Install on this PC

```bash
git clone <this-repo> dbeaver-mcp
cd dbeaver-mcp
npm run setup
```

`setup` installs dependencies and points every agent it can find at **this checkout**.

Restart Grok / Claude / Codex / Agy.

## 2. Check the machine

```bash
npm run doctor
```

You want: Node 20+, DBeaver workspace found, at least one connection.

If DBeaver is not in the default place, point at the folder that contains `General/.dbeaver/data-sources.json`:

```bash
# Windows
set DBEAVER_WORKSPACE=%APPDATA%\DBeaverData\workspace6

# macOS
export DBEAVER_WORKSPACE="$HOME/Library/DBeaverData/workspace6"

# Linux
export DBEAVER_WORKSPACE="$HOME/.local/share/DBeaverData/workspace6"
```

Then run `npm run setup` again so the agent inherits the env, or set `DBEAVER_WORKSPACE` in the agent’s MCP config.

## 3. First ask

After restart:

> list DBeaver connections

You should see tools named `dbeaver__list_connections`, `dbeaver__execute_query`, `dbeaver__run_script`, `dbeaver__inspect_sequences`.

Then:

> test the connection named PSN LIVE  
> select id, name from regions limit 5 on PSN LIVE

The `name` argument is the DBeaver connection name, its id, or a unique substring (`PSN LIVE`, `live`, …).

## 4. Tools

| Tool | Use it for |
|------|------------|
| `list_connections` | Names, hosts, SSH hop. No secrets. |
| `test_connection` | Open tunnel + `SELECT 1` |
| `execute_query` | Reads. Several `SELECT`s return **every** result set |
| `write_query` | One mutating statement, or a few (writes are transactional) |
| `run_script` | Ordered list / script. Transaction when anything writes |
| `inspect_sequences` | Sequence `last_value` vs `MAX(column)` — `needs_reset` |
| `list_schemas` | Non-system schemas |
| `list_tables` | Tables in a schema |
| `describe_table` | Columns |

`execute_query` refuses writes, including `SELECT setval(...)`. Use `write_query` or `run_script` for those.

## 5. CLI (no agent)

```bash
npm run cli -- list
npm run cli -- test "PSN LIVE"
npm run cli -- query "PSN LIVE" "SELECT 1; SELECT current_database()"
npm run cli -- sequences "PSN LIVE"
npm run cli -- sequences "PSN LIVE" public pages
```

## 6. One agent only

```bash
node scripts/install-hosts.mjs --hosts=grok
node scripts/install-hosts.mjs --hosts=claude
node scripts/install-hosts.mjs --hosts=codex
node scripts/install-hosts.mjs --hosts=agy
```

Or wire stdio yourself (`NODE` = `node` or a full `node.exe` path, `ENTRY` = `…/dbeaver-mcp/src/index.js`):

| Agent | Where | What |
|-------|--------|------|
| **Grok** | `grok plugin install . --trust` then `grok plugin enable dbeaver-mcp` | or `~/.grok/plugins/dbeaver-mcp` |
| **Claude Code** | `~/.claude.json` → `mcpServers.dbeaver` | `{ "command": "NODE", "args": ["ENTRY"] }` |
| **Codex** | `~/.codex/config.toml` | `[mcp_servers.dbeaver]` `command` + `args` |
| **Agy** | `~/.gemini/config/mcp_config.json` | `{ "mcpServers": { "dbeaver": { "command": "NODE", "args": ["ENTRY"] } } }` |

## Safety

- This repo holds **no** connection passwords. See [SECURITY.md](./SECURITY.md).
- Confirm with the user before `write_query` / `run_script` on a live database.
- DBeaver **Community** only. EE / PRO uses a different credential store.

## Layout

```
src/                 MCP server
scripts/doctor.mjs
scripts/install-hosts.mjs
HOWTO.md             tools, scripts, sequences, troubleshooting
SECURITY.md
```
