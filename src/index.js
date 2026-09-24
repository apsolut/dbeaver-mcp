#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { closeTunnels, closeTunnelsSync, probeHostKey } from './tunnel.js'
import { loadConnectionsDetailed, publicConnection, resolveConnection } from './dbeaver.js'
import {
  explainQuery,
  fixSequences,
  inspectSequences,
  isWriteSql,
  newBudget,
  runQuery,
  runScript,
} from './query.js'
import {
  assertConnectionAllowed,
  assertConnectionWritable,
  assertDestructiveConfirmed,
  connectionAllowed,
  connectionWritable,
  loadPolicy,
  toolEnabled,
} from './policy.js'
import {
  decideHostKey,
  fingerprint,
  keyTypeFromBlob,
  knownHostsPaths,
  readKnownHosts,
  rememberHostKey,
} from './knownhosts.js'
import {
  backupBannerText,
  backupNotice,
  isFirstRun,
  markBackupSeen,
  printStartupBanner,
} from './banner.js'

function json(data, preamble) {
  const parts = []
  if (preamble) parts.push({ type: 'text', text: preamble })
  parts.push({ type: 'text', text: JSON.stringify(data, null, 2) })
  return { content: parts }
}

let wroteThisProcess = false

function consumeBackupBanner({ full = false } = {}) {
  const first = isFirstRun()
  const show = first || !wroteThisProcess
  if (first) markBackupSeen()
  wroteThisProcess = true
  if (!show) return undefined
  return backupBannerText({ full: full || first })
}

function fail(message) {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/**
 * Resolve a connection name to a connection.
 * `fuzzy: false` for anything that mutates — substring matching must never be
 * able to steer a write at the wrong database.
 */
const POLICY = loadPolicy()

function resolve(nameOrId, { fuzzy = true, write = false } = {}) {
  const { connections } = loadConnectionsDetailed()
  // A connection excluded by policy should not even be resolvable by name —
  // otherwise the error message itself confirms it exists.
  const visible = connections.filter((c) => connectionAllowed(POLICY, c))
  const conn = resolveConnection(visible, nameOrId, { fuzzy })
  if (conn.supported === false) {
    throw new Error(
      `Connection "${conn.name}" uses driver "${conn.driver}". dbeaver-mcp only speaks the Postgres wire protocol.`
    )
  }
  assertConnectionAllowed(POLICY, conn)
  if (write) assertConnectionWritable(POLICY, conn)
  return conn
}

function policySummary() {
  const bits = {}
  if (POLICY.readOnly) bits.readOnly = true
  if (POLICY.allowed) bits.allowedConnections = POLICY.allowed
  if (POLICY.writable) bits.writableConnections = POLICY.writable
  if (POLICY.disabledTools.size) bits.disabledTools = [...POLICY.disabledTools]
  return Object.keys(bits).length ? bits : undefined
}

const timeoutArg = z
  .number()
  .int()
  .min(1000)
  .max(600000)
  .optional()
  .describe('Statement timeout in ms (default 30000)')

function createServer() {
  const server = new McpServer({ name: 'dbeaver-mcp', version: '1.6.0' })

  // A tool disabled by policy is never registered, so the agent cannot see it
  // and cannot be talked into trying.
  const tool = (name, desc, schema, handler) => {
    if (!toolEnabled(POLICY, name)) return
    server.tool(name, desc, schema, handler)
  }

  tool(
    'list_connections',
    'List DBeaver Community connections (names, hosts, SSH hop). Passwords are never returned.',
    {},
    async () => {
      try {
        const first = isFirstRun()
        const { connections, warnings, workspace } = loadConnectionsDetailed()
        if (first) markBackupSeen()
        const visible = connections.filter((c) => connectionAllowed(POLICY, c))
        const payload = {
          workspace,
          connections: visible.map((c) => ({
            ...publicConnection(c),
            writable: connectionWritable(POLICY, c),
          })),
        }
        const hidden = connections.length - visible.length
        if (hidden > 0) payload.hiddenByPolicy = hidden
        const policy = policySummary()
        if (policy) payload.policy = policy
        if (warnings.length) payload.warnings = warnings
        if (first) payload.notice = backupNotice({ full: true })
        return json(payload, first ? backupBannerText({ full: true }) : undefined)
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  tool(
    'test_connection',
    'Open the DBeaver connection (starts a verified SSH tunnel if needed) and run SELECT 1.',
    { name: z.string().describe('Connection name or id') },
    async ({ name }) => {
      try {
        const conn = resolve(name)
        const result = await runQuery(
          conn,
          'SELECT 1 AS ok, current_database() AS db, current_user AS user, version() AS version',
          { allowWrites: false }
        )
        return json({ ok: true, connection: publicConnection(conn), result })
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  tool(
    'execute_query',
    'Run read-only SQL inside a READ ONLY transaction. Multiple SELECTs return every result set (not only the last). SSH tunnels open automatically.',
    {
      name: z.string().describe('Connection name or id, e.g. "PSN LIVE"'),
      query: z.string().describe('SELECT / WITH / EXPLAIN / SHOW. Multiple statements allowed.'),
      maxRows: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe('Row cap per statement (default 200)'),
      timeoutMs: timeoutArg,
    },
    async ({ name, query, maxRows, timeoutMs }) => {
      try {
        if (isWriteSql(query)) {
          return fail('Refusing write SQL on execute_query. Use write_query or run_script.')
        }
        const conn = resolve(name)
        const result = await runQuery(conn, query, {
          maxRows: maxRows ?? 200,
          allowWrites: false,
          timeoutMs,
          budget: newBudget(),
        })
        return json({ connection: conn.name, ...result })
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  tool(
    'write_query',
    'Run INSERT/UPDATE/DELETE/DDL. Requires an exact connection name or id. Several statements in one string run on one connection; more than one write is wrapped in a transaction.',
    {
      name: z.string().describe('Exact connection name or id (no partial matching for writes)'),
      query: z.string().describe('Mutating SQL (one or more statements)'),
      confirm: z
        .boolean()
        .optional()
        .describe(
          'Required (true) for destructive statements: DROP, TRUNCATE, ALTER SYSTEM, or DELETE/UPDATE without WHERE'
        ),
      timeoutMs: timeoutArg,
    },
    async ({ name, query, confirm, timeoutMs }) => {
      try {
        const conn = resolve(name, { fuzzy: false, write: true })
        assertDestructiveConfirmed(query, confirm)
        const result = await runQuery(conn, query, {
          maxRows: 50,
          allowWrites: true,
          timeoutMs,
          budget: newBudget(),
        })
        const banner = consumeBackupBanner({ full: true })
        return json(
          {
            connection: conn.name,
            ...result,
            notice: banner ? backupNotice({ full: true }) : undefined,
          },
          banner
        )
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  tool(
    'run_script',
    'Run several SQL statements on one connection. Requires an exact connection name or id. Defaults to a transaction when any statement writes.',
    {
      name: z.string().describe('Exact connection name or id (no partial matching for writes)'),
      statements: z
        .array(z.string().min(1))
        .min(1)
        .max(50)
        .optional()
        .describe('SQL statements in order'),
      script: z.string().optional().describe('SQL script; split on top-level semicolons'),
      transaction: z
        .boolean()
        .optional()
        .describe('Force a transaction (default: on when any statement writes and there are 2+)'),
      maxRows: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe('Row cap per statement (default 200)'),
      confirm: z
        .boolean()
        .optional()
        .describe('Required (true) if any statement is destructive'),
      timeoutMs: timeoutArg,
    },
    async ({ name, statements, script, transaction, maxRows, confirm, timeoutMs }) => {
      try {
        const list = [...(statements || [])]
        if (script) list.push(script)
        if (list.length === 0) return fail('Provide statements[] and/or script')
        const conn = resolve(name, { fuzzy: false, write: true })
        assertDestructiveConfirmed(list.join(';\n'), confirm)
        const result = await runScript(conn, list, {
          maxRows: maxRows ?? 200,
          transaction,
          timeoutMs,
        })
        const banner = consumeBackupBanner({ full: true })
        return json(
          {
            connection: conn.name,
            ...result,
            notice: banner ? backupNotice({ full: true }) : undefined,
          },
          banner
        )
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  tool(
    'inspect_sequences',
    'Compare serial/identity sequences to MAX(column). needs_reset is true when the table is ahead of the sequence (typical after a dump or manual INSERT).',
    {
      name: z.string().describe('Connection name or id'),
      schema: z.string().optional().describe('Schema (default: connection schema or public)'),
      table: z.string().optional().describe('Only this table'),
    },
    async ({ name, schema, table }) => {
      try {
        const conn = resolve(name)
        const result = await inspectSequences(conn, { schema, table })
        return json({ connection: conn.name, ...result })
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  tool(
    'explain_query',
    'Show the Postgres query plan for one statement. analyze: true runs it for real timings and is refused on anything that writes.',
    {
      name: z.string().describe('Connection name or id'),
      query: z.string().describe('A single statement'),
      analyze: z
        .boolean()
        .optional()
        .describe('Execute the statement to get real timings (reads only)'),
      verbose: z.boolean().optional().describe('Include VERBOSE output'),
    },
    async ({ name, query, analyze, verbose }) => {
      try {
        const conn = resolve(name)
        const result = await explainQuery(conn, query, { analyze, verbose })
        return json({ connection: conn.name, ...result })
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  tool(
    'fix_sequences',
    'Reset serial/identity sequences that have fallen behind MAX(column) — the duplicate-key state a dump leaves behind. Defaults to a dry run; pass apply: true to write.',
    {
      name: z.string().describe('Connection name or id (exact when apply: true)'),
      schema: z.string().optional().describe('Schema (default: connection schema or public)'),
      table: z.string().optional().describe('Only this table'),
      apply: z.boolean().optional().describe('Actually run setval (default false = dry run)'),
    },
    async ({ name, schema, table, apply }) => {
      try {
        const conn = resolve(name, { fuzzy: !apply, write: Boolean(apply) })
        const result = await fixSequences(conn, { schema, table, dryRun: !apply })
        const banner = apply ? consumeBackupBanner({ full: true }) : undefined
        return json({ connection: conn.name, ...result }, banner)
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  tool(
    'trust_ssh_host',
    'Show the SSH host key fingerprint for a tunnelled connection, and record it in known_hosts only when the user confirms that exact fingerprint. Use this when a tunnel fails with "Unknown SSH host key".',
    {
      name: z.string().describe('Connection name or id'),
      confirmFingerprint: z
        .string()
        .optional()
        .describe(
          'Echo back the SHA256:… fingerprint to record it. Show it to the user and get their agreement first — do not copy it from the previous response on your own.'
        ),
    },
    async ({ name, confirmFingerprint }) => {
      try {
        const conn = resolve(name)
        if (!conn.ssh) return fail(`Connection "${conn.name}" does not use an SSH tunnel.`)

        const keyBlob = await probeHostKey(conn.ssh)
        if (!keyBlob) return fail(`No host key offered by ${conn.ssh.host}`)

        const fp = fingerprint(keyBlob)
        const keyType = keyTypeFromBlob(keyBlob)
        const paths = knownHostsPaths()
        const { entries } = readKnownHosts(paths)
        const decision = decideHostKey({
          entries,
          host: conn.ssh.host,
          port: conn.ssh.port || 22,
          keyBlob,
          policy: 'strict',
        })

        if (decision.ok) {
          return json({
            host: conn.ssh.host,
            port: conn.ssh.port || 22,
            fingerprint: fp,
            keyType,
            status: 'already-trusted',
            message: 'This host key is already in known_hosts. Nothing to do.',
          })
        }

        // A key that differs from a recorded one is never a "confirm to
        // proceed" case — it is the attack this check exists for.
        if (/mismatch/i.test(decision.reason || '')) {
          return fail(decision.reason)
        }

        if (!confirmFingerprint) {
          return json({
            host: conn.ssh.host,
            port: conn.ssh.port || 22,
            fingerprint: fp,
            keyType,
            status: 'awaiting-confirmation',
            howToVerify: `Ask the server's operator, or run: ssh-keygen -lf <(ssh-keyscan -p ${
              conn.ssh.port || 22
            } ${conn.ssh.host} 2>/dev/null)`,
            next: 'Show this fingerprint to the user. If they confirm it matches, call trust_ssh_host again with confirmFingerprint set to exactly this value.',
          })
        }

        if (confirmFingerprint.trim() !== fp) {
          return fail(
            `Fingerprint mismatch. The host presented ${fp} but you confirmed ${confirmFingerprint.trim()}. Nothing was recorded.`
          )
        }

        const written = rememberHostKey(conn.ssh.host, conn.ssh.port || 22, keyBlob, paths)
        return json({
          host: conn.ssh.host,
          port: conn.ssh.port || 22,
          fingerprint: fp,
          keyType,
          status: 'trusted',
          knownHostsFile: written,
          message: 'Host key recorded. The tunnel will open from now on.',
        })
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  tool(
    'list_schemas',
    'List non-system schemas on a DBeaver connection.',
    { name: z.string().describe('Connection name or id') },
    async ({ name }) => {
      try {
        const conn = resolve(name)
        const result = await runQuery(
          conn,
          `SELECT schema_name
           FROM information_schema.schemata
           WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
           ORDER BY schema_name`,
          { maxRows: 500, allowWrites: false }
        )
        return json({ connection: conn.name, ...result })
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  tool(
    'list_tables',
    'List tables in a schema for a DBeaver connection.',
    {
      name: z.string().describe('Connection name or id'),
      schema: z.string().optional().describe('Schema name (default: connection schema or public)'),
    },
    async ({ name, schema }) => {
      try {
        const conn = resolve(name)
        const sch = schema || conn.schema || 'public'
        const result = await runQuery(
          conn,
          `SELECT table_schema, table_name, table_type
           FROM information_schema.tables
           WHERE table_schema = $1
           ORDER BY table_name`,
          { maxRows: 1000, allowWrites: false, params: [sch] }
        )
        return json({ connection: conn.name, schema: sch, ...result })
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  tool(
    'describe_table',
    'Describe columns of a table on a DBeaver connection.',
    {
      name: z.string().describe('Connection name or id'),
      table: z.string().describe('Table name'),
      schema: z.string().optional().describe('Schema name (default public)'),
    },
    async ({ name, table, schema }) => {
      try {
        const conn = resolve(name)
        const sch = schema || conn.schema || 'public'
        const result = await runQuery(
          conn,
          `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
           WHERE table_schema = $1
             AND table_name = $2
           ORDER BY ordinal_position`,
          { allowWrites: false, params: [sch, table] }
        )
        return json({ connection: conn.name, schema: sch, table, ...result })
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  return server
}

async function runCli(argv) {
  printStartupBanner()
  const [cmd, ...rest] = argv

  if (!cmd || cmd === 'list') {
    const { connections, warnings, workspace } = loadConnectionsDetailed()
    console.log(
      JSON.stringify(
        { workspace, connections: connections.map(publicConnection), warnings },
        null,
        2
      )
    )
    return
  }
  if (cmd === 'test') {
    const { connections } = loadConnectionsDetailed()
    const name = rest[0] || connections.find((c) => c.supported)?.name
    if (!name) throw new Error('No DBeaver connections found')
    const conn = resolve(name)
    const result = await runQuery(
      conn,
      'SELECT 1 AS ok, current_database() AS db, version() AS version',
      { allowWrites: false }
    )
    console.log(JSON.stringify({ ok: true, connection: publicConnection(conn), result }, null, 2))
    return
  }
  if (cmd === 'query') {
    const name = rest[0]
    const sql = rest.slice(1).join(' ')
    if (!name || !sql) {
      console.error('Usage: dbeaver-mcp --cli query "<connection>" "SELECT 1"')
      process.exit(1)
    }
    const conn = resolve(name)
    const result = await runQuery(conn, sql, { allowWrites: false })
    console.log(JSON.stringify({ connection: conn.name, ...result }, null, 2))
    return
  }
  if (cmd === 'sequences') {
    const name = rest[0]
    if (!name) {
      console.error('Usage: dbeaver-mcp --cli sequences "<connection>" [schema] [table]')
      process.exit(1)
    }
    const conn = resolve(name)
    const result = await inspectSequences(conn, { schema: rest[1], table: rest[2] })
    console.log(JSON.stringify({ connection: conn.name, ...result }, null, 2))
    return
  }
  console.error(
    'Usage: dbeaver-mcp --cli [list|test <name>|query <name> <sql>|sequences <name> [schema] [table]]'
  )
  process.exit(1)
}

/* ------------------------------------------------------------- shutdown */

let shuttingDown = false

async function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  try {
    await closeTunnels()
  } catch {
    /* ignore */
  }
  process.exit(code)
}

/**
 * MCP hosts stop a stdio server in whichever way their platform prefers:
 * SIGTERM on Linux/macOS, SIGBREAK or a plain stdin close on Windows. Handling
 * only SIGINT leaks SSH tunnels and database sockets on every exit.
 */
function installShutdownHooks() {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try {
      process.on(sig, () => {
        shutdown(0)
      })
    } catch {
      // Signal not supported on this platform (SIGBREAK off Windows).
    }
  }
  process.stdin.on('end', () => shutdown(0))
  process.stdin.on('close', () => shutdown(0))
  process.on('exit', () => closeTunnelsSync())
  process.on('uncaughtException', (err) => {
    console.error(err)
    shutdown(1)
  })
  process.on('unhandledRejection', (err) => {
    console.error(err)
  })
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv[0] === '--cli') {
    try {
      await runCli(argv.slice(1))
    } finally {
      await closeTunnels()
    }
    return
  }

  printStartupBanner()
  installShutdownHooks()
  const server = createServer()
  const transport = new StdioServerTransport()
  transport.onclose = () => shutdown(0)
  await server.connect(transport)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
