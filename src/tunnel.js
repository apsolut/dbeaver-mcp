import { readFileSync } from 'node:fs'
import net from 'node:net'
import { Client } from 'ssh2'
import {
  POLICY_INSECURE,
  decideHostKey,
  hostKeyPolicy,
  knownHostsPaths,
  readKnownHosts,
  rememberHostKey,
} from './knownhosts.js'

/** key -> Promise<{ conn, server, localPort, closed }> */
const tunnels = new Map()

function tunnelKey(ssh, remotePort) {
  return `${ssh.user}@${ssh.host}:${ssh.port}->${ssh.remoteHost}:${remotePort}`
}

function warn(msg) {
  process.stderr.write(`[dbeaver-mcp] ${msg}\n`)
}

function authOptions(ssh) {
  const type = String(ssh.authType || 'PASSWORD').toUpperCase()

  if (type === 'AGENT' || type === 'SSH_AGENT') {
    const sock = process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? 'pageant' : null)
    if (!sock) {
      throw new Error(
        `SSH agent auth requested for ${ssh.user}@${ssh.host} but SSH_AUTH_SOCK is not set in this process. ` +
          'MCP servers do not inherit a desktop agent automatically — start the agent before the host, or switch the connection to key/password auth.'
      )
    }
    return { agent: sock }
  }

  if (type === 'PUBLIC_KEY' || ssh.privateKey || ssh.keyPath) {
    let key = ssh.privateKey || null
    if (!key && ssh.keyPath) {
      try {
        key = readFileSync(ssh.keyPath)
      } catch (err) {
        throw new Error(
          `Cannot read SSH private key ${ssh.keyPath} for ${ssh.user}@${ssh.host}: ${err.message}`
        )
      }
    }
    if (!key) {
      throw new Error(
        `SSH key auth is configured for ${ssh.user}@${ssh.host} but DBeaver did not record a key path. Set it in DBeaver, or use password auth.`
      )
    }
    const opts = { privateKey: key }
    // DBeaver stores the key passphrase in the same slot as the SSH password.
    if (ssh.password) opts.passphrase = ssh.password
    return opts
  }

  if (!ssh.password) {
    throw new Error(
      `SSH password missing for ${ssh.user}@${ssh.host}. Enable "Save password" for the SSH tunnel in DBeaver so the credential is in the local store.`
    )
  }
  return { password: ssh.password }
}

function buildHostVerifier(ssh, state) {
  const policy = hostKeyPolicy()
  const paths = knownHostsPaths()
  const { entries } = readKnownHosts(paths)

  return (keyBlob) => {
    const decision = decideHostKey({
      entries,
      host: ssh.host,
      port: ssh.port || 22,
      keyBlob,
      policy,
    })
    if (decision.warning) warn(decision.warning)
    if (!decision.ok) {
      state.rejection = decision.reason
      return false
    }
    if (decision.remember) {
      try {
        const written = rememberHostKey(ssh.host, ssh.port || 22, keyBlob, paths)
        if (written) warn(`Recorded host key in ${written}`)
      } catch (err) {
        warn(`Could not record host key: ${err.message}`)
      }
    }
    return true
  }
}

async function openTunnel(ssh, remotePort) {
  if (!ssh.host) throw new Error('SSH host is missing')
  if (!ssh.user) throw new Error(`SSH user missing for ${ssh.host} (check the DBeaver SSH tunnel settings)`)

  const auth = authOptions(ssh)
  const state = { rejection: null }
  const hostVerifier = buildHostVerifier(ssh, state)

  if (hostKeyPolicy() === POLICY_INSECURE) {
    warn('SSH host key verification is DISABLED for this process. Do not use this against production.')
  }

  const conn = new Client()
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`SSH timeout to ${ssh.host}:${ssh.port || 22}`)),
      25000
    )
    const done = (err) => {
      clearTimeout(timer)
      if (err) {
        try {
          conn.end()
        } catch {
          /* ignore */
        }
        // A rejected host key surfaces as a generic handshake error; replace it
        // with the reason the verifier actually recorded.
        reject(state.rejection ? new Error(state.rejection) : err)
        return
      }
      resolve()
    }
    conn
      .on('ready', () => done())
      .on('error', (err) => done(err))
      .connect({
        host: ssh.host,
        port: ssh.port || 22,
        username: ssh.user,
        readyTimeout: 20000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 4,
        hostVerifier,
        ...auth,
      })
  })

  const server = net.createServer((sock) => {
    sock.on('error', () => sock.destroy())
    conn.forwardOut('127.0.0.1', 0, ssh.remoteHost, remotePort, (err, stream) => {
      if (err) {
        warn(`SSH forward to ${ssh.remoteHost}:${remotePort} failed: ${err.message}`)
        sock.destroy()
        return
      }
      sock.pipe(stream).pipe(sock)
      sock.on('error', () => stream.end())
      stream.on('error', () => sock.destroy())
    })
  })
  server.on('error', (err) => warn(`Local tunnel socket error: ${err.message}`))

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const record = { conn, server, localPort: server.address().port, closed: false }

  conn.on('close', () => {
    record.closed = true
    try {
      server.close()
    } catch {
      /* ignore */
    }
  })

  return record
}

/**
 * Fetch the host key a bastion presents, without authenticating.
 *
 * The verifier always returns false, so the handshake aborts at the host-key
 * stage — no username, password or key material is ever sent to a server we
 * have not yet decided to trust. This is what makes an interactive "here is the
 * fingerprint, do you accept it?" flow safe.
 */
export async function probeHostKey(ssh) {
  if (!ssh?.host) throw new Error('SSH host is missing')
  const port = ssh.port || 22

  return new Promise((resolve, reject) => {
    const conn = new Client()
    let captured = null
    let settled = false

    const finish = (fn, arg) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        conn.end()
      } catch {
        /* ignore */
      }
      fn(arg)
    }

    const timer = setTimeout(
      () => finish(reject, new Error(`SSH timeout to ${ssh.host}:${port}`)),
      20000
    )

    conn
      .on('error', (err) =>
        captured
          ? finish(resolve, captured)
          : finish(reject, new Error(`Could not reach ${ssh.host}:${port}: ${err.message}`))
      )
      .on('ready', () => finish(resolve, captured))
      .connect({
        host: ssh.host,
        port,
        username: ssh.user || 'probe',
        readyTimeout: 15000,
        hostVerifier: (key) => {
          captured = Buffer.from(key)
          return false
        },
      })
  })
}

export async function ensureTunnel(ssh, remotePort, attempt = 0) {
  const key = tunnelKey(ssh, remotePort)
  let pending = tunnels.get(key)
  if (!pending) {
    // Store the promise, not the result, so parallel queries share one tunnel
    // instead of racing to open several.
    pending = openTunnel(ssh, remotePort)
    pending.catch(() => tunnels.delete(key))
    tunnels.set(key, pending)
  }

  const record = await pending
  if (record.closed) {
    tunnels.delete(key)
    if (attempt >= 1) throw new Error(`SSH tunnel to ${ssh.host} keeps dropping`)
    return ensureTunnel(ssh, remotePort, attempt + 1)
  }
  return record.localPort
}

export async function closeTunnels() {
  const pending = [...tunnels.values()]
  tunnels.clear()
  for (const p of pending) {
    let record
    try {
      record = await p
    } catch {
      continue
    }
    record.closed = true
    try {
      record.server.close()
    } catch {
      /* ignore */
    }
    try {
      record.conn.end()
    } catch {
      /* ignore */
    }
  }
}

/** Best-effort synchronous teardown for process-exit paths. */
export function closeTunnelsSync() {
  for (const p of tunnels.values()) {
    if (typeof p.then !== 'function') continue
    p.then(
      (record) => {
        try {
          record.server.close()
        } catch {
          /* ignore */
        }
        try {
          record.conn.end()
        } catch {
          /* ignore */
        }
      },
      () => {}
    )
  }
  tunnels.clear()
}
