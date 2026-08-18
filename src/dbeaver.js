import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { decryptCredentialsFile } from './decrypt.js'

export function workspaceCandidates() {
  if (process.env.DBEAVER_WORKSPACE) return [process.env.DBEAVER_WORKSPACE]
  const home = os.homedir()
  const list = []
  if (process.env.APPDATA) {
    list.push(path.join(process.env.APPDATA, 'DBeaverData', 'workspace6'))
  }
  list.push(path.join(home, 'Library', 'DBeaverData', 'workspace6'))
  list.push(path.join(home, '.local', 'share', 'DBeaverData', 'workspace6'))
  list.push(path.join(home, '.dbeaver4'))
  return list
}

export function defaultWorkspace() {
  const tried = workspaceCandidates()
  const found = tried.find((p) =>
    existsSync(path.join(p, 'General', '.dbeaver', 'data-sources.json'))
  )
  if (found) return found
  throw new Error(
    `DBeaver workspace not found. Set DBEAVER_WORKSPACE to the folder that contains General/.dbeaver/data-sources.json. Tried: ${tried.join(', ')}`
  )
}

function dbeaverDir(workspace) {
  return path.join(workspace, 'General', '.dbeaver')
}

function credsFor(blob, connectionId) {
  const entry = blob?.[connectionId] || {}
  const conn = entry['#connection'] || {}
  const ssh =
    entry['network/ssh_tunnel'] ||
    entry['network/ssh_tunnel.auth'] ||
    entry['ssh_tunnel.auth'] ||
    {}
  return {
    user: conn.user || conn.username || null,
    password: conn.password || null,
    sshUser: ssh.user || ssh.username || null,
    sshPassword: ssh.password || null,
  }
}

function parseJdbcUrl(url) {
  if (!url || typeof url !== 'string') return {}
  try {
    const stripped = url.replace(/^jdbc:/, '')
    const u = new URL(stripped)
    const out = {
      host: u.hostname || null,
      port: u.port || null,
      database: u.pathname.replace(/^\//, '') || null,
    }
    if (u.searchParams.get('user')) out.user = u.searchParams.get('user')
    if (u.searchParams.get('password')) out.password = u.searchParams.get('password')
    if (u.searchParams.get('sslmode')) out.sslMode = u.searchParams.get('sslmode')
    return out
  } catch {
    return {}
  }
}

function sshFromConfig(configuration) {
  const tunnel = configuration?.handlers?.ssh_tunnel
  if (!tunnel || tunnel.enabled === false) return null
  const p = tunnel.properties || {}
  return {
    host: p.host || null,
    port: Number(p.port || 22),
    authType: p.authType || 'PASSWORD',
    remoteHost: p.remoteHost || '',
    localHost: p.localHost || '',
  }
}

export function loadConnections(workspace = defaultWorkspace()) {
  const dir = dbeaverDir(workspace)
  const sourcesPath = path.join(dir, 'data-sources.json')
  const credsPath = path.join(dir, 'credentials-config.json')
  if (!existsSync(sourcesPath)) {
    throw new Error(`DBeaver data-sources.json not found: ${sourcesPath}`)
  }

  const sources = JSON.parse(readFileSync(sourcesPath, 'utf8'))
  let creds = {}
  if (existsSync(credsPath)) {
    creds = decryptCredentialsFile(credsPath)
  }

  const list = []
  for (const [id, raw] of Object.entries(sources.connections || {})) {
    const cfg = raw.configuration || {}
    const fromUrl = parseJdbcUrl(cfg.url)
    const secrets = credsFor(creds, id)
    const ssh = sshFromConfig(cfg)
    const host = cfg.host || fromUrl.host || 'localhost'
    const port = Number(cfg.port || fromUrl.port || 5432)
    const database = cfg.database || cfg.bootstrap?.defaultCatalog || fromUrl.database || 'postgres'
    const user = secrets.user || fromUrl.user || cfg.user || null
    const password = secrets.password || fromUrl.password || null
    if (ssh) {
      ssh.user = secrets.sshUser || ssh.user || null
      ssh.password = secrets.sshPassword || null
      if (!ssh.remoteHost) {
        ssh.remoteHost = host === 'localhost' || host === '127.0.0.1' ? '127.0.0.1' : host
      }
    }

    list.push({
      id,
      name: raw.name || id,
      driver: raw.driver || raw.provider || 'unknown',
      host,
      port,
      database,
      user,
      password,
      sslMode: fromUrl.sslMode || null,
      schema: cfg.bootstrap?.defaultSchema || 'public',
      ssh,
    })
  }
  return list
}

export function findConnection(list, nameOrId) {
  const needle = String(nameOrId).toLowerCase()
  return (
    list.find((c) => c.id.toLowerCase() === needle) ||
    list.find((c) => c.name.toLowerCase() === needle) ||
    list.find((c) => c.name.toLowerCase().includes(needle)) ||
    null
  )
}

export function publicConnection(c) {
  return {
    id: c.id,
    name: c.name,
    driver: c.driver,
    host: c.host,
    port: c.port,
    database: c.database,
    user: c.user,
    schema: c.schema,
    sslMode: c.sslMode,
    ssh: c.ssh
      ? {
          host: c.ssh.host,
          port: c.ssh.port,
          user: c.ssh.user,
          remoteHost: c.ssh.remoteHost,
          authType: c.ssh.authType,
        }
      : null,
    hasPassword: Boolean(c.password),
    hasSshPassword: Boolean(c.ssh?.password),
  }
}
