import { splitStatements, statementIsWrite } from './query.js'

/**
 * Operator-facing guard rails, all driven by environment variables so they can
 * be set once in the MCP host config and not depend on the agent behaving.
 *
 *   DBEAVER_MCP_READ_ONLY=true              whole server refuses to mutate
 *   DBEAVER_MCP_ALLOWED_CONNECTIONS=a,b     only these are reachable at all
 *   DBEAVER_MCP_WRITABLE_CONNECTIONS=a      only these accept writes
 *   DBEAVER_MCP_DISABLED_TOOLS=write_query  tools removed from the surface
 *
 * Names match against connection name or id, case-insensitively, with `*` and
 * `?` wildcards.
 */

export const WRITE_TOOLS = ['write_query', 'run_script', 'fix_sequences']

function parseList(raw) {
  if (raw === undefined || raw === null) return null
  const items = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return items.length ? items : null
}

function truthy(raw) {
  return ['true', '1', 'yes', 'on'].includes(String(raw ?? '').trim().toLowerCase())
}

export function matchesPattern(pattern, value) {
  const p = String(pattern).toLowerCase()
  const v = String(value ?? '').toLowerCase()
  if (!p.includes('*') && !p.includes('?')) return p === v
  const rx = new RegExp(
    `^${p
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`
  )
  return rx.test(v)
}

export function loadPolicy(env = process.env) {
  return {
    readOnly: truthy(env.DBEAVER_MCP_READ_ONLY),
    allowed: parseList(env.DBEAVER_MCP_ALLOWED_CONNECTIONS),
    writable: parseList(env.DBEAVER_MCP_WRITABLE_CONNECTIONS),
    disabledTools: new Set(
      (parseList(env.DBEAVER_MCP_DISABLED_TOOLS) || []).map((s) => s.toLowerCase())
    ),
  }
}

function listed(patterns, conn) {
  return patterns.some((p) => matchesPattern(p, conn.name) || matchesPattern(p, conn.id))
}

/** Is this connection visible/usable at all? */
export function connectionAllowed(policy, conn) {
  if (!policy.allowed) return true
  return listed(policy.allowed, conn)
}

/**
 * May this connection be written to?
 *
 * A separate list from `allowed` on purpose: the common shape is "read
 * everything, write only to dev" — omnisql's single flat whitelist cannot
 * express that.
 */
export function connectionWritable(policy, conn) {
  if (policy.readOnly) return false
  if (!connectionAllowed(policy, conn)) return false
  if (!policy.writable) return true
  return listed(policy.writable, conn)
}

export function assertConnectionAllowed(policy, conn) {
  if (connectionAllowed(policy, conn)) return
  throw new Error(
    `Connection "${conn.name}" is not in DBEAVER_MCP_ALLOWED_CONNECTIONS. This server is restricted to: ${policy.allowed.join(', ')}`
  )
}

export function assertConnectionWritable(policy, conn) {
  if (connectionWritable(policy, conn)) return
  if (policy.readOnly) {
    throw new Error(
      'This server runs in read-only mode (DBEAVER_MCP_READ_ONLY=true). No statement may modify data.'
    )
  }
  throw new Error(
    `Connection "${conn.name}" is read-only here. DBEAVER_MCP_WRITABLE_CONNECTIONS allows writes to: ${(policy.writable || []).join(', ')}`
  )
}

export function toolEnabled(policy, name) {
  if (policy.disabledTools.has(String(name).toLowerCase())) return false
  if (policy.readOnly && WRITE_TOOLS.includes(name)) return false
  return true
}

/* ------------------------------------------------- destructive statements */

const DROP_DATABASE = /^\s*drop\s+(database|tablespace)\b/i
const DROP_OBJECT = /^\s*drop\s+(table|schema|role|user|index|view|materialized\s+view)\b/i
const TRUNCATE = /^\s*truncate\b/i
const ALTER_SYSTEM = /^\s*alter\s+system\b/i
const DELETE_FROM = /^\s*delete\s+from\b/i
const UPDATE_SET = /^\s*update\b/i

/**
 * Strip string and dollar-quoted literals so a `WHERE` inside a value cannot
 * be mistaken for a real predicate.
 */
function stripLiterals(sql) {
  return String(sql)
    .replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, "''")
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
}

/**
 * Why this single statement is dangerous, or null.
 * Operates per statement — a `;`-separated batch is checked one at a time, so
 * a destructive statement cannot hide behind a harmless leading one.
 */
export function describeDestructive(sql) {
  const bare = stripLiterals(sql).trim()
  if (!bare) return null

  if (DROP_DATABASE.test(bare)) return 'drops an entire database or tablespace'
  if (TRUNCATE.test(bare)) return 'truncates a table (not logged, not recoverable by rollback of DML)'
  if (ALTER_SYSTEM.test(bare)) return 'changes server-wide configuration'
  if (DROP_OBJECT.test(bare)) {
    const what = bare.match(DROP_OBJECT)[1].toLowerCase()
    return `drops a ${what}`
  }
  if (DELETE_FROM.test(bare) && !/\bwhere\b/i.test(bare)) {
    return 'deletes every row in the table (no WHERE clause)'
  }
  if (UPDATE_SET.test(bare) && !/\bwhere\b/i.test(bare)) {
    return 'rewrites every row in the table (no WHERE clause)'
  }
  return null
}

/** All destructive statements in a batch. */
export function findDestructive(sql) {
  const out = []
  for (const statement of splitStatements(sql)) {
    const reason = describeDestructive(statement)
    if (reason) out.push({ sql: statement, reason })
  }
  return out
}

export function hasWrites(sql) {
  return splitStatements(sql).some(statementIsWrite)
}

/**
 * Destructive statements need an explicit `confirm: true`.
 *
 * Deliberately a confirmation rather than a hard block: a flat refusal teaches
 * an agent to rephrase the query until it slips past, which is strictly worse
 * than making it say out loud what it is about to do.
 */
export function assertDestructiveConfirmed(sql, confirm) {
  const found = findDestructive(sql)
  if (found.length === 0 || confirm === true) return found
  const lines = found.map((f) => `  - ${f.reason}: ${f.sql.slice(0, 120)}`).join('\n')
  throw new Error(
    `This would be destructive and needs confirm: true.\n${lines}\n` +
      'Back up first, show the user exactly what will run, and re-send with confirm: true.'
  )
}
