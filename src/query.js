import pg from 'pg'
import { ensureTunnel } from './tunnel.js'

const WRITE_RE =
  /^\s*(insert|update|delete|alter|drop|create|truncate|grant|revoke|comment|vacuum|reindex|copy|call|do)\b/i

export function isWriteSql(sql) {
  const stripped = String(sql)
    .replace(/^\s*--[^\n]*\n/g, '')
    .replace(/^\s*\/\*[\s\S]*?\*\//g, '')
    .trim()
  return WRITE_RE.test(stripped)
}

async function connectTarget(conn) {
  if (conn.ssh) {
    const localPort = await ensureTunnel(conn.ssh, conn.port)
    return {
      host: '127.0.0.1',
      port: localPort,
      user: conn.user,
      password: conn.password,
      database: conn.database,
      connectionTimeoutMillis: 15000,
    }
  }

  const cfg = {
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: conn.database,
    connectionTimeoutMillis: 15000,
  }
  if (conn.sslMode && conn.sslMode !== 'disable') {
    cfg.ssl = { rejectUnauthorized: false }
  }
  return cfg
}

export async function runQuery(conn, sql, { maxRows = 200 } = {}) {
  if (!conn.user) throw new Error(`No database user for ${conn.name}`)
  if (!conn.password) throw new Error(`No database password for ${conn.name}`)

  const cfg = await connectTarget(conn)
  const client = new pg.Client(cfg)
  try {
    await client.connect()
    const result = await client.query(sql)
    const rows = Array.isArray(result.rows) ? result.rows.slice(0, maxRows) : []
    return {
      rowCount: result.rowCount ?? rows.length,
      fields: (result.fields || []).map((f) => f.name),
      rows,
      truncated: Array.isArray(result.rows) && result.rows.length > maxRows,
    }
  } finally {
    await client.end().catch(() => {})
  }
}
