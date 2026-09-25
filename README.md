# dbeaver-mcp

Let an AI agent query **your** Postgres through **DBeaver Community** connections already saved on this PC.

It reads DBeaver’s workspace, decrypts credentials locally, opens an SSH tunnel when the connection uses one, and runs SQL. Passwords never appear in tool results and never leave this process.

Works with **Grok**, **Claude Code**, **Codex**, and **Agy** (Antigravity). Node 20+ required.

Need tools, transactions, sequences, or live-DB rules? See **[HOWTO.md](./HOWTO.md)**.

---

## Before you start — two things to know

**1. SSH tunnels will refuse to connect until the host key is known.** This is deliberate, and it
is the most likely reason your first tunnelled query fails. See
[SSH tunnels need a known host key](#3-ssh-tunnels-need-a-known-host-key) below — it is a
one-line fix.

**2. Only tested on Windows.** Developed and verified on Windows 11 with Node 22 against DBeaver
Community 25 and Postgres 15, including SSH-tunnelled connections. macOS and Linux paths are
implemented and unit-tested, but **nobody has run this end-to-end on either**. Expect rough edges
in workspace detection and in `scripts/install-hosts.mjs`, which writes agent config files and
creates symlinks.

If you hit something on macOS or Linux, **please open an issue or send a PR** — that is the
fastest way this gets properly cross-platform. `npm test` needs no database and should pass
everywhere; `npm run doctor` tells you what your machine looks like and is the most useful thing
to paste into an issue.

| Platform | Status |
|----------|--------|
| Windows | Verified end-to-end (direct + SSH tunnel) |
| macOS | Implemented, untested — PRs welcome |
| Linux (incl. Snap, Flatpak) | Implemented, untested — PRs welcome |

---

## 1. Install on this PC

```bash
git clone https://github.com/apsolut/dbeaver-mcp.git
cd dbeaver-mcp
npm run setup
```

`setup` installs dependencies and points every agent it can find at **this checkout**.

On npm the package is **`@apsolut/dbeaver-mcp`** — the scope matters. The unscoped `dbeaver-mcp`
is an unrelated project, so `npx dbeaver-mcp` gets you someone else's server.

Cloning is still the recommended route, because `npm run setup` is what registers the plugin with
every agent on the machine. Note that Windows is the only platform where a real query has been
verified end-to-end; see the table above.

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

## 3. SSH tunnels need a known host key

If any DBeaver connection uses an SSH tunnel, read this before your first query.

This plugin verifies the bastion's host key against `~/.ssh/known_hosts` **before** sending your
SSH password or your database credentials. An unknown host, a changed key, or an `@revoked` entry
aborts the connection. DBeaver does the same thing; a tool that skipped the check would hand your
production credentials to anything that answers on that IP.

So the first tunnelled query against a host you have never reached **from this machine, as this
user** fails with:

```
Unknown SSH host key for bastion.example.com:22 (SHA256:…)
```

Fix it once, either way:

```bash
# Preferred: record the key, then eyeball the fingerprint against what you expect
ssh-keyscan -p 22 bastion.example.com >> ~/.ssh/known_hosts

# Or just connect once with ssh and accept the prompt
ssh you@bastion.example.com
```

Already have the host in `known_hosts` (hashed entries, wildcards, `[host]:2222` forms and
`@revoked` markers are all understood)? Then nothing happens and the tunnel opens.

**Or let the agent walk you through it.** Ask it to run `trust_ssh_host` on the connection. It
probes the bastion **without sending any credentials** — the handshake is aborted at the host-key
stage — shows you the SHA256 fingerprint, and records it only after you confirm that exact value
back. A key that differs from one already recorded is refused outright, never offered for
confirmation.

**Trust on first use**, if you would rather not pre-seed keys:

```bash
export DBEAVER_MCP_SSH_HOST_KEY_POLICY=tofu
```

This records an unknown key the first time and warns you. A key that *changes later* is still
refused — that case is indistinguishable from an attack.

There is also `=insecure`, which disables verification entirely and prints a warning on every
connection. It exists for throwaway local boxes. Do not point it at anything that matters.

> **`known_hosts` is per-user.** The MCP server runs as you, so the file your terminal uses is the
> file it reads. If your agent runs under a different account or inside a container, point
> `DBEAVER_MCP_KNOWN_HOSTS` at the right file.

**Agent-based SSH auth is the one gap.** If DBeaver is set to use an SSH agent, the MCP server
needs `SSH_AUTH_SOCK` in *its* environment, and desktop agent hosts usually do not pass it
through. Password and key auth work normally.

## 4. First ask

After restart:

> list DBeaver connections

You should see tools named `dbeaver__list_connections`, `dbeaver__execute_query`, `dbeaver__run_script`, `dbeaver__inspect_sequences`.

The first start (and the first write of a session) prints a **BACKUP FIRST YOUR DATABASE** banner. Dump before `write_query` / `run_script`. The marker lives in `~/.dbeaver-mcp/backup-seen` (override with `DBEAVER_MCP_STATE`).

Then:

> test the connection named ACME LIVE  
> select id, name from regions limit 5 on ACME LIVE

The `name` argument is the DBeaver connection name or its id. **Reads** also accept a unique
substring (`live` → `ACME LIVE`); an ambiguous substring is an error, never a guess. **Writes**
(`write_query`, `run_script`) require the exact name or id, so a partial match can never land on
the wrong database.

## 5. Tools

| Tool | Use it for |
|------|------------|
| `list_connections` | Names, hosts, SSH hop. No secrets. |
| `test_connection` | Open tunnel + `SELECT 1` |
| `execute_query` | Reads. Several `SELECT`s return **every** result set |
| `write_query` | One mutating statement, or a few (writes are transactional) |
| `run_script` | Ordered list / script. Transaction when anything writes |
| `inspect_sequences` | Sequence `last_value` vs `MAX(column)` — `needs_reset` |
| `fix_sequences` | Reset the sequences that are behind. Dry run unless `apply: true` |
| `explain_query` | Query plan as JSON. `analyze` is refused on writes |
| `trust_ssh_host` | Show a bastion's host key fingerprint and record it once you confirm |
| `list_schemas` | Non-system schemas |
| `list_tables` | Tables in a schema |
| `describe_table` | Columns |

`execute_query` refuses writes, including `SELECT setval(...)`. Use `write_query` or `run_script` for those.

**Destructive SQL needs `confirm: true`** — `DROP`, `TRUNCATE`, `ALTER SYSTEM`, and `DELETE` /
`UPDATE` with no `WHERE`. The check runs per statement on the parsed batch, with string literals
stripped, so neither a `;`-separated batch nor a `WHERE` inside a value slips past. It's a
confirmation rather than a refusal on purpose: a flat block just teaches an agent to rephrase
until it gets through.

## Restricting what the agent can reach

Policy lives in the environment, not in the conversation, so it holds regardless of what the
agent decides to try. Set these in your MCP host config:

```jsonc
"env": {
  "DBEAVER_MCP_ALLOWED_CONNECTIONS": "app-*,billing",  // nothing else is even nameable
  "DBEAVER_MCP_WRITABLE_CONNECTIONS": "app-dev",       // read prod, write only dev
  "DBEAVER_MCP_DISABLED_TOOLS": "run_script"           // gone from the tool list
}
```

Or lock the whole server down with `DBEAVER_MCP_READ_ONLY=true`, which unregisters
`write_query`, `run_script` and `fix_sequences` entirely — the agent never sees them.

Names match connection name **or** id, case-insensitively, with `*` and `?` wildcards. A
connection outside the allow list cannot be resolved by name at all, so the error doesn't even
confirm it exists.

## 6. CLI (no agent)

```bash
npm run cli -- list
npm run cli -- test "ACME LIVE"
npm run cli -- query "ACME LIVE" "SELECT 1; SELECT current_database()"
npm run cli -- sequences "ACME LIVE"
npm run cli -- sequences "ACME LIVE" public pages
```

## 7. One agent only

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

## Upgrading from 1.4

1.5 tightened three things that were previously permissive. If something that used to work now
fails, it is almost certainly one of these — and in each case the older behaviour was unsafe.

| Change | You will see | What to do |
|--------|--------------|------------|
| SSH host keys are verified | `Unknown SSH host key for …` on a tunnel that worked before | [Section 3](#3-ssh-tunnels-need-a-known-host-key). One `ssh-keyscan`, or `DBEAVER_MCP_SSH_HOST_KEY_POLICY=tofu`. |
| `sslmode` is honoured properly | TLS errors on `verify-ca` / `verify-full` connections | Previously every mode skipped certificate checks. Point `DBEAVER_MCP_SSL_ROOT_CERT` at your CA, or set the connection to `require` in DBeaver if you genuinely do not want verification. |
| Writes need an exact connection name | `Writes require an exact name or id` | Use the full name or id from `list_connections`. Partial matching could previously select the wrong database. |

Also new: queries time out after 30s by default (`timeoutMs`, or
`DBEAVER_MCP_STATEMENT_TIMEOUT_MS`), and large results are capped by total bytes — watch for
`truncatedBytes: true`.

## Safety

- This repo holds **no** connection passwords. See [SECURITY.md](./SECURITY.md).
- **Reads are enforced by Postgres**, not by pattern matching: `execute_query` runs inside
  `BEGIN TRANSACTION READ ONLY`, so even a `SELECT` that calls a data-modifying function fails.
- **SSH host keys are verified** against `~/.ssh/known_hosts`. An unknown or changed host key
  aborts the tunnel.
- **TLS follows your `sslmode`.** `verify-ca` / `verify-full` really verify.
- Writes need an exact connection name, and a live query cannot run forever (30s default).
- Confirm with the user before `write_query` / `run_script` on a live database.
- DBeaver **Community** only. EE / PRO uses a different credential store.

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `DBEAVER_WORKSPACE` | auto-detected | Folder containing `General/.dbeaver/data-sources.json` |
| `DBEAVER_MCP_SSH_HOST_KEY_POLICY` | `strict` | `strict`, `tofu` (trust on first use), `insecure` (no verification) |
| `DBEAVER_MCP_KNOWN_HOSTS` | `~/.ssh/known_hosts` | Path list for host key lookup |
| `DBEAVER_MCP_SSL_ROOT_CERT` | `~/.postgresql/root.crt` | CA bundle for `verify-ca` / `verify-full` |
| `DBEAVER_MCP_STATEMENT_TIMEOUT_MS` | `30000` | Server-side statement timeout |
| `DBEAVER_MCP_LOCK_TIMEOUT_MS` | `10000` | Server-side lock timeout |
| `DBEAVER_MCP_IDLE_TX_TIMEOUT_MS` | `30000` | Kills sessions left idle in a transaction |
| `DBEAVER_MCP_MAX_BYTES` | `262144` | Total result payload cap per call |
| `DBEAVER_MCP_MAX_CELL_BYTES` | `2048` | Per-cell cap; `bytea` is summarised, never dumped |
| `DBEAVER_MCP_STATE` | `~/.dbeaver-mcp` | Where the backup-banner marker lives |
| `DBEAVER_MCP_READ_ONLY` | `false` | `true` unregisters every write tool |
| `DBEAVER_MCP_ALLOWED_CONNECTIONS` | all | Comma-separated names/ids, `*`/`?` wildcards |
| `DBEAVER_MCP_WRITABLE_CONNECTIONS` | = allowed | Narrower list that may be written to |
| `DBEAVER_MCP_DISABLED_TOOLS` | none | Tool names to remove from the surface |

## Contributing

macOS and Linux need a second pair of hands — see the platform table at the top. Useful
contributions, roughly in order of value:

1. **Run it on macOS or Linux and report what broke.** `npm run doctor` output plus your DBeaver
   version is enough to start. Snap and Flatpak workspace layouts especially.
2. **`scripts/install-hosts.mjs` on a non-Windows box.** It writes agent config files and creates
   symlinks. It backs up before writing and refuses to delete anything that is not a link, but it
   has only ever run for real on Windows.
3. **CI.** A GitHub Actions matrix over windows/macos/ubuntu × Node 20/22 would close most of this
   gap by itself.
4. **`src/dbeaver.js` parser tests.** JDBC URL shapes, SSH handler variants and credential blobs
   differ across DBeaver versions; that is where real-world variation will bite and where coverage
   is thinnest.

```bash
npm install
npm test          # no database required, should pass on any platform
npm run doctor    # what your machine looks like
```

Please do not include a real workspace, `credentials-config.json`, connection URLs or SQL dumps in
an issue or PR. Redact hostnames. Security issues: see [SECURITY.md](./SECURITY.md).

## Layout

```
src/                 MCP server
src/knownhosts.js    OpenSSH known_hosts verification
scripts/doctor.mjs
scripts/install-hosts.mjs
HOWTO.md             tools, scripts, sequences, troubleshooting
SECURITY.md
```
