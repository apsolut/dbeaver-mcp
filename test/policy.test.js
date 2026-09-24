import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assertDestructiveConfirmed,
  connectionAllowed,
  connectionWritable,
  describeDestructive,
  findDestructive,
  loadPolicy,
  matchesPattern,
  toolEnabled,
} from '../src/policy.js'

const dev = { id: 'c1', name: 'app-dev' }
const prod = { id: 'c2', name: 'app-prod' }
const other = { id: 'c3', name: 'billing' }

describe('policy parsing', () => {
  it('is wide open by default', () => {
    const p = loadPolicy({})
    assert.equal(p.readOnly, false)
    assert.equal(p.allowed, null)
    assert.equal(connectionAllowed(p, prod), true)
    assert.equal(connectionWritable(p, prod), true)
  })

  it('matches names and ids with wildcards', () => {
    assert.equal(matchesPattern('app-*', 'app-prod'), true)
    assert.equal(matchesPattern('app-*', 'billing'), false)
    assert.equal(matchesPattern('APP-DEV', 'app-dev'), true)
    assert.equal(matchesPattern('c?', 'c1'), true)
  })

  it('hides connections outside the allow list', () => {
    const p = loadPolicy({ DBEAVER_MCP_ALLOWED_CONNECTIONS: 'app-*' })
    assert.equal(connectionAllowed(p, dev), true)
    assert.equal(connectionAllowed(p, other), false)
  })

  it('separates readable from writable', () => {
    const p = loadPolicy({
      DBEAVER_MCP_ALLOWED_CONNECTIONS: 'app-*',
      DBEAVER_MCP_WRITABLE_CONNECTIONS: 'app-dev',
    })
    assert.equal(connectionAllowed(p, prod), true)
    assert.equal(connectionWritable(p, prod), false, 'prod is readable but not writable')
    assert.equal(connectionWritable(p, dev), true)
  })

  it('read-only mode blocks every write', () => {
    const p = loadPolicy({ DBEAVER_MCP_READ_ONLY: 'true' })
    assert.equal(connectionWritable(p, dev), false)
    assert.equal(toolEnabled(p, 'write_query'), false)
    assert.equal(toolEnabled(p, 'run_script'), false)
    assert.equal(toolEnabled(p, 'fix_sequences'), false)
    assert.equal(toolEnabled(p, 'execute_query'), true)
  })

  it('disables named tools', () => {
    const p = loadPolicy({ DBEAVER_MCP_DISABLED_TOOLS: 'write_query, describe_table' })
    assert.equal(toolEnabled(p, 'write_query'), false)
    assert.equal(toolEnabled(p, 'describe_table'), false)
    assert.equal(toolEnabled(p, 'run_script'), true)
  })

  it('a connection outside the allow list is never writable', () => {
    const p = loadPolicy({
      DBEAVER_MCP_ALLOWED_CONNECTIONS: 'app-*',
      DBEAVER_MCP_WRITABLE_CONNECTIONS: 'billing',
    })
    assert.equal(connectionWritable(p, other), false)
  })
})

describe('destructive statement detection', () => {
  it('flags the obvious ones', () => {
    assert.match(describeDestructive('DROP DATABASE prod'), /entire database/)
    assert.match(describeDestructive('TRUNCATE users'), /truncates/)
    assert.match(describeDestructive('ALTER SYSTEM SET work_mem = 64'), /server-wide/)
    assert.match(describeDestructive('DROP TABLE users'), /drops a table/)
  })

  it('flags unbounded DELETE and UPDATE', () => {
    assert.match(describeDestructive('DELETE FROM users'), /every row/)
    assert.match(describeDestructive('UPDATE users SET active = false'), /every row/)
  })

  it('allows bounded DELETE and UPDATE', () => {
    assert.equal(describeDestructive('DELETE FROM users WHERE id = 1'), null)
    assert.equal(describeDestructive('UPDATE users SET a = 1 WHERE id = 2'), null)
    assert.equal(describeDestructive('INSERT INTO users VALUES (1)'), null)
    assert.equal(describeDestructive('SELECT 1'), null)
  })

  it('is not fooled by the word WHERE inside a string literal', () => {
    assert.match(
      describeDestructive("UPDATE posts SET body = 'go where you like'"),
      /every row/,
      'literal WHERE must not count as a predicate'
    )
  })

  it('checks each statement of a batch, not the blob', () => {
    const found = findDestructive("SELECT 1; DELETE FROM users; UPDATE t SET a=1 WHERE id=2")
    assert.equal(found.length, 1)
    assert.match(found[0].sql, /DELETE FROM users/)
  })

  it('requires confirm, then allows it through', () => {
    assert.throws(() => assertDestructiveConfirmed('TRUNCATE users'), /confirm: true/)
    assert.doesNotThrow(() => assertDestructiveConfirmed('TRUNCATE users', true))
    assert.doesNotThrow(() => assertDestructiveConfirmed('DELETE FROM t WHERE id = 1'))
  })

  it('names every destructive statement in the error', () => {
    try {
      assertDestructiveConfirmed('DROP TABLE a; TRUNCATE b')
      assert.fail('should have thrown')
    } catch (err) {
      assert.match(err.message, /drops a table/)
      assert.match(err.message, /truncates/)
    }
  })
})
