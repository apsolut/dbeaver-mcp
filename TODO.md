# TODO — post-release

Status as of 2026-09-26, **v1.6.1, released**. Public at `github.com/apsolut/dbeaver-mcp`, on npm
as `@apsolut/dbeaver-mcp`, CI green on six jobs, 67 tests, 0 Dependabot alerts. Every security
control verified end-to-end against a live SSH-tunnelled Postgres 15 — on Windows only.

Distribution is **both**: npm for the package, clone + `npm run setup` for agent registration.
`npx` alone does not register the plugin with any host.

> Note: this file is excluded from the npm tarball (`files` in `package.json`) but **is** visible on
> GitHub. Keep it free of hostnames, credentials and customer names. This bit it once already —
> v1.6.0 shipped a real connection name in the examples and in the `execute_query` tool schema.

---

## 1. Release — done

- [x] **Commit the work.** Landed on `release/1.6.0`; tree clean.
- [x] **`README.md` placeholder.** `git clone <this-repo>` replaced with the real clone URL, plus a
      note that `npx dbeaver-mcp` fetches an unrelated project.
- [x] **Git remote.** `apsolut/dbeaver-mcp` is public; `main` and `release/1.6.0` both pushed.
- [x] **Fast-forward `main`.** Done — `main` is at `567ecee`, and is the default branch.
- [x] **Dependabot.** The push surfaced 9 advisories (4 high). Fixed in `dfe309d`, lockfile only;
      0 open alerts.

- [x] **npm.** Published as `@apsolut/dbeaver-mcp@1.6.1`, public access confirmed. The unscoped
      name belongs to someone else, hence the scope.
- [x] **Tagged** `v1.6.1`.
- [x] **1.6.0 deprecated** on npm. It shipped a real connection name, a `npm test` that could not
      run on Windows + Node 20, and 9 dependency advisories. Deprecated rather than unpublished so
      existing lockfiles still resolve. The 72-hour unpublish window closes ~22:54Z 2026-09-28.

No blockers remain. What is left in §3 is quality, not permission.

## 2. Decisions to make

### D1 — Package identity *(decided 2026-09-26: no rename)*

Resolved by D4. The rename existed only to escape the npm 403; with clone-only distribution there
is nothing to escape. GitHub namespaces by owner, so `apsolut/dbeaver-mcp` does not collide with
`lucascborges/dbeaver-mcp` — and `package.json:36-43` already points `repository`, `bugs` and
`homepage` at the right place.

Names left deliberately unchanged: `package.json:2`, `plugin.json:2`,
`.claude-plugin/plugin.json:2`, `.codex-plugin/plugin.json:2`, `.grok-plugin/marketplace.json:2`
and `:7`. `private` stays `false`.

**The one accepted risk:** Grok/Codex/Agy plugin namespaces are flat, so a user who installs a
second DBeaver MCP plugin gets a name collision. Judged narrow enough to accept rather than pay
for the installer migration. If that ever changes, the migration is not optional:
`scripts/install-hosts.mjs:211` dedupes on the plugin name, so renaming without adding the old
name to that list appends a **second** marketplace entry, and the old-named links in
`~/.codex/plugins/`, `~/.grok/plugins/` and `~/.gemini/config/plugins/` must be removed by hand —
`linkDir` only manages the path it is given.

### Who holds the npm name

`lucascborges/dbeaver-mcp` — MySQL only, no SSH tunnels, 1 star, 16 commits. Read-only by
statement blocking rather than engine enforcement. Convergent on the read/write split and
per-connection permissions; no overlap on the tunnel path. Not a competitor worth tracking, but it
is why `npx dbeaver-mcp` is a trap and why the README now says so.

### D2 — The `mcpServers` key

Currently `dbeaver`, which sets the tool prefix (`dbeaver__execute_query`). If a user installs a
second DBeaver MCP the keys collide and one silently wins — the agent then queries the wrong
server with no indication.

- [ ] **Keep `dbeaver`** — short tool names, no doc churn. *(current default)*
- [ ] **Or rename to `apsolut-dbeaver`** — collision-proof, but every tool name grows and
      `AGENTS.md`, `HOWTO.md`, `README.md` and `skills/dbeaver/SKILL.md` all need updating.

### D3 — Is `PLAN.md` public? *(decided 2026-09-26: yes)*

- [x] **Published.** No vulnerable version was ever released, so disclosing the twelve findings
      exposes nobody. It stands as the record of the hardening work.

### D4 — Distribution model *(decided 2026-09-26)*

- [x] **GitHub**, install via `git clone` + `npm run setup`.
- [x] **npm as `@apsolut/dbeaver-mcp`** — shipped 1.6.1. Two edits, not a rename pass:
      `package.json:2` plus `"publishConfig": { "access": "public" }`, because scoped packages
      default to restricted and the first publish would otherwise have created a private package.
      **`bin` stayed `dbeaver-mcp` and all four plugin manifests are untouched** — npm and the host
      plugin namespaces are unrelated, so none of the `install-hosts.mjs:211` migration applied.

Published ahead of the §3 macOS/Linux gate, knowingly. The consequence to watch: `npx` reaches
platforms where no real query has ever run, and the README platform table is the only thing
setting expectations. Treat the first macOS or Linux issue as expected, not surprising.

`npx dbeaver-mcp` — unscoped — is `lucascborges/dbeaver-mcp`, a different server. The scope is
load-bearing and `README.md` says so.

### D5 — Scope of the project

Currently Postgres-wire only, deliberately. omnisql-mcp covers PostgreSQL/MySQL/SQLite/MSSQL in
~6.7k LOC and is the established competitor at 79 stars.

- [ ] Stay narrow and lead on safe defaults — *recommended; it's the honest differentiator*
- [ ] Broaden to other engines and compete on breadth

## 3. Quality gates — do before the first tag, not after

- [x] **Run CI.** Green on all six jobs (ubuntu + macOS + windows × Node 20/22) as of 2026-09-26.
      Its first run earned its keep: `npm test` passed the glob `test/*.test.js`, which PowerShell
      does not expand, so the suite had never been runnable on Windows + Node 20. Fixed in
      `567ecee` with bare `node --test`.
- [ ] **macOS / Linux end-to-end.** The unit suite now genuinely passes on both — that is new — but
      nobody has run a **real query against a real database** on either, and the tests need no
      database. This gate is *not* closed by green CI. It is the last one standing before npm.
      `README.md` states this plainly and invites PRs.
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
- [ ] `~/.grok/mcp/dbeaver-ssh/` still holds a one-off dump script that never made it into this
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
