import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  findConnection,
  isPostgresDriver,
  normalizeHost,
  resolveConnection,
} from '../src/dbeaver.js'

const list = [
  { id: 'pg-1', name: 'ACME LIVE', supported: true },
  { id: 'pg-2', name: 'ACME STAGING', supported: true },
  { id: 'pg-3', name: 'billing', supported: true },
]

describe('resolveConnection', () => {
  it('matches by id and by exact name', () => {
    assert.equal(resolveConnection(list, 'pg-3').name, 'billing')
    assert.equal(resolveConnection(list, 'acme live').id, 'pg-1')
  })

  it('allows an unambiguous substring for reads', () => {
    assert.equal(resolveConnection(list, 'bill').id, 'pg-3')
  })

  it('refuses an ambiguous substring instead of guessing', () => {
    assert.throws(() => resolveConnection(list, 'ACME'), /ambiguous/i)
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
    assert.throws(() => findConnection(list, 'ACME'), /ambiguous/i)
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

describe('normalizeHost', () => {
  it('reduces a pasted URL to a hostname', () => {
    // Real case: Supabase hands you a URL, and DBeaver stores exactly what was
    // typed into the Host box. The result was an opaque ENOTFOUND.
    assert.deepEqual(normalizeHost('https://abc.supabase.co'), {
      host: 'abc.supabase.co',
      port: null,
    })
    assert.deepEqual(normalizeHost('postgres://db.example.com:6543/postgres'), {
      host: 'db.example.com',
      port: 6543,
    })
  })

  it('strips embedded credentials and paths', () => {
    assert.equal(normalizeHost('user:secret@db.example.com').host, 'db.example.com')
    assert.equal(normalizeHost('db.example.com/postgres?sslmode=require').host, 'db.example.com')
  })

  it('leaves an ordinary host alone', () => {
    assert.deepEqual(normalizeHost('db.example.com'), { host: 'db.example.com', port: null })
    assert.deepEqual(normalizeHost('localhost'), { host: 'localhost', port: null })
    assert.deepEqual(normalizeHost('10.0.0.5'), { host: '10.0.0.5', port: null })
  })

  it('handles IPv6 and empty input', () => {
    assert.deepEqual(normalizeHost('[::1]:5433'), { host: '::1', port: 5433 })
    assert.deepEqual(normalizeHost('[2001:db8::1]'), { host: '2001:db8::1', port: null })
    assert.deepEqual(normalizeHost(''), { host: 'localhost', port: null })
    assert.deepEqual(normalizeHost(null), { host: 'localhost', port: null })
  })
})
