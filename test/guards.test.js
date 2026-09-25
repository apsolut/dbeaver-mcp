import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  describeSensitiveRead,
  quoteLiteral,
  sensitiveReadsAllowed,
  statementHijacksSession,
  stripQuoted,
  toBigIntOrNull,
} from '../src/query.js'

describe('statementHijacksSession', () => {
  it('catches the statements that would end our read-only transaction', () => {
    // This is the whole point: reads run inside BEGIN TRANSACTION READ ONLY, so
    // a COMMIT hands the rest of the batch an unprotected session.
    for (const sql of ['COMMIT', 'commit;', 'ROLLBACK', 'END', 'ABORT', 'BEGIN', 'START TRANSACTION']) {
      assert.equal(statementHijacksSession(sql), true, sql)
    }
  })

  it('catches SET TRANSACTION READ WRITE, which Postgres accepts before the first query', () => {
    assert.equal(statementHijacksSession('SET TRANSACTION READ WRITE'), true)
    assert.equal(statementHijacksSession('SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE'), true)
  })

  it('catches attempts to disarm the timeouts or change identity', () => {
    assert.equal(statementHijacksSession('SET statement_timeout = 0'), true)
    assert.equal(statementHijacksSession('SET LOCAL lock_timeout = 0'), true)
    assert.equal(statementHijacksSession('RESET ALL'), true)
    assert.equal(statementHijacksSession('SET ROLE postgres'), true)
    assert.equal(statementHijacksSession('SET SESSION AUTHORIZATION postgres'), true)
    assert.equal(statementHijacksSession('SET session_replication_role = replica'), true)
  })

  it('sees through a leading comment', () => {
    assert.equal(statementHijacksSession('-- harmless\nCOMMIT'), true)
    assert.equal(statementHijacksSession('/* nothing to see */ ROLLBACK'), true)
  })

  it('leaves ordinary SQL and harmless settings alone', () => {
    assert.equal(statementHijacksSession('SELECT 1'), false)
    assert.equal(statementHijacksSession('UPDATE t SET x = 1'), false)
    assert.equal(statementHijacksSession('SET search_path TO public'), false)
    assert.equal(statementHijacksSession('SET TIME ZONE 0'), false)
    // "commit" as an identifier or inside a value is not transaction control.
    assert.equal(statementHijacksSession('SELECT commit_sha FROM builds'), false)
    assert.equal(statementHijacksSession("SELECT 'commit' AS word"), false)
  })
})

describe('describeSensitiveRead', () => {
  it('names credential stores that a read-only transaction happily allows', () => {
    assert.equal(describeSensitiveRead('SELECT * FROM pg_authid'), 'pg_authid')
    assert.equal(describeSensitiveRead('select rolpassword from PG_AUTHID'), 'pg_authid')
    assert.equal(describeSensitiveRead('SELECT * FROM pg_shadow'), 'pg_shadow')
    assert.equal(describeSensitiveRead('SELECT umoptions FROM pg_user_mappings'), 'pg_user_mappings')
  })

  it('names server-side file readers', () => {
    assert.equal(describeSensitiveRead("SELECT pg_read_file('/etc/passwd')"), 'pg_read_file')
    assert.equal(describeSensitiveRead("SELECT pg_ls_dir('.')"), 'pg_ls_dir')
    assert.equal(describeSensitiveRead("SELECT pg_stat_file('postgresql.conf')"), 'pg_stat_file')
  })

  it('does not fire on ordinary catalog reads', () => {
    assert.equal(describeSensitiveRead('SELECT * FROM pg_roles'), null)
    assert.equal(describeSensitiveRead('SELECT * FROM pg_class'), null)
    assert.equal(describeSensitiveRead('SELECT id FROM users'), null)
  })

  it('is not fooled by the name appearing inside a string or a quoted identifier', () => {
    assert.equal(describeSensitiveRead("SELECT 'pg_authid' AS note"), null)
    assert.equal(describeSensitiveRead('SELECT "pg_authid" FROM notes'), null)
  })
})

describe('sensitiveReadsAllowed', () => {
  it('is off unless explicitly opted into', () => {
    assert.equal(sensitiveReadsAllowed({}), false)
    assert.equal(sensitiveReadsAllowed({ DBEAVER_MCP_ALLOW_SENSITIVE_READS: 'false' }), false)
    assert.equal(sensitiveReadsAllowed({ DBEAVER_MCP_ALLOW_SENSITIVE_READS: '' }), false)
    assert.equal(sensitiveReadsAllowed({ DBEAVER_MCP_ALLOW_SENSITIVE_READS: 'true' }), true)
    assert.equal(sensitiveReadsAllowed({ DBEAVER_MCP_ALLOW_SENSITIVE_READS: 'YES' }), true)
  })
})

describe('toBigIntOrNull', () => {
  it('keeps bigint precision that Number() would destroy', () => {
    const big = '9007199254740993' // 2^53 + 1
    assert.equal(toBigIntOrNull(big), 9007199254740993n)
    // The bug this replaced: Number() rounds this to 9007199254740992.
    assert.notEqual(String(Number(big)), big)
    assert.equal(String(toBigIntOrNull(big)), big)
  })

  it('returns null for anything that is not an exact integer', () => {
    assert.equal(toBigIntOrNull(null), null)
    assert.equal(toBigIntOrNull(undefined), null)
    assert.equal(toBigIntOrNull('abc'), null)
    assert.equal(toBigIntOrNull('1.5'), null)
    assert.equal(toBigIntOrNull(''), null)
  })

  it('accepts negatives and surrounding whitespace', () => {
    assert.equal(toBigIntOrNull(' -42 '), -42n)
  })
})

describe('quoteLiteral', () => {
  it('escapes the quote that would otherwise break out of the literal', () => {
    assert.equal(quoteLiteral("it's"), "'it''s'")
    assert.equal(quoteLiteral('plain'), "'plain'")
  })

  it('contains an injection attempt through an identifier name', () => {
    // A sequence named  x'); DROP TABLE t; --  reaches setval as a string literal.
    const hostile = "x'); DROP TABLE t; --"
    assert.equal(quoteLiteral(hostile).includes("''"), true)
    assert.equal(quoteLiteral(hostile).startsWith("'"), true)
    assert.equal(quoteLiteral(hostile).endsWith("'"), true)
  })
})

describe('stripQuoted', () => {
  it('blanks strings, dollar quotes and quoted identifiers', () => {
    assert.equal(stripQuoted("SELECT 'abc'"), "SELECT ''")
    assert.equal(stripQuoted('SELECT "abc"'), 'SELECT ""')
    assert.match(stripQuoted('SELECT $t$abc$t$'), /SELECT ''/)
  })

  it('strips comments', () => {
    assert.match(stripQuoted('SELECT 1 -- pg_authid'), /SELECT 1\s*$/)
    assert.match(stripQuoted('SELECT /* pg_authid */ 1'), /SELECT\s+1/)
  })
})
