import { existsSync, readFileSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CredentialsError, decryptCredentialsFile } from './decrypt.js'

/** Anything that speaks the Postgres wire protocol works through `pg`. */
const PG_WIRE =
  /(postgre|redshift|cockroach|timescale|greenplum|yugabyte|alloydb|citus|neon|supabase|edb)/i

function dataRoots() {
  const home = os.homedir()
  const roots = []
  const push = (p) => {
    if (p && !roots.includes(p)) roots.push(p)
  }

  if (process.env.APPDATA) push(path.join(process.env.APPDATA, 'DBeaverData'))
  if (process.env.LOCALAPPDATA) push(path.join(process.env.LOCALAPPDATA, 'DBeaverData'))
  push(path.join(home, 'AppData', 'Roaming', 'DBeaverData'))

  push(path.join(home, 'Library', 'DBeaverData'))
  push(path.join(home, 'Library', 'Application Support', 'DBeaverData'))

  if (process.env.XDG_DATA_HOME) push(path.join(process.env.XDG_DATA_HOME, 'DBeaverData'))
  push(path.join(home, '.local', 'share', 'DBeaverData'))
  // Snap and Flatpak are the two most common Linux installs and neither uses
  // the plain XDG path.
  push(path.join(home, 'snap', 'dbeaver-ce', 'current', '.local', 'share', 'DBeaverData'))
  push(path.join(home, 'snap', 'dbeaver-ce', 'common', '.local', 'share', 'DBeaverData'))
  push(path.join(home, '.var', 'app', 'io.dbeaver.DBeaverCommunity', 'data', 'DBeaverData'))
  push(
    path.join(home, '.var', 'app', 'io.dbeaver.DBeaverCommunity', '.local', 'share', 'DBeaverData')
  )

  return roots
}

export function workspaceCandidates() {
  if (process.env.DBEAVER_WORKSPACE) return [process.env.DBEAVER_WORKSPACE]

  const out = []
  const push = (p) => {
    if (p && !out.includes(p)) out.push(p)
  }

  for (const root of dataRoots()) {
    push(path.join(root, 'workspace6'))
    // The workspace directory is renamed between major DBeaver versions; take
    // whatever is actually on disk rather than guessing the next number.
    let entries = []
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory() && /^workspace/i.test(entry.name)) push(path.join(root, entry.name))
    }
  }

  push(path.join(os.homedir(), '.dbeaver4'))
  return out
}

export function isWorkspace(p) {
  return existsSync(path.join(p, 'General', '.dbeaver', 'data-sources.json'))
}

export function defaultWorkspace() {
  const tried = workspaceCandidates()
  const found = tried.find(isWorkspace)
  if (found) return found
  throw new Error(
    'DBeaver workspace not found. Set DBEAVER_WORKSPACE to the folder that contains ' +
      `General/.dbeaver/data-sources.json.\nTried:\n  ${tried.join('\n  ')}`
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
    const u = new URL(url.replace(/^jdbc:/, ''))
    const out = {
      host: u.hostname || null,
      port: u.port || null,
      database: u.pathname.replace(/^\//, '') || null,
    }
    if (u.searchParams.get('user')) out.user = u.searchParams.get('user')
    if (u.searchParams.get('password')) out.password = u.searchParams.get('password')
    if (u.searchParams.get('sslmode')) out.sslMode = u.searchParams.get('sslmode')
    if (u.searchParams.get('sslrootcert')) out.sslRootCert = u.searchParams.get('sslrootcert')
    return out
  } catch {
    return {}
  }
}

function sshFromConfig(configuration) {
  const tunnel = configuration?.handlers?.ssh_tunnel
  if (!tunnel || tunnel.enabled === false) return null
  const p = tunnel.properties || {}
  const authType = String(p.authType || tunnel.authType || 'PASSWORD').toUpperCase()
  return {
    host: p.host || null,
    port: Number(p.port || 22),
    user: tunnel.userName || tunnel.user || p.userName || p.user || null,
    authType,
    keyPath: p.keyPath || tunnel.keyPath || p.privateKeyPath || null,
    remoteHost: p.remoteHost || '',
    remotePort: Number(p.remotePort || 0) || null,
    localHost: p.localHost || '',
  }
}

/**
 * Reduce whatever is in the host field to an actual hostname.
 *
 * DBeaver will store exactly what was typed, and pasting a connection URL into
 * the Host box is an easy mistake — Supabase in particular hands you a URL. A
 * hostname can never contain `://`, a path or credentials, so stripping them is
 * unambiguous, and it turns an opaque `ENOTFOUND https://host/` into a
 * connection that works. A port found on the way out is offered to the caller,
 * which uses it only when nothing more explicit is configured.
 */
export function normalizeHost(raw) {
  let h = String(raw ?? '').trim()
  if (!h) return { host: 'localhost', port: null }

  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // scheme
  h = h.replace(/^[^/@]*@/, '') // user:pass@
  h = h.replace(/[/?#].*$/, '') // path, query, fragment

  let port = null
  const bracketed = h.match(/^\[([^\]]+)\](?::(\d+))?$/) // IPv6
  if (bracketed) {
    h = bracketed[1]
    port = bracketed[2] ? Number(bracketed[2]) : null
  } else {
    const withPort = h.match(/^([^:]+):(\d+)$/)
    if (withPort) {
      h = withPort[1]
      port = Number(withPort[2])
    }
  }

  return { host: h || 'localhost', port }
}

/** Does this DBeaver driver speak the Postgres wire protocol? */
export function isPostgresDriver(raw) {
  const hay = `${raw?.provider || ''} ${raw?.driver || ''}`
  return PG_WIRE.test(hay)
}

/** First non-empty value for any of `names` across the given property bags. */
function readProp(bags, ...names) {
  for (const bag of bags) {
    if (!bag || typeof bag !== 'object') continue
    for (const name of names) {
      const v = bag[name]
      if (v !== undefined && v !== null && String(v).length > 0) return String(v)
    }
  }
  return null
}

/**
 * Resolve TLS settings for a connection.
 *
 * DBeaver stores SSL in two unrelated places: plain connection properties (and
 * the JDBC URL), and a `handlers.postgre_ssl` block written by the SSL tab in
 * the connection dialog. Reading only the former means a user who ticked "Use
 * SSL" in the UI silently connects in cleartext.
 */
export function sslConfigFor(cfg, fromUrl) {
  const props = cfg.properties || {}
  const provider = cfg.providerProperties || {}
  const handler = cfg.handlers?.postgre_ssl || cfg.handlers?.postgresql_ssl || null
  const handlerOn = Boolean(handler) && handler.enabled !== false
  // A disabled handler keeps its old settings on disk; consulting them would
  // turn TLS back on for a connection the user explicitly switched it off for.
  const handlerProps = handlerOn ? handler.properties || {} : {}

  const bags = [handlerProps, props, provider]

  let mode =
    fromUrl.sslMode ||
    readProp(bags, 'sslMode', 'sslmode', 'ssl.mode', '@dbeaver-ssl-mode') ||
    null

  if (!mode) {
    // The SSL handler being enabled is itself the signal; libpq's own default
    // for "SSL on, mode unstated" is `require`.
    const useSsl =
      handlerOn ||
      props.ssl === 'true' ||
      props.ssl === true ||
      cfg.useSSL === true ||
      readProp(bags, 'ssl') === 'true'
    mode = useSsl ? 'require' : null
  }

  return {
    mode: mode ? String(mode).toLowerCase() : null,
    rootCert:
      fromUrl.sslRootCert ||
      readProp(bags, 'sslrootcert', 'ssl.root.cert', 'sslRootCert', 'ssl.ca.cert', 'ssl.ca'),
    cert: readProp(bags, 'sslcert', 'ssl.client.cert', 'ssl.cert', 'sslCert'),
    key: readProp(bags, 'sslkey', 'ssl.client.key', 'ssl.key', 'sslKey'),
  }
}

/**
 * Read the workspace.
 * @returns {{connections: object[], warnings: object[], workspace: string}}
 */
export function loadConnectionsDetailed(workspace = defaultWorkspace()) {
  const dir = dbeaverDir(workspace)
  const sourcesPath = path.join(dir, 'data-sources.json')
  const credsPath = path.join(dir, 'credentials-config.json')
  const warnings = []

  if (!existsSync(sourcesPath)) {
    throw new Error(`DBeaver data-sources.json not found: ${sourcesPath}`)
  }

  let sources
  try {
    sources = JSON.parse(readFileSync(sourcesPath, 'utf8'))
  } catch (err) {
    throw new Error(`${sourcesPath} is not valid JSON: ${err.message}`)
  }

  // A credential store we cannot read must not take the whole connection list
  // down with it — listing connections without passwords is still useful, and
  // the reason is far more actionable than a stack trace.
  let creds = {}
  if (existsSync(credsPath)) {
    try {
      creds = decryptCredentialsFile(credsPath)
    } catch (err) {
      warnings.push({
        code: err instanceof CredentialsError ? 'credentials-unreadable' : 'credentials-error',
        message: err.message,
        hint: err.hint || 'Saved passwords are unavailable; connections are listed without them.',
      })
    }
  } else {
    warnings.push({
      code: 'credentials-missing',
      message: `No credentials-config.json in ${dir}`,
      hint: 'Enable "Save password" in DBeaver for the connections you want to use here.',
    })
  }

  const connections = []
  for (const [id, raw] of Object.entries(sources.connections || {})) {
    const cfg = raw.configuration || {}
    const fromUrl = parseJdbcUrl(cfg.url)
    const secrets = credsFor(creds, id)
    const ssl = sslConfigFor(cfg, fromUrl)
    const ssh = sshFromConfig(cfg)
    const located = normalizeHost(cfg.host || fromUrl.host || 'localhost')
    const host = located.host
    const port = Number(cfg.port || fromUrl.port || located.port || 5432)
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

    connections.push({
      id,
      name: raw.name || id,
      provider: raw.provider || null,
      driver: raw.driver || raw.provider || 'unknown',
      supported: isPostgresDriver(raw),
      host,
      port,
      database,
      user,
      password,
      sslMode: ssl.mode,
      sslRootCert: ssl.rootCert,
      sslCert: ssl.cert,
      sslKey: ssl.key,
      schema: cfg.bootstrap?.defaultSchema || 'public',
      ssh,
    })
  }

  const unsupported = connections.filter((c) => !c.supported)
  if (unsupported.length) {
    warnings.push({
      code: 'unsupported-drivers',
      message: `${unsupported.length} connection(s) use a non-Postgres driver and cannot be queried: ${unsupported
        .map((c) => `${c.name} (${c.driver})`)
        .join(', ')}`,
      hint: 'dbeaver-mcp speaks the Postgres wire protocol only.',
    })
  }

  return { connections, warnings, workspace }
}

export function loadConnections(workspace) {
  return loadConnectionsDetailed(workspace).connections
}

function describe(list) {
  return list.map((c) => c.name).join(', ') || '(none)'
}

/**
 * Resolve a connection by id or name.
 *
 * Substring matching is convenient for reads and dangerous for writes: "prod"
 * happily matches `prod-staging`. Callers that mutate data pass `fuzzy: false`.
 * Ambiguity is always an error, never a silent pick of the first match.
 */
export function resolveConnection(list, nameOrId, { fuzzy = true } = {}) {
  const needle = String(nameOrId ?? '').trim()
  if (!needle) throw new Error(`Connection name is required. Known: ${describe(list)}`)
  const lower = needle.toLowerCase()

  const byId = list.filter((c) => String(c.id).toLowerCase() === lower)
  if (byId.length === 1) return byId[0]

  const byName = list.filter((c) => c.name.toLowerCase() === lower)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) {
    throw new Error(
      `"${needle}" matches ${byName.length} connections with the same name. Use the id instead: ${byName
        .map((c) => c.id)
        .join(', ')}`
    )
  }

  if (!fuzzy) {
    throw new Error(
      `No connection is named exactly "${needle}". Writes require an exact name or id — ` +
        `partial matching could hit the wrong database. Known: ${describe(list)}`
    )
  }

  const partial = list.filter((c) => c.name.toLowerCase().includes(lower))
  if (partial.length === 1) return partial[0]
  if (partial.length > 1) {
    throw new Error(
      `"${needle}" is ambiguous — it matches ${partial.length} connections: ${describe(partial)}. ` +
        'Use the full name or the id.'
    )
  }

  throw new Error(`Unknown connection "${needle}". Known: ${describe(list)}`)
}

/** Back-compatible lookup: null when nothing matches, throws when ambiguous. */
export function findConnection(list, nameOrId, opts) {
  try {
    return resolveConnection(list, nameOrId, opts)
  } catch (err) {
    if (/^Unknown connection/.test(err.message)) return null
    throw err
  }
}

export function publicConnection(c) {
  return {
    id: c.id,
    name: c.name,
    driver: c.driver,
    supported: c.supported !== false,
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
          remotePort: c.ssh.remotePort,
          authType: c.ssh.authType,
        }
      : null,
    hasPassword: Boolean(c.password),
    hasSshPassword: Boolean(c.ssh?.password),
  }
}
