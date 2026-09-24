import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { findConnection, isPostgresDriver, resolveConnection } from '../src/dbeaver.js'

const list = [
  { id: 'pg-1', name: 'PSN LIVE', supported: true },
  { id: 'pg-2', name: 'PSN LIVE STAGING', supported: true },
  { id: 'pg-3', name: 'billing', supported: true },
]

describe('resolveConnection', () => {
  it('matches by id and by exact name', () => {
    assert.equal(resolveConnection(list, 'pg-3').name, 'billing')
    assert.equal(resolveConnection(list, 'psn live').id, 'pg-1')
  })

  it('allows an unambiguous substring for reads', () => {
    assert.equal(resolveConnection(list, 'bill').id, 'pg-3')
  })

  it('refuses an ambiguous substring instead of guessing', () => {
    assert.throws(() => resolveConnection(list, 'PSN'), /ambiguous/i)
  })

  it('refuses any substring when fuzzy matching is off', () => {
    assert.throws(() => resolveConnection(list, 'bill', { fuzzy: false }), /exact/i)
    assert.equal(resolveConnection(list, 'billing', { fuzzy: false }).id, 'pg-3')
  })

  it('reports unknown names with the known list', () => {
    assert.throws(() => resolveConnection(list, 'nope'), /Unknown connection "nope"/)
  })

  it('refuses duplicate exact names', () => {
    const dupes = [
      { id: 'a', name: 'same' },
      { id: 'b', name: 'same' },
    ]
    assert.throws(() => resolveConnection(dupes, 'same'), /same name/i)
  })

  it('findConnection returns null for misses but still throws on ambiguity', () => {
    assert.equal(findConnection(list, 'nope'), null)
    assert.throws(() => findConnection(list, 'PSN'), /ambiguous/i)
  })
})

describe('isPostgresDriver', () => {
  it('accepts postgres-wire drivers', () => {
    assert.equal(isPostgresDriver({ provider: 'postgresql', driver: 'postgres-jdbc' }), true)
    assert.equal(isPostgresDriver({ provider: 'postgresql', driver: 'timescale' }), true)
    assert.equal(isPostgresDriver({ provider: 'cockroach', driver: 'cockroach' }), true)
  })

  it('rejects everything else', () => {
    assert.equal(isPostgresDriver({ provider: 'mysql', driver: 'mysql8' }), false)
    assert.equal(isPostgresDriver({ provider: 'sqlite', driver: 'sqlite_jdbc' }), false)
    assert.equal(isPostgresDriver({}), false)
  })
})
