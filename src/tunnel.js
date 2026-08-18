import net from 'node:net'
import { Client } from 'ssh2'

const tunnels = new Map()

function tunnelKey(ssh, remotePort) {
  return `${ssh.user}@${ssh.host}:${ssh.port}->${ssh.remoteHost}:${remotePort}`
}

export async function ensureTunnel(ssh, remotePort) {
  const key = tunnelKey(ssh, remotePort)
  const existing = tunnels.get(key)
  if (existing) return existing.localPort

  if (!ssh.host) throw new Error('SSH host is missing')
  if (!ssh.user) throw new Error(`SSH user missing for ${ssh.host} (check DBeaver SSH auth)`)
  if (ssh.authType === 'PASSWORD' && !ssh.password) {
    throw new Error(`SSH password missing for ${ssh.user}@${ssh.host}`)
  }

  const conn = new Client()
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`SSH timeout to ${ssh.host}:${ssh.port}`)), 25000)
    conn
      .on('ready', () => {
        clearTimeout(timer)
        resolve()
      })
      .on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      .connect({
        host: ssh.host,
        port: ssh.port || 22,
        username: ssh.user,
        password: ssh.password || undefined,
        privateKey: ssh.privateKey || undefined,
        readyTimeout: 20000,
        keepaliveInterval: 15000,
      })
  })

  const server = net.createServer((sock) => {
    conn.forwardOut('127.0.0.1', 0, ssh.remoteHost, remotePort, (err, stream) => {
      if (err) {
        sock.destroy()
        return
      }
      sock.pipe(stream).pipe(sock)
      sock.on('error', () => stream.end())
      stream.on('error', () => sock.destroy())
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const localPort = server.address().port
  tunnels.set(key, { conn, server, localPort })

  conn.on('close', () => {
    try {
      server.close()
    } catch {
      /* ignore */
    }
    tunnels.delete(key)
  })

  return localPort
}

export async function closeTunnels() {
  for (const [, t] of tunnels) {
    try {
      t.server.close()
    } catch {
      /* ignore */
    }
    try {
      t.conn.end()
    } catch {
      /* ignore */
    }
  }
  tunnels.clear()
}
