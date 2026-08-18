#!/usr/bin/env node
/**
 * Point Grok, Claude Code, Codex, and Agy at this checkout.
 * Safe to re-run on any PC. Does not print DBeaver passwords.
 *
 *   node scripts/install-hosts.mjs
 *   node scripts/install-hosts.mjs --hosts=claude,codex
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
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
  return JSON.parse(raw)
}

function writeJson(path, data) {
  ensureDir(dirname(path))
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function linkDir(dest, src) {
  ensureDir(dirname(dest))
  if (existsSync(dest)) {
    try {
      rmSync(dest, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
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
  writeJson(path, data)
  log(`Claude Code  ${path}`)
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
  writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`, 'utf8')
  log(`Codex        ${path}`)
}

function upsertAgyMcp(path) {
  const data = readJson(path, { mcpServers: {} })
  if (!data.mcpServers || typeof data.mcpServers !== 'object') data.mcpServers = {}
  data.mcpServers.dbeaver = { command: node, args: [entry], env: {} }
  writeJson(path, data)
  log(`Agy          ${path}`)
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

log(`plugin root  ${root}`)
if (want('claude')) upsertClaudeJson()
if (want('codex')) upsertCodexToml()
if (want('agy')) {
  upsertAgyMcp(join(home, '.gemini', 'config', 'mcp_config.json'))
  upsertAgyMcp(join(home, '.gemini', 'antigravity', 'mcp_config.json'))
  upsertAgyMcp(join(home, '.gemini', 'antigravity-ide', 'mcp_config.json'))
  upsertAgyMcp(join(home, '.gemini', 'antigravity-cli', 'mcp_config.json'))
}
if (want('codex') || want('agy')) upsertAgentsMarketplace()
if (want('grok')) tryGrokPlugin()

const links = []
if (want('agy')) links.push(join(home, '.gemini', 'config', 'plugins', 'dbeaver-mcp'))
if (want('codex')) links.push(join(home, '.codex', 'plugins', 'dbeaver-mcp'))
if (want('grok')) links.push(join(home, '.grok', 'plugins', 'dbeaver-mcp'))

for (const dest of links) {
  try {
    log(`link         ${dest}  (${linkDir(dest, root)})`)
  } catch (err) {
    log(`link failed  ${dest}  ${err instanceof Error ? err.message : err}`)
  }
}

log('')
log('Next: restart each agent. Then ask: list DBeaver connections')
log('Smoke test: npm run doctor')
