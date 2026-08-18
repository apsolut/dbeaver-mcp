#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { closeTunnels } from './tunnel.js'
import { findConnection, loadConnections, publicConnection } from './dbeaver.js'
import { isWriteSql, runQuery } from './query.js'

function json(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

function fail(message) {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function resolve(nameOrId) {
  const list = loadConnections()
  const conn = findConnection(list, nameOrId)
  if (!conn) {
    const names = list.map((c) => c.name).join(', ')
    throw new Error(`Unknown connection "${nameOrId}". Known: ${names}`)
  }
  return conn
}

function createServer() {
  const server = new McpServer({ name: 'dbeaver-mcp', version: '1.2.0' })

  server.tool(
    'list_connections',
    'List DBeaver Community connections (names, hosts, SSH hop). Passwords are never returned.',
    {},
    async () => json(loadConnections().map(publicConnection))
  )

  server.tool(
    'test_connection',
    'Open the DBeaver connection (starts SSH tunnel if needed) and run SELECT 1.',
    { name: z.string().describe('Connection name or id') },
    async ({ name }) => {
      try {
        const conn = resolve(name)
        const result = await runQuery(
          conn,
          'SELECT 1 AS ok, current_database() AS db, current_user AS user'
        )
        return json({ ok: true, connection: publicConnection(conn), result })
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  server.tool(
    'execute_query',
    'Run a read-only SQL query on a DBeaver connection. SSH tunnels are opened automatically.',
    {
      name: z.string().describe('Connection name or id'),
      query: z.string().describe('SELECT / WITH / EXPLAIN / SHOW only'),
      maxRows: z.number().int().min(1).max(2000).optional().describe('Row cap (default 200)'),
    },
    async ({ name, query, maxRows }) => {
      try {
        if (isWriteSql(query)) {
          return fail('Refusing write SQL on execute_query. Use write_query.')
        }
        const conn = resolve(name)
        const result = await runQuery(conn, query, { maxRows: maxRows ?? 200 })
        return json({ connection: conn.name, ...result })
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  server.tool(
    'write_query',
    'Run INSERT/UPDATE/DELETE/DDL on a DBeaver connection. Prefer execute_query for reads.',
    {
      name: z.string().describe('Connection name or id'),
      query: z.string().describe('Mutating SQL'),
    },
    async ({ name, query }) => {
      try {
        const conn = resolve(name)
        const result = await runQuery(conn, query, { maxRows: 50 })
        return json({ connection: conn.name, ...result })
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  server.tool(
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
          { maxRows: 500 }
        )
        return json({ connection: conn.name, ...result })
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  server.tool(
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
           WHERE table_schema = '${sch.replace(/'/g, "''")}'
           ORDER BY table_name`,
          { maxRows: 1000 }
        )
        return json({ connection: conn.name, schema: sch, ...result })
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  server.tool(
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
           WHERE table_schema = '${sch.replace(/'/g, "''")}'
             AND table_name = '${table.replace(/'/g, "''")}'
           ORDER BY ordinal_position`
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
  const [cmd, ...rest] = argv
  if (!cmd || cmd === 'list') {
    console.log(JSON.stringify(loadConnections().map(publicConnection), null, 2))
    return
  }
  if (cmd === 'test') {
    const list = loadConnections()
    const name = rest[0] || list[0]?.name
    if (!name) throw new Error('No DBeaver connections found')
    const conn = resolve(name)
    const result = await runQuery(
      conn,
      'SELECT 1 AS ok, current_database() AS db, inet_server_addr()::text AS addr'
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
    const result = await runQuery(conn, sql)
    console.log(JSON.stringify({ connection: conn.name, ...result }, null, 2))
    return
  }
  console.error('Usage: dbeaver-mcp --cli [list|test <name>|query <name> <sql>]')
  process.exit(1)
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

  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.on('SIGINT', async () => {
    await closeTunnels()
    process.exit(0)
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
