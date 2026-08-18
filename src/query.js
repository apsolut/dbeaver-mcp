import pg from 'pg'
import { ensureTunnel } from './tunnel.js'

const WRITE_HEAD =
  /^(insert|update|delete|alter|drop|create|truncate|grant|revoke|comment|vacuum|reindex|copy|call|do|refresh|merge|lock)\b/i
const WRITE_FUNCS = /\b(setval|nextval)\s*\(/i
const WITH_MUTATION = /^with\b[\s\S]*\b(insert|update|delete|merge)\b/i

/** Split SQL on top-level semicolons. Leaves `;` inside strings, comments, and $tag$ quotes. */
export function splitStatements(sql) {
  const src = String(sql ?? '')
  const out = []
  let buf = ''
  let i = 0
  let state = 'normal'
  let dollarTag = ''

  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]

    if (state === 'normal') {
      if (c === '-' && n === '-') {
        state = 'line'
        buf += c
        i++
        continue
      }
      if (c === '/' && n === '*') {
        state = 'block'
        buf += c
        i++
        continue
      }
      if (c === "'") {
        state = 'squote'
        buf += c
        i++
        continue
      }
      if (c === '$') {
        const m = src.slice(i).match(/^\$[A-Za-z0-9_]*\$/)
        if (m) {
          state = 'dollar'
          dollarTag = m[0]
          buf += m[0]
          i += m[0].length
          continue
        }
      }
      if (c === ';') {
        const stmt = buf.trim()
        if (stmt) out.push(stmt)
        buf = ''
        i++
        continue
      }
      buf += c
      i++
      continue
    }

    if (state === 'line') {
      buf += c
      if (c === '\n') state = 'normal'
      i++
      continue
    }

    if (state === 'block') {
      buf += c
      if (c === '*' && n === '/') {
        buf += n
        i += 2
        state = 'normal'
        continue
      }
      i++
      continue
    }

    if (state === 'squote') {
      buf += c
      if (c === "'" && n === "'") {
        buf += n
        i += 2
        continue
      }
      if (c === "'") state = 'normal'
      i++
      continue
    }

    if (src.startsWith(dollarTag, i)) {
      buf += dollarTag
      i += dollarTag.length
      state = 'normal'
      continue
    }
    buf += c
    i++
  }

  const tail = buf.trim()
  if (tail) out.push(tail)
  return out
}

function stripLeadingComments(sql) {
  return String(sql ?? '')
    .replace(/^\s*--[^\n]*\n?/gm, '')
    .replace(/^\s*\/\*[\s\S]*?\*\//g, '')
    .trim()
}

export function statementIsWrite(sql) {
  const s = stripLeadingComments(sql)
  if (!s) return false
  if (WRITE_HEAD.test(s)) return true
  if (WRITE_FUNCS.test(s)) return true
  if (WITH_MUTATION.test(s)) return true
  return false
}

/** True if any statement mutates data (including SELECT setval / nextval). */
export function isWriteSql(sql) {
  return splitStatements(sql).some(statementIsWrite)
}

export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`
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

function shapeResult(result, maxRows) {
  const allRows = Array.isArray(result.rows) ? result.rows : []
  const rows = allRows.slice(0, maxRows)
  return {
    rowCount: result.rowCount ?? allRows.length,
    fields: (result.fields || []).map((f) => f.name),
    rows,
    truncated: allRows.length > maxRows,
  }
}

async function withClient(conn, fn) {
  if (!conn.user) throw new Error(`No database user for ${conn.name}`)
  if (!conn.password) throw new Error(`No database password for ${conn.name}`)
  const cfg = await connectTarget(conn)
  const client = new pg.Client(cfg)
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end().catch(() => {})
  }
}

/**
 * Run one or more statements on the same connection.
 * Multiple statements always return `{ statementCount, results }`.
 * A single statement also spreads the first result at the top level (old shape).
 */
export async function runQuery(conn, sql, { maxRows = 200, transaction, allowWrites = true } = {}) {
  const statements = splitStatements(sql)
  if (statements.length === 0) throw new Error('No SQL statements to run')

  const writes = statements.filter(statementIsWrite)
  if (writes.length && !allowWrites) {
    throw new Error('Refusing write SQL on execute_query. Use write_query or run_script.')
  }

  const useTx = transaction === true || (transaction !== false && allowWrites && statements.length > 1 && writes.length > 0)

  return withClient(conn, async (client) => {
    if (useTx) await client.query('BEGIN')
    const results = []
    try {
      for (const statement of statements) {
        const result = await client.query(statement)
        results.push({ sql: statement, ...shapeResult(result, maxRows) })
      }
      if (useTx) await client.query('COMMIT')
    } catch (err) {
      if (useTx) await client.query('ROLLBACK').catch(() => {})
      throw err
    }

    const first = results[0]
    return {
      statementCount: results.length,
      transaction: useTx,
      results,
      rowCount: first.rowCount,
      fields: first.fields,
      rows: first.rows,
      truncated: first.truncated,
    }
  })
}

export async function runScript(conn, statements, { maxRows = 200, transaction } = {}) {
  const list = (Array.isArray(statements) ? statements : [])
    .flatMap((s) => splitStatements(s))
    .filter(Boolean)
  if (list.length === 0) throw new Error('run_script needs at least one statement')
  if (list.length > 50) throw new Error(`run_script allows at most 50 statements (got ${list.length})`)
  return runQuery(conn, list.join(';\n'), { maxRows, transaction, allowWrites: true })
}

export async function inspectSequences(conn, { schema, table } = {}) {
  const sch = schema || conn.schema || 'public'
  const params = [sch]
  let owned = `
    SELECT
      n.nspname AS schema,
      t.relname AS table,
      a.attname AS column,
      s.relname AS sequence,
      pg_sequence_last_value(s.oid)::text AS last_value
    FROM pg_class t
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN pg_depend d ON d.refobjid = t.oid AND d.refobjsubid = a.attnum AND d.deptype IN ('a', 'i')
    JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
    WHERE t.relkind IN ('r', 'p')
      AND n.nspname = $1`
  if (table) {
    params.push(table)
    owned += ` AND t.relname = $2`
  }
  owned += ` ORDER BY n.nspname, t.relname, a.attname`

  return withClient(conn, async (client) => {
    const found = await client.query(owned, params)
    const rows = []
    for (const row of found.rows) {
      const maxSql = `SELECT MAX(${quoteIdent(row.column)})::text AS max_value FROM ${quoteIdent(row.schema)}.${quoteIdent(row.table)}`
      const maxRes = await client.query(maxSql)
      const maxValue = maxRes.rows[0]?.max_value ?? null
      const last = row.last_value == null ? null : Number(row.last_value)
      const max = maxValue == null ? null : Number(maxValue)
      const needsReset = max != null && Number.isFinite(max) && (last == null || last < max)
      rows.push({
        schema: row.schema,
        table: row.table,
        column: row.column,
        sequence: row.sequence,
        last_value: row.last_value,
        max_value: maxValue,
        needs_reset: needsReset,
      })
    }
    return {
      schema: sch,
      table: table || null,
      rowCount: rows.length,
      fields: ['schema', 'table', 'column', 'sequence', 'last_value', 'max_value', 'needs_reset'],
      rows,
      truncated: false,
    }
  })
}
