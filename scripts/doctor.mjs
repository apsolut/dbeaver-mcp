#!/usr/bin/env node
import { existsSync } from 'node:fs'
import {
  defaultWorkspace,
  loadConnectionsDetailed,
  publicConnection,
  workspaceCandidates,
} from '../src/dbeaver.js'
import { hostKeyPolicy, knownHostsPaths } from '../src/knownhosts.js'

const checks = []

function ok(name, detail) {
  checks.push({ name, ok: true, detail })
}
function warn(name, detail) {
  checks.push({ name, ok: true, warn: true, detail })
}
function bad(name, detail) {
  checks.push({ name, ok: false, detail })
}

const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor >= 20) ok('node', process.versions.node)
else bad('node', `${process.versions.node} (need >= 20)`)

try {
  const ws = defaultWorkspace()
  ok('dbeaver workspace', ws)

  const { connections, warnings } = loadConnectionsDetailed(ws)
  const usable = connections.filter((c) => c.supported)
  const ready = usable.filter((c) => c.user && c.password)

  if (connections.length === 0) {
    warn('connections', 'workspace has no saved connections')
  } else {
    ok(
      'connections',
      `${connections.length} total, ${usable.length} postgres, ${ready.length} with saved credentials`
    )
  }

  for (const c of connections.map(publicConnection)) {
    const flags = []
    if (!c.supported) flags.push(`unsupported driver ${c.driver}`)
    if (c.supported && !c.hasPassword) flags.push('no saved password')
    if (c.ssh) flags.push(`ssh ${c.ssh.user || '?'}@${c.ssh.host}:${c.ssh.port} (${c.ssh.authType})`)
    const detail = `${c.host}:${c.port}/${c.database}${flags.length ? `  — ${flags.join('; ')}` : ''}`
    if (!c.supported || (c.supported && !c.hasPassword)) warn(`  ${c.name}`, detail)
    else ok(`  ${c.name}`, detail)
  }

  for (const w of warnings) warn(w.code, `${w.message}${w.hint ? `\n     ${w.hint}` : ''}`)
} catch (err) {
  bad('dbeaver workspace', err instanceof Error ? err.message : String(err))
  warn('searched', workspaceCandidates().join('\n     '))
}

const policy = hostKeyPolicy()
const kh = knownHostsPaths().filter((p) => existsSync(p))
if (policy === 'insecure') {
  warn('ssh host keys', 'verification DISABLED (DBEAVER_MCP_SSH_HOST_KEY_POLICY=insecure)')
} else if (kh.length === 0) {
  warn(
    'ssh host keys',
    `policy=${policy}, but no known_hosts found. SSH-tunnelled connections will fail until the host key is known` +
      (policy === 'strict' ? ' (ssh-keyscan host >> ~/.ssh/known_hosts).' : ' — first use will record it.')
  )
} else {
  ok('ssh host keys', `policy=${policy}, known_hosts: ${kh.join(', ')}`)
}

for (const c of checks) {
  const tag = c.ok ? (c.warn ? 'warn' : 'ok  ') : 'FAIL'
  process.stdout.write(`${tag} ${c.name}\n     ${c.detail}\n`)
}

if (checks.some((c) => !c.ok)) process.exit(1)
