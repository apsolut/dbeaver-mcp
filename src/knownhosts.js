import { createHash, createHmac } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

/**
 * OpenSSH known_hosts handling.
 *
 * ssh2 accepts any host key unless a `hostVerifier` is supplied, so without this
 * module every SSH tunnel is trust-on-every-use: anything on the path can
 * impersonate the bastion and collect the SSH password and the database
 * credentials that flow through it. DBeaver checks known_hosts; so do we.
 */

export const POLICY_STRICT = 'strict'
export const POLICY_TOFU = 'tofu'
export const POLICY_INSECURE = 'insecure'

export function hostKeyPolicy() {
  const raw = String(process.env.DBEAVER_MCP_SSH_HOST_KEY_POLICY || '').trim().toLowerCase()
  if (raw === POLICY_TOFU || raw === 'accept-new') return POLICY_TOFU
  if (raw === POLICY_INSECURE || raw === 'no' || raw === 'off') return POLICY_INSECURE
  return POLICY_STRICT
}

export function knownHostsPaths() {
  const override = process.env.DBEAVER_MCP_KNOWN_HOSTS
  if (override) return override.split(delimiter).filter(Boolean)
  const ssh = join(homedir(), '.ssh')
  return [join(ssh, 'known_hosts'), join(ssh, 'known_hosts2')]
}

/** Host name forms OpenSSH would look up, most specific first. */
export function hostNameForms(host, port) {
  const h = String(host || '').toLowerCase()
  const p = Number(port || 22)
  if (!h) return []
  if (p === 22) return [h]
  // OpenSSH writes `[host]:port` for non-default ports. Accept the bare form too:
  // it is the same host, and users hand-edit these files.
  return [`[${h}]:${p}`, h]
}

export function matchHostPattern(pattern, host) {
  if (!pattern) return false
  if (pattern.startsWith('|1|')) {
    const [, , salt, hash] = pattern.split('|')
    if (!salt || !hash) return false
    try {
      const mac = createHmac('sha1', Buffer.from(salt, 'base64')).update(host).digest('base64')
      return mac === hash
    } catch {
      return false
    }
  }
  if (!/[*?]/.test(pattern)) return pattern.toLowerCase() === String(host).toLowerCase()
  const rx = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`,
    'i'
  )
  return rx.test(String(host))
}

export function parseKnownHosts(text) {
  const entries = []
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    let rest = line
    let marker = ''
    if (rest.startsWith('@')) {
      const sp = rest.search(/\s/)
      if (sp < 0) continue
      marker = rest.slice(1, sp).toLowerCase()
      rest = rest.slice(sp + 1).trim()
    }
    const parts = rest.split(/\s+/)
    if (parts.length < 3) continue
    entries.push({ marker, patterns: parts[0].split(','), keyType: parts[1], keyB64: parts[2] })
  }
  return entries
}

/**
 * @returns {{hostFound: boolean, keys: Array, revoked: string[], certAuthority: boolean}}
 */
export function lookupHostKey(entries, names) {
  const out = { hostFound: false, keys: [], revoked: [], certAuthority: false }
  for (const entry of entries) {
    let hit = false
    let negated = false
    for (const pattern of entry.patterns) {
      if (pattern.startsWith('!')) {
        if (names.some((n) => matchHostPattern(pattern.slice(1), n))) negated = true
      } else if (names.some((n) => matchHostPattern(pattern, n))) {
        hit = true
      }
    }
    if (!hit || negated) continue
    out.hostFound = true
    if (entry.marker === 'cert-authority') {
      out.certAuthority = true
      continue
    }
    if (entry.marker === 'revoked') {
      out.revoked.push(entry.keyB64)
      continue
    }
    out.keys.push({ keyType: entry.keyType, keyB64: entry.keyB64 })
  }
  return out
}

export function readKnownHosts(paths = knownHostsPaths()) {
  const entries = []
  const filesRead = []
  for (const p of paths) {
    if (!existsSync(p)) continue
    try {
      entries.push(...parseKnownHosts(readFileSync(p, 'utf8')))
      filesRead.push(p)
    } catch {
      /* unreadable known_hosts is treated as absent */
    }
  }
  return { entries, filesRead }
}

/** OpenSSH-style fingerprint of a raw host key blob. */
export function fingerprint(keyBlob) {
  const digest = createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '')
  return `SHA256:${digest}`
}

/** Key type is the first SSH string inside the blob, e.g. "ssh-ed25519". */
export function keyTypeFromBlob(keyBlob) {
  if (!Buffer.isBuffer(keyBlob) || keyBlob.length < 4) return null
  const len = keyBlob.readUInt32BE(0)
  if (len <= 0 || len > 64 || keyBlob.length < 4 + len) return null
  return keyBlob.subarray(4, 4 + len).toString('ascii')
}

export function rememberHostKey(host, port, keyBlob, paths = knownHostsPaths()) {
  const target = paths[0]
  if (!target) return null
  const names = hostNameForms(host, port)
  const keyType = keyTypeFromBlob(keyBlob) || 'ssh-unknown'
  const line = `${names[0]} ${keyType} ${Buffer.from(keyBlob).toString('base64')}\n`
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  appendFileSync(target, line, { mode: 0o600 })
  return target
}

/**
 * Decide whether a presented host key is acceptable.
 * Pure: takes the known_hosts entries, returns a decision the caller acts on.
 */
export function decideHostKey({ entries, host, port, keyBlob, policy = POLICY_STRICT }) {
  const names = hostNameForms(host, port)
  const presented = Buffer.from(keyBlob).toString('base64')
  const fp = fingerprint(keyBlob)
  const found = lookupHostKey(entries, names)

  if (found.revoked.includes(presented)) {
    return {
      ok: false,
      reason: `Host key for ${host}:${port} is marked @revoked in known_hosts (${fp}). Refusing to connect.`,
    }
  }

  if (found.keys.some((k) => k.keyB64 === presented)) {
    return { ok: true, reason: null, remember: false }
  }

  if (policy === POLICY_INSECURE) {
    return {
      ok: true,
      remember: false,
      warning: `SSH host key for ${host}:${port} NOT verified (${fp}) — DBEAVER_MCP_SSH_HOST_KEY_POLICY=insecure.`,
    }
  }

  if (found.hostFound && found.keys.length > 0) {
    return {
      ok: false,
      reason:
        `SSH host key mismatch for ${host}:${port}.\n` +
        `  presented: ${fp}\n` +
        `  known_hosts has a different key for this host.\n` +
        'This is what a man-in-the-middle attack looks like. If you genuinely rotated the host key, ' +
        `remove the old entry (ssh-keygen -R ${names[0]}) and reconnect.`,
    }
  }

  if (found.certAuthority) {
    return {
      ok: false,
      reason:
        `${host}:${port} is covered by a @cert-authority entry in known_hosts. ` +
        'Host certificates are not supported by dbeaver-mcp; add a plain host key entry for this host.',
    }
  }

  if (policy === POLICY_TOFU) {
    return {
      ok: true,
      remember: true,
      warning: `Trusting new SSH host key for ${host}:${port} on first use (${fp}).`,
    }
  }

  return {
    ok: false,
    reason:
      `Unknown SSH host key for ${host}:${port} (${fp}).\n` +
      `  Add it first:  ssh-keyscan -p ${port || 22} ${host} >> ~/.ssh/known_hosts\n` +
      '  Or connect once with ssh, or set DBEAVER_MCP_SSH_HOST_KEY_POLICY=tofu to trust on first use.',
  }
}
