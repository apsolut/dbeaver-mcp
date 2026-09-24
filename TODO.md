# TODO — before this goes public

Status as of 2026-09-24, v1.6.0. The **code** is in good shape: 67 tests, every security control
verified end-to-end against a live SSH-tunnelled Postgres 15. Everything below is release
logistics and open decisions, not engineering debt.

> Note: this file is excluded from the npm tarball (`files` in `package.json`) but **will** be
> visible on GitHub. Keep it free of hostnames, credentials and customer names.

---

## 1. Blockers — publishing is impossible until these are done

- [ ] **Commit the work.** `v1.5.0` *and* `v1.6.0` exist only in the working tree. `HEAD` is still
      `98ad6cb`, the 1.4-era banner commit. This is the single highest-risk item on the page: one
      bad `git clean` and the entire hardening pass and feature pass are gone.
- [ ] **The npm name `dbeaver-mcp` is taken** (v3.0.0, "MCP server exposing DBeaver connections to
      Claude"). `npm publish` returns 403 as things stand. See decision D1.
- [ ] **No git remote.** `git remote -v` is empty. Create the GitHub repo and add it.
- [ ] **`README.md` still says `git clone <this-repo>`** — a literal placeholder, sitting directly
      above a section inviting people to send PRs.
- [ ] **Not logged in to npm** (`npm whoami` → 401), and the `@apsolut` scope must exist under the
      account or org before a scoped publish will work.
- [ ] **Scoped packages publish as restricted by default.** Needs
      `"publishConfig": { "access": "public" }` or the first publish silently creates a private
      package.

## 2. Decisions to make

### D1 — Package identity *(recommendation: scope it)*

`dbeaver-mcp` is taken; there are at least five DBeaver MCP packages on npm. Everyone who solved
this used an npm scope (`@iflow-mcp/…`, `@leonyuu/…`, `@mhdd_24/…`), not a flat prefix.

| Surface | Proposed | Note |
|---|---|---|
| npm package | `@apsolut/dbeaver-mcp` | scope is free; scopes are the actual namespace mechanism |
| `bin` | `dbeaver-mcp` | unchanged; only collides if two are installed globally |
| Plugin manifests | `apsolut-dbeaver-mcp` | Grok/Codex/Agy namespaces are flat, so a prefix is the only option |
| GitHub repo | `apsolut/dbeaver-mcp` | GitHub already namespaces by owner — no prefix needed |
| Folder on disk | unchanged | nothing depends on it once `npm run setup` re-runs |

`mcp-dbeaver` was considered and rejected: it's free but solves nothing long-term, and it abandons
the `<tool>-mcp` convention that makes the package findable under "dbeaver".

- [ ] Decide, then apply to: `package.json:2`, `plugin.json:2`, `.claude-plugin/plugin.json:2`,
      `.codex-plugin/plugin.json:2`, `.grok-plugin/marketplace.json:2` and `:7`.
- [ ] **Installer migration** — `scripts/install-hosts.mjs:211` dedupes on the old name. If the
      plugin name changes, add the old name to that list or a re-run appends a **second**
      marketplace entry instead of replacing the first. Also remove the old-named links at
      `~/.codex/plugins/`, `~/.grok/plugins/`, `~/.gemini/config/plugins/` or every host shows the
      plugin twice. `linkDir` will not do this for you — it only manages the path it is given.

### D2 — The `mcpServers` key

Currently `dbeaver`, which sets the tool prefix (`dbeaver__execute_query`). If a user installs a
second DBeaver MCP the keys collide and one silently wins — the agent then queries the wrong
server with no indication.

- [ ] **Keep `dbeaver`** — short tool names, no doc churn. *(current default)*
- [ ] **Or rename to `apsolut-dbeaver`** — collision-proof, but every tool name grows and
      `AGENTS.md`, `HOWTO.md`, `README.md` and `skills/dbeaver/SKILL.md` all need updating.

### D3 — Is `PLAN.md` public?

It's excluded from the npm tarball but would be visible on GitHub. It is a detailed account of
twelve security weaknesses this project used to have.

- [ ] Publish it — honest, and a genuinely good record of the hardening work. No practical
      exposure, since no vulnerable version was ever released.
- [ ] Or move it into `.apsolut/03-plan/` and keep it local.

### D4 — Distribution model

- [ ] npm publish (needs D1), so `npx @apsolut/dbeaver-mcp` works
- [ ] GitHub-only, install via `git clone` + `npm run setup` *(status quo)*
- [ ] Both

### D5 — Scope of the project

Currently Postgres-wire only, deliberately. omnisql-mcp covers PostgreSQL/MySQL/SQLite/MSSQL in
~6.7k LOC and is the established competitor at 79 stars.

- [ ] Stay narrow and lead on safe defaults — *recommended; it's the honest differentiator*
- [ ] Broaden to other engines and compete on breadth

## 3. Quality gates — do before the first tag, not after

- [ ] **Run CI.** `.github/workflows/ci.yml` exists (ubuntu + macOS + windows × Node 20/22) but has
      **never executed** — there is no remote to run it on. Must be green before tagging.
- [ ] **macOS / Linux end-to-end.** Implemented and unit-tested; nobody has run a real query on
      either. `README.md` states this plainly and invites PRs.
- [ ] **`scripts/install-hosts.mjs` on a non-Windows box.** It writes agent configs and creates
      symlinks. It backs up and refuses to delete non-links, but the `mklink`-vs-`symlink` branch
      has only ever run on Windows.
- [ ] **`src/dbeaver.js` parser coverage.** Thinnest area by far. JDBC URL shapes, SSH handler
      variants and credential blobs differ across DBeaver versions, and that is where real-world
      variation will bite.
- [ ] **Security advisories.** `SECURITY.md` tells people to open a private advisory — that needs
      the GitHub repo to exist with advisories enabled, or the instruction is a dead end.

## 4. Deferred features — post-1.6, with reasons

- [ ] **Connection pooling.** Conflicts with the per-call read-only transaction and the tunnel
      lifecycle. Real design work, not a line item.
- [ ] **Stateful transactions** (`begin` / `commit` / `rollback` as separate tools). Needs session
      affinity across tool calls.
- [ ] `export_data` (CSV/JSON), `compare_schemas` with migration script — both exist in
      omnisql-mcp and are straightforward once the above two land.

## 5. Housekeeping

- [ ] **Delete the competitor checkouts** in `.apsolut/07-files/` — `felipeflohr-dbeaver-mcp/` and
      `srthkdev-omnisql-mcp/`. The comparison is done; the manifest already flags them for removal
      so they don't rot into stale forks.
- [ ] **Decide whether the pre-commit hook should travel.** `.git/hooks/pre-commit` blocks
      `.apsolut/` from ever being staged, but `.git/hooks/` is not cloned. Making it shared means a
      tracked file plus `core.hooksPath`.
- [ ] `~/.grok/mcp/dbeaver-ssh/` still holds `dump-psn-live.mjs`, which never made it into this
      repo. Rescue it or accept losing it before deleting that folder.

---

## Done

- [x] Twelve-item security and stability pass (v1.5.0) — see `PLAN.md`
- [x] Competitive analysis against `FelipeFlohr/dbeaver-mcp` and `srthkdev/omnisql-mcp`
- [x] Connection policy: read-only mode, allow list, separate write list, tool disabling
- [x] Destructive-SQL confirmation, checked per statement with literals stripped
- [x] `trust_ssh_host`, `explain_query`, `fix_sequences`
- [x] SSL read from DBeaver's `handlers.postgre_ssl` block — connections configured through the
      SSL tab were previously connecting in cleartext
- [x] `files` array, CHANGELOG, CI workflow, issue templates
- [x] `.apsolut/` ignored, never tracked, never in history, blocked by pre-commit hook
