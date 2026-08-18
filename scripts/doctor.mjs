#!/usr/bin/env node
import { loadConnections, publicConnection, defaultWorkspace } from '../src/dbeaver.js'

const nodeMajor = Number(process.versions.node.split('.')[0])
const checks = []

function ok(name, detail) {
  checks.push({ name, ok: true, detail })
}
function bad(name, detail) {
  checks.push({ name, ok: false, detail })
}

if (nodeMajor >= 20) ok('node', process.versions.node)
else bad('node', `${process.versions.node} (need >= 20)`)

try {
  const ws = defaultWorkspace()
  ok('dbeaver workspace', ws)
  const list = loadConnections(ws).map(publicConnection)
  ok('connections', `${list.length}: ${list.map((c) => c.name).join(', ') || '(none)'}`)
} catch (err) {
  bad('dbeaver workspace', err instanceof Error ? err.message : String(err))
}

for (const c of checks) {
  process.stdout.write(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}\n     ${c.detail}\n`)
}

if (checks.some((c) => !c.ok)) process.exit(1)
