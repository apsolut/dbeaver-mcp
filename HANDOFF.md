# HANDOFF — dbeaver-mcp, updated 2026-09-26

State: **v1.6.0 on `main` at `567ecee`**, public at `github.com/apsolut/dbeaver-mcp`, CI green on
all six jobs, 67 tests passing, 0 Dependabot alerts. Not on npm — that is deliberate, see TODO §D4.

For *what to do next*, read **[TODO.md](./TODO.md)** — it holds the blockers and the open
decisions. This file is context: what was done, what was actually verified, and what to be
careful about.

---

## Where things stand

```
7cb8e9e  chore(release): 1.6.0 packaging, CI matrix and repo scaffolding
831bf06  docs: document the new security model, tools and access policy
9623b5f  feat(security): verify SSH host keys, enforce read-only, add access policy
98ad6cb  feat: first-run BACKUP FIRST YOUR DATABASE banner   <-- main is still here
```

`main` has **not** moved. To fast-forward it once you are happy:

```bash
git checkout main && git merge --ff-only release/1.6.0
```

Two releases landed in `9623b5f` together. That was deliberate: both passes edited the same
functions in `query.js`, `dbeaver.js`, `tunnel.js` and `index.js`, so splitting them would have
meant inventing a history that never existed. The commit body explains both.

## What was verified, and what was not

Be precise about this — the README makes a public claim about it.

**Verified end-to-end on Windows 11 / Node 22 against live Postgres 15, through a real SSH tunnel:**

- Host key verification against the real bastion, strict mode, rejecting an unknown host
- `SHOW transaction_read_only` returning `on` inside `execute_query` — the read-only guarantee is
  the engine's, not a regex's
- `explain_query`, `fix_sequences` (dry run found two genuinely broken sequences on the dev DB)
- `trust_ssh_host` full flow: probe → fingerprint → confirmation → refusal on a wrong fingerprint
- Connection allow list, the read/write split, and the destructive-SQL guard firing before any
  connection is opened
- The installer in a sandboxed `HOME`: config backup, malformed-config refusal, and refusal to
  delete a real directory where a link was expected

**Not verified, at all:**

- **macOS and Linux, against a real database.** The unit suite now passes on both in CI, but the
  tests need no database, so this says nothing about a real query. The installer's
  `mklink`-vs-`symlink` branch has still only ever run on Windows.
- ~~CI~~ — as of 2026-09-26 it has run and is **green on all six jobs**. Its first execution found
  that `npm test` used a glob PowerShell will not expand, so the suite had never worked on
  Windows + Node 20 despite `package.json` claiming Node 20 support.
- Connection pooling and stateful transactions — deliberately not built, see TODO.md §4.

## Things that will bite you

1. ~~The npm name is taken~~ — moot as of 2026-09-26. Distribution is clone-only (D4), so
   `npm publish` is never called. The holder is `lucascborges/dbeaver-mcp`: MySQL only, no SSH
   tunnels, 1 star. `npx dbeaver-mcp` gets *their* server, which the README now warns about.
2. ~~`README.md` placeholder~~ — fixed; real clone URL in place.
3. **Renaming the plugin still needs a migration step**, if it ever happens.
   `scripts/install-hosts.mjs:211` dedupes on the old name; change the name without adding the old
   one to that list and a re-run appends a *second* marketplace entry. The old-named links in
   `~/.codex/plugins/`, `~/.grok/plugins/` and `~/.gemini/config/plugins/` also need removing, or
   every host shows the plugin twice. `linkDir` will not do this — it only manages the path it is
   handed. Names were left unchanged deliberately; the accepted risk is a flat-namespace collision
   if a user installs a second DBeaver MCP plugin.
4. **Three breaking changes** from 1.4 will look like bugs to an existing user: tunnels to unknown
   hosts now fail, `verify-ca`/`verify-full` connections may now legitimately fail, and writes need
   an exact connection name. All three are in the CHANGELOG and in README's "Upgrading from 1.4".

## The local vault

`.apsolut/` is a davinci-profile working notebook. It is **gitignored, never committed, and never
has been** — confirmed against full history. A `pre-commit` hook in `.git/hooks/` blocks it from
being staged even via `git add -f`.

It is local-only and therefore **not backed up by git**. Two things in it matter:

- `04-library/001-competitive-analysis.md` — the full analysis of `omnisql-mcp` and
  `FelipeFlohr/dbeaver-mcp` with file-and-line evidence. This is the reasoning behind the
  positioning and behind several TODO decisions. It exists nowhere else.
- `07-files/` — pinned checkouts of both competitors. Delete once the analysis is settled;
  the manifest already flags them.

The hook does not travel with a clone (`.git/hooks/` is not cloned). If someone else picks this
up, that protection does not come with it.

## One loose end outside the repo

`~/.grok/mcp/dbeaver-ssh/` is the pre-rewrite plugin directory. Its registrations have been
removed, but it still contains a one-off dump script that never made it into this repo. Rescue it
or accept losing it before deleting that folder.

## Quick orientation

```bash
npm test          # 67 tests, no database needed, should pass anywhere
npm run doctor    # what this machine looks like: workspace, connections, SSH policy
npm run cli -- list
```

| File | What it is |
|------|-----------|
| `src/knownhosts.js` | OpenSSH known_hosts parsing and the host-key decision |
| `src/policy.js` | Access policy and destructive-SQL detection |
| `src/query.js` | Connection setup, TLS, read-only transactions, result shaping |
| `src/dbeaver.js` | Workspace discovery, connection parsing, name resolution |
| `PLAN.md` | The twelve-item security audit and its implementation log |
| `TODO.md` | Blockers and open decisions |
