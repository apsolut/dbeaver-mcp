import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  capCell,
  newBudget,
  shapeResult,
  sslOptions,
  statementBlocksTransaction,
} from '../src/query.js'

describe('capCell', () => {
  it('summarises bytea instead of emitting a byte array', () => {
    const out = capCell(Buffer.alloc(100000, 7))
    assert.equal(out.type, 'bytea')
    assert.equal(out.bytes, 100000)
    assert.equal(out.truncated, true)
    assert.ok(out.preview.startsWith('\\x'))
    assert.ok(JSON.stringify(out).length < 4000)
  })

  it('handles bigint, dates, and nested values', () => {
    assert.equal(capCell(10n), '10')
    assert.equal(capCell(new Date('2020-01-02T03:04:05Z')), '2020-01-02T03:04:05.000Z')
    assert.deepEqual(capCell({ a: [1, 'x'], b: null }), { a: [1, 'x'], b: null })
  })

  it('truncates oversized strings', () => {
    const out = capCell('x'.repeat(50000))
    assert.ok(out.length < 50000)
    assert.match(out, /truncated, 50000 bytes/)
  })

  it('produces JSON-serialisable output for every cell type', () => {
    assert.doesNotThrow(() => JSON.stringify(capCell({ big: 1n, buf: Buffer.from('hi') })))
  })
})

describe('shapeResult', () => {
  const result = (rows) => ({ rows, rowCount: rows.length, fields: [{ name: 'blob' }] })

  it('caps rows', () => {
    const shaped = shapeResult(result(Array.from({ length: 10 }, (_, i) => ({ i }))), 3)
    assert.equal(shaped.rows.length, 3)
    assert.equal(shaped.truncated, true)
  })

  it('caps total bytes across a wide result', () => {
    const rows = Array.from({ length: 200 }, () => ({ blob: 'y'.repeat(1000) }))
    const shaped = shapeResult(result(rows), 2000, newBudget(20000))
    assert.ok(shaped.rows.length < 200)
    assert.equal(shaped.truncatedBytes, true)
  })

  it('always returns at least one row even if it busts the budget', () => {
    const shaped = shapeResult(result([{ blob: 'z'.repeat(5000) }]), 10, newBudget(10))
    assert.equal(shaped.rows.length, 1)
  })

  it('shares one budget across statements', () => {
    const budget = newBudget(3000)
    const rows = Array.from({ length: 50 }, () => ({ blob: 'y'.repeat(200) }))
    const a = shapeResult(result(rows), 2000, budget)
    const b = shapeResult(result(rows), 2000, budget)
    assert.ok(b.rows.length < a.rows.length)
  })
})

describe('sslOptions', () => {
  it('returns nothing when SSL is off', () => {
    assert.equal(sslOptions({ sslMode: null }), null)
    assert.equal(sslOptions({ sslMode: 'disable' }), null)
  })

  it('encrypts without authenticating for require', () => {
    assert.equal(sslOptions({ sslMode: 'require' }).rejectUnauthorized, false)
  })

  it('verifies the chain for verify-ca but not the hostname', () => {
    const o = sslOptions({ sslMode: 'verify-ca' })
    assert.equal(o.rejectUnauthorized, true)
    assert.equal(typeof o.checkServerIdentity, 'function')
  })

  it('verifies chain and hostname for verify-full', () => {
    const o = sslOptions({ sslMode: 'verify-full' })
    assert.equal(o.rejectUnauthorized, true)
    assert.equal(o.checkServerIdentity, undefined)
  })

  it('fails closed on an unrecognised mode', () => {
    assert.equal(sslOptions({ sslMode: 'weird' }).rejectUnauthorized, true)
  })
})

describe('statementBlocksTransaction', () => {
  it('detects statements Postgres refuses inside a transaction', () => {
    assert.equal(statementBlocksTransaction('VACUUM ANALYZE t'), true)
    assert.equal(statementBlocksTransaction('CREATE INDEX CONCURRENTLY i ON t (a)'), true)
    assert.equal(statementBlocksTransaction('ALTER SYSTEM SET work_mem = "64MB"'), true)
    assert.equal(statementBlocksTransaction('CREATE DATABASE x'), true)
  })

  it('leaves ordinary statements alone', () => {
    assert.equal(statementBlocksTransaction('INSERT INTO t VALUES (1)'), false)
    assert.equal(statementBlocksTransaction('SELECT 1'), false)
    assert.equal(statementBlocksTransaction('CREATE INDEX i ON t (a)'), false)
  })
})
