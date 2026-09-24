#!/usr/bin/env node
/**
 * Point Grok, Claude Code, Codex, and Agy at this checkout.
 * Safe to re-run on any PC. Does not print DBeaver passwords.
 *
 *   node scripts/install-hosts.mjs
 *   node scripts/install-hosts.mjs --hosts=claude,codex
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync, execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, platform } from 'node:os'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const entry = join(root, 'src', 'index.js')
const home = homedir()
const node = process.execPath
const win = platform() === 'win32'

const requested = new Set(
  String(process.argv.find((a) => a.startsWith('--hosts=')) || '')
    .slice('--hosts='.length)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
)
const want = (name) => requested.size === 0 || requested.has(name)

const stdioServer = {
  type: 'stdio',
  command: node,
  args: [entry],
  env: {},
}

function log(msg) {
  process.stdout.write(`${msg}\n`)
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true })
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback
  const raw = readFileSync(path, 'utf8').trim()
  if (!raw) return fallback
  try {
    return JSON.parse(raw)
  } catch (err) {
    // Never rewrite a config we could not understand — that would wipe every
    // other MCP server the user has configured.
    throw new Error(
      `${path} is not valid JSON (${err.message}). Fix or move that file, then re-run. Nothing was changed.`
    )
  }
}

/** Keep one backup, then swap the new file in atomically. */
function backupOnce(path) {
  if (!existsSync(path)) return null
  const bak = `${path}.dbeaver-mcp.bak`
  try {
    copyFileSync(path, bak)
    return bak
  } catch {
    return null
  }
}

function writeAtomic(path, text) {
  ensureDir(dirname(path))
  const bak = backupOnce(path)
  const tmp = `${path}.dbeaver-mcp.${process.pid}.tmp`
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, path)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    throw err
  }
  return bak
}

function writeJson(path, data) {
  return writeAtomic(path, `${JSON.stringify(data, null, 2)}\n`)
}

/**
 * Replace `dest` with a link to `src`.
 * Only ever removes a link. A real directory there belongs to the user — a
 * recursive delete of an unknown directory in $HOME is not an acceptable
 * install step.
 */
function linkDir(dest, src) {
  ensureDir(dirname(dest))
  let stat = null
  try {
    stat = lstatSync(dest)
  } catch {
    stat = null
  }

  if (stat) {
    // Node reports Windows junctions as symbolic links.
    if (!stat.isSymbolicLink()) {
      throw new Error(
        `${dest} already exists and is a real ${stat.isDirectory() ? 'directory' : 'file'}, not a link. ` +
          'Refusing to delete it — move it aside and re-run.'
      )
    }
    let target = ''
    try {
      target = readlinkSync(dest)
    } catch {
      /* ignore */
    }
    if (target && target.replace(/[\\/]+$/, '') === src.replace(/[\\/]+$/, '')) return 'already linked'
    rmSync(dest, { recursive: true, force: true })
  }

  if (win) {
    try {
      execSync(`cmd /c mklink /J "${dest}" "${src}"`, { stdio: 'pipe' })
      return 'junction'
    } catch {
      execSync(`cmd /c mklink /D "${dest}" "${src}"`, { stdio: 'pipe' })
      return 'symlink'
    }
  }
  symlinkSync(src, dest, 'dir')
  return 'symlink'
}

function which(cmd) {
  try {
    execFileSync(win ? 'where' : 'which', [cmd], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function upsertClaudeJson() {
  const path = join(home, '.claude.json')
  const data = readJson(path, {})
  data.mcpServers = data.mcpServers || {}
  data.mcpServers.dbeaver = stdioServer
  const bak = writeJson(path, data)
  log(`Claude Code  ${path}${bak ? `  (backup: ${bak})` : ''}`)
}

function upsertCodexToml() {
  const path = join(home, '.codex', 'config.toml')
  ensureDir(dirname(path))
  let text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const block = `[mcp_servers.dbeaver]
command = ${JSON.stringify(node)}
args = [${JSON.stringify(entry)}]
startup_timeout_sec = 20
tool_timeout_sec = 90
`
  if (/^\[mcp_servers\.dbeaver\]/m.test(text)) {
    text = text.replace(/\[mcp_servers\.dbeaver\][\s\S]*?(?=\n\[|\s*$)/, `${block}\n`)
  } else {
    text = `${text.trimEnd()}\n\n${block}`
  }
  const bak = writeAtomic(path, text.endsWith('\n') ? text : `${text}\n`)
  log(`Codex        ${path}${bak ? `  (backup: ${bak})` : ''}`)
}

function upsertAgyMcp(path) {
  const data = readJson(path, { mcpServers: {} })
  if (!data.mcpServers || typeof data.mcpServers !== 'object') data.mcpServers = {}
  data.mcpServers.dbeaver = { command: node, args: [entry], env: {} }
  const bak = writeJson(path, data)
  log(`Agy          ${path}${bak ? `  (backup: ${bak})` : ''}`)
}

function upsertAgentsMarketplace() {
  const path = join(home, '.agents', 'plugins', 'marketplace.json')
  const data = readJson(path, {
    name: 'local-user-plugins',
    interface: { displayName: 'Local user plugins' },
    plugins: [],
  })
  data.plugins = Array.isArray(data.plugins) ? data.plugins : []
  const item = {
    name: 'dbeaver-mcp',
    source: { source: 'local', path: root.replace(/\\/g, '/') },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Developer Tools',
  }
  const i = data.plugins.findIndex((p) => p.name === 'dbeaver-mcp' || p.name === 'dbeaver-ssh')
  if (i >= 0) data.plugins[i] = { ...data.plugins[i], ...item }
  else data.plugins.push(item)
  writeJson(path, data)
  log(`Marketplace  ${path}`)
}

function tryGrokPlugin() {
  if (!which('grok')) {
    log('Grok         grok CLI not on PATH — install later with: grok plugin install . --trust')
    return
  }
  try {
    execFileSync('grok', ['plugin', 'install', root, '--trust'], { stdio: 'pipe' })
    try {
      execFileSync('grok', ['plugin', 'enable', 'dbeaver-mcp'], { stdio: 'pipe' })
    } catch {
      execFileSync('grok', ['plugin', 'enable', 'dbeaver-ssh'], { stdio: 'pipe' })
    }
    log('Grok         plugin installed + enabled')
  } catch (err) {
    log(`Grok         plugin install skipped (${err instanceof Error ? err.message : err})`)
  }
}

if (!existsSync(entry)) throw new Error(`Missing server entry: ${entry}`)

let failures = 0

/** One broken host config must not stop the others from being written. */
function step(label, fn) {
  try {
    fn()
  } catch (err) {
    failures++
    log(`${label} skipped: ${err instanceof Error ? err.message : err}`)
  }
}

log(`plugin root  ${root}`)
if (want('claude')) step('Claude Code ', upsertClaudeJson)
if (want('codex')) step('Codex       ', upsertCodexToml)
if (want('agy')) {
  for (const dir of ['config', 'antigravity', 'antigravity-ide', 'antigravity-cli']) {
    step('Agy         ', () => upsertAgyMcp(join(home, '.gemini', dir, 'mcp_config.json')))
  }
}
if (want('codex') || want('agy')) step('Marketplace ', upsertAgentsMarketplace)
if (want('grok')) step('Grok        ', tryGrokPlugin)

const links = []
if (want('agy')) links.push(join(home, '.gemini', 'config', 'plugins', 'dbeaver-mcp'))
if (want('codex')) links.push(join(home, '.codex', 'plugins', 'dbeaver-mcp'))
if (want('grok')) links.push(join(home, '.grok', 'plugins', 'dbeaver-mcp'))

for (const dest of links) {
  try {
    log(`link         ${dest}  (${linkDir(dest, root)})`)
  } catch (err) {
    failures++
    log(`link failed  ${dest}  ${err instanceof Error ? err.message : err}`)
  }
}

log('')
if (failures) log(`${failures} step(s) were skipped — see the messages above.`)
log('Next: restart each agent. Then ask: list DBeaver connections')
log('Smoke test: npm run doctor')
