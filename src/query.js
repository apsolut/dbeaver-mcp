import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { ensureTunnel } from './tunnel.js'

const WRITE_HEAD =
  /^(insert|update|delete|alter|drop|create|truncate|grant|revoke|comment|vacuum|reindex|copy|call|do|refresh|merge|lock)\b/i
const WRITE_FUNCS = /\b(setval|nextval)\s*\(/i
const WITH_MUTATION = /^with\b[\s\S]*\b(insert|update|delete|merge)\b/i

/**
 * Statements that would take transaction control away from this server.
 *
 * The read-only promise is the engine's — `BEGIN TRANSACTION READ ONLY` — and
 * that is exactly why these have to be refused. A leading `COMMIT` *ends* the
 * read-only transaction, so every statement after it runs unprotected: a
 * `SELECT` calling a volatile function that writes is not caught by
 * `statementIsWrite`, and would then succeed. `SET TRANSACTION READ WRITE` is
 * accepted by Postgres before the first query of a transaction and defeats it
 * just as directly.
 *
 * Refused on write paths too: `run_script` promises a single transaction, and a
 * mid-batch `COMMIT` silently makes the earlier half non-rollbackable.
 */
const TX_CONTROL =
  /^(begin|start\s+transaction|commit|end|rollback|abort|savepoint|release\b|prepare\s+transaction|commit\s+prepared|rollback\s+prepared|set\s+transaction|set\s+session\s+characteristics|set\s+constraints|discard)\b/i

/**
 * Settings that exist to protect the caller. Letting SQL clear them is not a
 * feature: `SET statement_timeout = 0` removes the runaway-query guard, and
 * `SET ROLE` / `SET SESSION AUTHORIZATION` change who the connection is.
 */
const GUARD_SETTINGS =
  /^(set|reset)\s+(session\s+|local\s+)?(statement_timeout|lock_timeout|idle_in_transaction_session_timeout|default_transaction_read_only|transaction_read_only|session_replication_role|role|session_authorization|authorization|all)\b/i

/**
 * Objects that hand out credentials or read the server's filesystem.
 *
 * `pg_authid` holds every role's SCRAM verifier and `pg_read_file` reads
 * arbitrary server files — both are plain reads, so a read-only transaction
 * permits them happily. They are superuser-only, which is the mitigation, but
 * "the agent asked for the password hashes and got them" is not a defensible
 * outcome when the connection happens to be privileged.
 *
 * Set DBEAVER_MCP_ALLOW_SENSITIVE_READS=true if you genuinely need these.
 */
const SENSITIVE_OBJECTS =
  /\b(pg_authid|pg_shadow|pg_user_mappings|pg_read_file|pg_read_binary_file|pg_stat_file|pg_ls_dir|pg_ls_logdir|pg_ls_waldir|pg_ls_tmpdir|pg_ls_archive_statusdir)\b/i
/** Statements Postgres refuses to run inside a transaction block. */
const NO_TRANSACTION =
  /^(vacuum|analyze\s|create\s+database|drop\s+database|create\s+tablespace|drop\s+tablespace|alter\s+system|cluster\b|reindex\s+(database|system)|(create|drop|reindex)\s+index\s+concurrently|create\s+index\s+concurrently|alter\s+type\s+\S+\s+add\s+value)/i

function envInt(name, fallback) {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback
}

const CONNECT_TIMEOUT_MS = envInt('DBEAVER_MCP_CONNECT_TIMEOUT_MS', 15000)
const STATEMENT_TIMEOUT_MS = envInt('DBEAVER_MCP_STATEMENT_TIMEOUT_MS', 30000)
const LOCK_TIMEOUT_MS = envInt('DBEAVER_MCP_LOCK_TIMEOUT_MS', 10000)
const IDLE_TX_TIMEOUT_MS = envInt('DBEAVER_MCP_IDLE_TX_TIMEOUT_MS', 30000)
const MAX_CELL_BYTES = envInt('DBEAVER_MCP_MAX_CELL_BYTES', 2048)
const MAX_TOTAL_BYTES = envInt('DBEAVER_MCP_MAX_BYTES', 262144)

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
      if (c === '"') {
        state = 'dquote'
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

    if (state === 'dquote') {
      buf += c
      if (c === '"' && n === '"') {
        buf += n
        i += 2
        continue
      }
      if (c === '"') state = 'normal'
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

/**
 * True if any statement mutates data (including SELECT setval / nextval).
 * This is a fast pre-filter for a friendly error message — the actual read-only
 * boundary is enforced by Postgres via BEGIN TRANSACTION READ ONLY.
 */
export function isWriteSql(sql) {
  return splitStatements(sql).some(statementIsWrite)
}

export function statementBlocksTransaction(sql) {
  return NO_TRANSACTION.test(stripLeadingComments(sql))
}

/**
 * True if the statement would seize transaction control or disarm a guard.
 * Checked on every path, reads and writes alike — this server owns its own
 * transactions and its own timeouts.
 */
export function statementHijacksSession(sql) {
  const s = stripLeadingComments(sql)
  if (!s) return false
  return TX_CONTROL.test(s) || GUARD_SETTINGS.test(s)
}

export function sensitiveReadsAllowed(env = process.env) {
  return ['true', '1', 'yes', 'on'].includes(
    String(env.DBEAVER_MCP_ALLOW_SENSITIVE_READS ?? '').trim().toLowerCase()
  )
}

/** Names a credential store or a server-side file reader, or null. */
export function describeSensitiveRead(sql) {
  const m = SENSITIVE_OBJECTS.exec(stripQuoted(sql))
  return m ? m[1].toLowerCase() : null
}

export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`
}

/** Escape for a single-quoted SQL string literal. */
export function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Exact integer from Postgres text, or null.
 * Sequence values are bigint, so they arrive as text precisely to avoid the
 * rounding that Number() would reintroduce.
 */
export function toBigIntOrNull(value) {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  return /^-?\d+$/.test(s) ? BigInt(s) : null
}

/**
 * Blank out string, dollar-quoted and double-quoted spans so a keyword sitting
 * inside a value or a quoted identifier cannot be read as syntax.
 */
export function stripQuoted(sql) {
  return String(sql ?? '')
    .replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, "''")
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
}

/* ------------------------------------------------------------------ TLS */

function defaultRootCertPaths() {
  const paths = []
  if (process.env.DBEAVER_MCP_SSL_ROOT_CERT) paths.push(process.env.DBEAVER_MCP_SSL_ROOT_CERT)
  // Same locations libpq looks in.
  if (process.env.APPDATA) paths.push(join(process.env.APPDATA, 'postgresql', 'root.crt'))
  paths.push(join(homedir(), '.postgresql', 'root.crt'))
  return paths
}

function loadRootCert(conn) {
  const paths = [conn?.sslRootCert, ...defaultRootCertPaths()].filter(Boolean)
  for (const p of paths) {
    try {
      if (existsSync(p)) return readFileSync(p)
    } catch {
      /* unreadable cert is treated as absent */
    }
  }
  return null
}

/**
 * Map libpq sslmode semantics onto Node TLS options.
 *
 * `require` encrypts but does not authenticate; `verify-ca` authenticates the
 * chain; `verify-full` also checks the hostname. Treating every mode as
 * `rejectUnauthorized: false` silently downgrades users who asked for
 * verification.
 */
function readPem(p) {
  if (!p) return null
  try {
    if (existsSync(p)) return readFileSync(p)
  } catch {
    /* unreadable cert material falls back to the default trust store */
  }
  return null
}

export function sslOptions(conn) {
  const mode = String(conn?.sslMode || '').toLowerCase()
  if (!mode || mode === 'disable') return null

  const ca = loadRootCert(conn)
  const base = ca ? { ca } : {}
  // Client certificate auth (DBeaver's SSL tab writes these alongside the CA).
  const cert = readPem(conn?.sslCert)
  const key = readPem(conn?.sslKey)
  if (cert) base.cert = cert
  if (key) base.key = key

  if (mode === 'allow' || mode === 'prefer' || mode === 'require') {
    return { ...base, rejectUnauthorized: false }
  }
  if (mode === 'verify-ca') {
    // Chain is verified, hostname deliberately is not — that is what verify-ca means.
    return { ...base, rejectUnauthorized: true, checkServerIdentity: () => undefined }
  }
  if (mode === 'verify-full') {
    return { ...base, rejectUnauthorized: true }
  }
  // Unknown mode: fail closed rather than guess.
  return { ...base, rejectUnauthorized: true }
}

/* ------------------------------------------------------- connection setup */

async function connectTarget(conn, { statementTimeoutMs }) {
  const cfg = {
    user: conn.user,
    password: conn.password,
    database: conn.database,
    application_name: 'dbeaver-mcp',
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    // Server-side guards: a runaway query cannot hang the agent forever, and a
    // failed transaction cannot sit holding locks on a live database.
    statement_timeout: statementTimeoutMs,
    lock_timeout: LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout: IDLE_TX_TIMEOUT_MS,
    // Client-side backstop in case the server ignores statement_timeout.
    query_timeout: statementTimeoutMs + 5000,
  }

  const ssl = sslOptions(conn)

  if (conn.ssh) {
    const remotePort = conn.ssh.remotePort || conn.port
    const localPort = await ensureTunnel(conn.ssh, remotePort)
    if (ssl) {
      // Through a tunnel the socket connects to 127.0.0.1, so hostname
      // verification must still be told the real server name.
      ssl.servername = conn.host
    }
    return { ...cfg, host: '127.0.0.1', port: localPort, ssl: ssl || undefined }
  }

  if (ssl) ssl.servername = ssl.servername || conn.host
  return { ...cfg, host: conn.host, port: conn.port, ssl: ssl || undefined }
}

/* ------------------------------------------------------- result shaping */

function truncateString(s) {
  if (Buffer.byteLength(s, 'utf8') <= MAX_CELL_BYTES) return s
  const cut = Buffer.from(s, 'utf8').subarray(0, MAX_CELL_BYTES).toString('utf8')
  return `${cut}… [truncated, ${Buffer.byteLength(s, 'utf8')} bytes]`
}

/**
 * Make a value JSON-safe and bounded.
 * A single bytea column would otherwise serialize as thousands of integers and
 * blow out the agent's context window.
 */
export function capCell(value, depth = 0) {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return truncateString(value)
  if (Buffer.isBuffer(value)) {
    const shown = value.subarray(0, Math.max(16, Math.floor(MAX_CELL_BYTES / 2)))
    return {
      type: 'bytea',
      bytes: value.length,
      preview: `\\x${shown.toString('hex')}`,
      truncated: value.length > shown.length,
    }
  }
  if (value instanceof Date) return value.toISOString()
  if (depth > 6) return '[nested]'
  if (Array.isArray(value)) return value.map((v) => capCell(v, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = capCell(v, depth + 1)
    return out
  }
  return truncateString(String(value))
}

export function newBudget(limit = MAX_TOTAL_BYTES) {
  return { used: 0, limit }
}

export function shapeResult(result, maxRows, budget = newBudget()) {
  const allRows = Array.isArray(result.rows) ? result.rows : []
  const rows = []
  let truncatedBytes = false

  for (const row of allRows) {
    if (rows.length >= maxRows) break
    const capped = capCell(row)
    const size = Buffer.byteLength(JSON.stringify(capped) ?? 'null', 'utf8')
    if (budget.used + size > budget.limit && rows.length > 0) {
      truncatedBytes = true
      break
    }
    budget.used += size
    rows.push(capped)
  }

  return {
    rowCount: result.rowCount ?? allRows.length,
    fields: (result.fields || []).map((f) => f.name),
    rows,
    truncated: allRows.length > rows.length,
    truncatedBytes: truncatedBytes || undefined,
  }
}

async function withClient(conn, statementTimeoutMs, fn) {
  if (conn.supported === false) {
    throw new Error(
      `Connection "${conn.name}" uses driver "${conn.driver}", which is not the Postgres wire protocol. dbeaver-mcp cannot query it.`
    )
  }
  if (!conn.user) throw new Error(`No database user for ${conn.name}`)
  if (!conn.password) {
    throw new Error(
      `No database password for ${conn.name}. Enable "Save password" in DBeaver, or check whether a DBeaver master password is blocking the local credential store.`
    )
  }

  const cfg = await connectTarget(conn, { statementTimeoutMs })
  const client = await connectWithOptionalTls(conn, cfg)
  try {
    return await fn(client)
  } finally {
    await client.end().catch(() => {})
  }
}

/**
 * `allow` and `prefer` mean "encrypt if the server can". node-postgres has no
 * such negotiation — handing it an `ssl` object demands TLS — so a `prefer`
 * connection against a server without TLS failed here while DBeaver and psql
 * connected fine.
 *
 * The retry is deliberately narrow: only for the two optional modes, and only
 * when the server itself says it has no TLS. `require` and the `verify-*` modes
 * never fall back, because there the encryption was the point.
 */
async function connectWithOptionalTls(conn, cfg) {
  const client = new pg.Client(cfg)
  try {
    await client.connect()
    return client
  } catch (err) {
    const optional = ['allow', 'prefer'].includes(String(conn?.sslMode || '').toLowerCase())
    if (!cfg.ssl || !optional || !/does not support SSL/i.test(err?.message || '')) throw err
    await client.end().catch(() => {})
    const plain = new pg.Client({ ...cfg, ssl: undefined })
    await plain.connect()
    return plain
  }
}

/* ----------------------------------------------------------------- query */

/**
 * Run one or more statements on the same connection.
 *
 * Reads run inside `BEGIN TRANSACTION READ ONLY`, so the read-only promise is
 * enforced by Postgres rather than by a regular expression — a SELECT that
 * calls a volatile, data-modifying function fails at the engine.
 */
export async function runQuery(
  conn,
  sql,
  { maxRows = 200, transaction, allowWrites = true, params, timeoutMs, budget } = {}
) {
  const statements = splitStatements(sql)
  if (statements.length === 0) throw new Error('No SQL statements to run')
  if (params && statements.length > 1) {
    throw new Error('Bound parameters require exactly one statement')
  }

  const hijack = statements.find(statementHijacksSession)
  if (hijack) {
    throw new Error(
      `Refusing "${hijack.slice(0, 60)}": this server manages its own transactions and timeouts. ` +
        'A COMMIT or ROLLBACK here would end the transaction the safety guarantees depend on, and ' +
        'leave every following statement running outside it. Send the statements without transaction ' +
        'control and use the transaction option instead.'
    )
  }

  if (!sensitiveReadsAllowed()) {
    for (const statement of statements) {
      const object = describeSensitiveRead(statement)
      if (object) {
        throw new Error(
          `Refusing to read ${object}: it exposes credential material or the server's filesystem. ` +
            'A read-only transaction does not stop this, so it is blocked here. Set ' +
            'DBEAVER_MCP_ALLOW_SENSITIVE_READS=true if you genuinely need it.'
        )
      }
    }
  }

  const writes = statements.filter(statementIsWrite)
  const readOnly = !allowWrites
  if (writes.length && readOnly) {
    throw new Error(
      `Refusing write SQL on a read-only tool (${writes[0].slice(0, 60)}…). Use write_query or run_script.`
    )
  }

  const blocksTx = statements.some(statementBlocksTransaction)
  let useTx
  if (readOnly) {
    useTx = true
  } else if (transaction === true) {
    if (blocksTx) {
      throw new Error(
        'This batch contains a statement Postgres cannot run inside a transaction (VACUUM, CREATE INDEX CONCURRENTLY, ALTER SYSTEM, …). Run it on its own with transaction: false.'
      )
    }
    useTx = true
  } else if (transaction === false) {
    useTx = false
  } else {
    useTx = statements.length > 1 && writes.length > 0 && !blocksTx
  }

  const statementTimeoutMs = timeoutMs && timeoutMs > 0 ? timeoutMs : STATEMENT_TIMEOUT_MS
  const bytes = budget || newBudget()

  return withClient(conn, statementTimeoutMs, async (client) => {
    if (useTx) await client.query(readOnly ? 'BEGIN TRANSACTION READ ONLY' : 'BEGIN')
    const results = []
    try {
      for (const statement of statements) {
        const result = params
          ? await client.query(statement, params)
          : await client.query(statement)
        results.push({ sql: statement, ...shapeResult(result, maxRows, bytes) })
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
      readOnly,
      bytes: bytes.used,
      results,
      rowCount: first.rowCount,
      fields: first.fields,
      rows: first.rows,
      truncated: first.truncated,
      truncatedBytes: first.truncatedBytes,
    }
  })
}

export async function runScript(conn, statements, { maxRows = 200, transaction, timeoutMs } = {}) {
  const list = (Array.isArray(statements) ? statements : [])
    .flatMap((s) => splitStatements(s))
    .filter(Boolean)
  if (list.length === 0) throw new Error('run_script needs at least one statement')
  if (list.length > 50) {
    throw new Error(`run_script allows at most 50 statements (got ${list.length})`)
  }
  return runQuery(conn, list.join(';\n'), { maxRows, transaction, allowWrites: true, timeoutMs })
}

/**
 * Show the planner's plan for a statement.
 *
 * `analyze` genuinely executes the statement, so it is refused for anything
 * that writes — an EXPLAIN ANALYZE of a DELETE deletes.
 */
export async function explainQuery(conn, sql, { analyze = false, verbose = false } = {}) {
  const statements = splitStatements(sql)
  if (statements.length !== 1) throw new Error('explain_query takes exactly one statement')
  const statement = statements[0]

  if (analyze && statementIsWrite(statement)) {
    throw new Error(
      'EXPLAIN ANALYZE executes the statement. Refusing to run it on a write. Use analyze: false for the plan alone.'
    )
  }
  if (statementHijacksSession(statement)) {
    throw new Error('Refusing to explain a transaction-control or session-setting statement.')
  }
  if (!sensitiveReadsAllowed()) {
    const object = describeSensitiveRead(statement)
    if (object) {
      throw new Error(
        `Refusing to explain a statement that reads ${object}. With analyze: true it would execute. ` +
          'Set DBEAVER_MCP_ALLOW_SENSITIVE_READS=true if you genuinely need it.'
      )
    }
  }

  const opts = ['FORMAT JSON']
  if (analyze) opts.push('ANALYZE', 'BUFFERS')
  if (verbose) opts.push('VERBOSE')

  return withClient(conn, STATEMENT_TIMEOUT_MS, async (client) => {
    const readOnly = !statementIsWrite(statement)
    await client.query(readOnly ? 'BEGIN TRANSACTION READ ONLY' : 'BEGIN')
    try {
      const result = await client.query(`EXPLAIN (${opts.join(', ')}) ${statement}`)
      // An ANALYZE of a write is already refused above; roll back regardless so
      // nothing a plan touched can persist.
      await client.query('ROLLBACK')
      const plan = result.rows?.[0]?.['QUERY PLAN'] ?? result.rows
      return { sql: statement, analyzed: analyze, plan }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    }
  })
}

/**
 * Reset sequences that have fallen behind their table — the state a dump or a
 * manual INSERT with explicit ids leaves behind, which then throws duplicate
 * key errors on the next insert.
 */
export async function fixSequences(conn, { schema, table, dryRun = true } = {}) {
  const report = await inspectSequences(conn, { schema, table })
  const behind = report.rows.filter((r) => r.needs_reset)

  const plan = behind.map((r) => {
    // The target must be interpolated as exact digits. Number() would round
    // anything past 2^53, and setval to a rounded value reintroduces exactly
    // the duplicate-key failures this tool exists to fix.
    const target = toBigIntOrNull(r.max_value)
    if (target === null) {
      throw new Error(
        `Sequence ${r.schema}.${r.sequence}: MAX(${r.column}) is "${r.max_value}", which is not an integer. Refusing to guess a setval target.`
      )
    }
    // The regclass argument is a string literal, so the identifier quoting goes
    // inside it and the whole thing still needs literal escaping.
    const ref = quoteLiteral(`${quoteIdent(r.schema)}.${quoteIdent(r.sequence)}`)
    return {
      sequence: `${r.schema}.${r.sequence}`,
      table: `${r.schema}.${r.table}`,
      column: r.column,
      from: r.last_value,
      to: r.max_value,
      sql: `SELECT setval(${ref}::regclass, ${target}, true)`,
    }
  })

  if (dryRun || plan.length === 0) {
    return { schema: report.schema, dryRun: true, wouldFix: plan.length, plan, applied: [] }
  }

  const applied = await withClient(conn, STATEMENT_TIMEOUT_MS, async (client) => {
    await client.query('BEGIN')
    try {
      const done = []
      for (const step of plan) {
        const res = await client.query(step.sql)
        done.push({ ...step, newValue: res.rows?.[0]?.setval ?? null })
      }
      await client.query('COMMIT')
      return done
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    }
  })

  return { schema: report.schema, dryRun: false, fixed: applied.length, plan, applied }
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

  return withClient(conn, STATEMENT_TIMEOUT_MS, async (client) => {
    await client.query('BEGIN TRANSACTION READ ONLY')
    try {
      const found = await client.query(owned, params)
      const rows = []
      for (const row of found.rows) {
        const maxSql = `SELECT MAX(${quoteIdent(row.column)})::text AS max_value FROM ${quoteIdent(
          row.schema
        )}.${quoteIdent(row.table)}`
        const maxRes = await client.query(maxSql)
        const maxValue = maxRes.rows[0]?.max_value ?? null
        // Compared as BigInt: these are bigint columns, and Number() rounds
        // past 2^53, which can make a sequence that is behind look fine.
        const last = toBigIntOrNull(row.last_value)
        const max = toBigIntOrNull(maxValue)
        const needsReset = max !== null && (last === null || last < max)
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
      await client.query('COMMIT')
      return {
        schema: sch,
        table: table || null,
        rowCount: rows.length,
        fields: [
          'schema',
          'table',
          'column',
          'sequence',
          'last_value',
          'max_value',
          'needs_reset',
        ],
        rows,
        truncated: false,
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    }
  })
}
