import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isWriteSql, quoteIdent, splitStatements, statementIsWrite } from '../src/query.js'

describe('splitStatements', () => {
  it('splits two selects', () => {
    assert.deepEqual(splitStatements('SELECT 1; SELECT 2'), ['SELECT 1', 'SELECT 2'])
  })

  it('keeps semicolons inside strings and dollar quotes', () => {
    const sql = "INSERT INTO t (body) VALUES ('a;b'); INSERT INTO t (body) VALUES ($cnt$x;y$cnt$)"
    assert.equal(splitStatements(sql).length, 2)
    assert.match(splitStatements(sql)[0], /a;b/)
    assert.match(splitStatements(sql)[1], /\$cnt\$x;y\$cnt\$/)
  })

  it('ignores trailing semicolon', () => {
    assert.deepEqual(splitStatements('SELECT 1;'), ['SELECT 1'])
  })
})

describe('isWriteSql', () => {
  it('treats SELECT as read', () => {
    assert.equal(isWriteSql('SELECT id FROM regions'), false)
    assert.equal(isWriteSql('WITH x AS (SELECT 1) SELECT * FROM x'), false)
  })

  it('treats setval and nextval as writes even when wrapped in SELECT', () => {
    assert.equal(isWriteSql("SELECT setval('pages_id_seq', 7, true)"), true)
    assert.equal(isWriteSql('SELECT nextval($$cities_id_seq$$)'), true)
  })

  it('treats WITH ... INSERT as a write', () => {
    assert.equal(isWriteSql('WITH x AS (SELECT 1 AS id) INSERT INTO t SELECT * FROM x'), true)
  })

  it('flags a write if any statement in a batch mutates', () => {
    assert.equal(isWriteSql('SELECT 1; INSERT INTO t VALUES (1)'), true)
    assert.equal(statementIsWrite('UPDATE t SET a = 1'), true)
  })
})

describe('quoteIdent', () => {
  it('quotes and escapes identifiers', () => {
    assert.equal(quoteIdent('pages'), '"pages"')
    assert.equal(quoteIdent('weird"name'), '"weird""name"')
  })
})
