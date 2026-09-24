import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { sslConfigFor } from '../src/dbeaver.js'

describe('sslConfigFor', () => {
  it('reports no TLS when nothing asks for it', () => {
    assert.equal(sslConfigFor({ properties: {} }, {}).mode, null)
  })

  it('reads the JDBC URL first', () => {
    assert.equal(sslConfigFor({ properties: {} }, { sslMode: 'verify-full' }).mode, 'verify-full')
  })

  it('reads plain connection properties', () => {
    assert.equal(sslConfigFor({ properties: { sslmode: 'require' } }, {}).mode, 'require')
  })

  it('reads the DBeaver SSL handler block', () => {
    const cfg = {
      properties: {},
      handlers: { postgre_ssl: { enabled: true, properties: { sslMode: 'verify-ca' } } },
    }
    assert.equal(sslConfigFor(cfg, {}).mode, 'verify-ca')
  })

  it('treats an enabled SSL handler with no mode as require', () => {
    const cfg = { properties: {}, handlers: { postgre_ssl: { enabled: true, properties: {} } } }
    assert.equal(
      sslConfigFor(cfg, {}).mode,
      'require',
      'ticking Use SSL in DBeaver must not read as cleartext'
    )
  })

  it('ignores a disabled SSL handler', () => {
    const cfg = {
      properties: {},
      handlers: { postgre_ssl: { enabled: false, properties: { sslMode: 'require' } } },
    }
    assert.equal(sslConfigFor(cfg, {}).mode, null)
  })

  it('picks up CA and client certificate paths from the handler', () => {
    const cfg = {
      properties: {},
      handlers: {
        postgre_ssl: {
          enabled: true,
          properties: {
            sslMode: 'verify-full',
            'ssl.root.cert': '/certs/ca.pem',
            'ssl.client.cert': '/certs/client.pem',
            'ssl.client.key': '/certs/client.key',
          },
        },
      },
    }
    const out = sslConfigFor(cfg, {})
    assert.equal(out.rootCert, '/certs/ca.pem')
    assert.equal(out.cert, '/certs/client.pem')
    assert.equal(out.key, '/certs/client.key')
  })

  it('honours the legacy ssl=true property', () => {
    assert.equal(sslConfigFor({ properties: { ssl: 'true' } }, {}).mode, 'require')
  })
})
