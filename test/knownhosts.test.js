import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  POLICY_INSECURE,
  POLICY_STRICT,
  POLICY_TOFU,
  decideHostKey,
  fingerprint,
  hostNameForms,
  keyTypeFromBlob,
  lookupHostKey,
  matchHostPattern,
  parseKnownHosts,
  rememberHostKey,
} from '../src/knownhosts.js'

/** Minimal SSH host key blob: uint32 length + type + payload. */
function blob(type, payload = 'abc') {
  const t = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(t.length, 0)
  return Buffer.concat([len, t, Buffer.from(payload, 'ascii')])
}

const KEY = blob('ssh-ed25519', 'real-key')
const OTHER = blob('ssh-ed25519', 'attacker-key')
const b64 = (b) => b.toString('base64')

describe('known_hosts parsing', () => {
  it('parses plain, marked, and commented lines', () => {
    const entries = parseKnownHosts(
      [
        '# comment',
        '',
        'db.example.com ssh-ed25519 AAAA',
        '@revoked bad.example.com ssh-rsa BBBB',
        '@cert-authority *.example.com ssh-rsa CCCC',
      ].join('\n')
    )
    assert.equal(entries.length, 3)
    assert.equal(entries[0].marker, '')
    assert.equal(entries[1].marker, 'revoked')
    assert.equal(entries[2].marker, 'cert-authority')
  })

  it('matches wildcards, negations, and hashed hosts', () => {
    assert.equal(matchHostPattern('*.example.com', 'db.example.com'), true)
    assert.equal(matchHostPattern('db?.example.com', 'db1.example.com'), true)
    assert.equal(matchHostPattern('db.example.com', 'other.example.com'), false)

    const salt = randomBytes(20)
    const host = 'secret.example.com'
    const hash = createHmac('sha1', salt).update(host).digest('base64')
    assert.equal(matchHostPattern(`|1|${salt.toString('base64')}|${hash}`, host), true)
    assert.equal(matchHostPattern(`|1|${salt.toString('base64')}|${hash}`, 'nope.com'), false)
  })

  it('honours negated patterns', () => {
    const entries = parseKnownHosts('*.example.com,!db.example.com ssh-ed25519 AAAA')
    assert.equal(lookupHostKey(entries, ['db.example.com']).hostFound, false)
    assert.equal(lookupHostKey(entries, ['web.example.com']).hostFound, true)
  })

  it('uses [host]:port form for non-default ports', () => {
    assert.deepEqual(hostNameForms('db.example.com', 22), ['db.example.com'])
    assert.deepEqual(hostNameForms('db.example.com', 2222), [
      '[db.example.com]:2222',
      'db.example.com',
    ])
  })
})

describe('host key decisions', () => {
  const entries = (text) => parseKnownHosts(text)

  it('accepts a matching key', () => {
    const d = decideHostKey({
      entries: entries(`db.example.com ssh-ed25519 ${b64(KEY)}`),
      host: 'db.example.com',
      port: 22,
      keyBlob: KEY,
      policy: POLICY_STRICT,
    })
    assert.equal(d.ok, true)
    assert.equal(d.remember, false)
  })

  it('rejects an unknown host under the default policy', () => {
    const d = decideHostKey({
      entries: [],
      host: 'db.example.com',
      port: 22,
      keyBlob: KEY,
      policy: POLICY_STRICT,
    })
    assert.equal(d.ok, false)
    assert.match(d.reason, /Unknown SSH host key/)
  })

  it('rejects a changed key even under TOFU', () => {
    const d = decideHostKey({
      entries: entries(`db.example.com ssh-ed25519 ${b64(KEY)}`),
      host: 'db.example.com',
      port: 22,
      keyBlob: OTHER,
      policy: POLICY_TOFU,
    })
    assert.equal(d.ok, false)
    assert.match(d.reason, /mismatch/i)
  })

  it('rejects a revoked key', () => {
    const d = decideHostKey({
      entries: entries(`@revoked db.example.com ssh-ed25519 ${b64(KEY)}`),
      host: 'db.example.com',
      port: 22,
      keyBlob: KEY,
      policy: POLICY_STRICT,
    })
    assert.equal(d.ok, false)
    assert.match(d.reason, /revoked/)
  })

  it('records a new key under TOFU', () => {
    const d = decideHostKey({
      entries: [],
      host: 'db.example.com',
      port: 22,
      keyBlob: KEY,
      policy: POLICY_TOFU,
    })
    assert.equal(d.ok, true)
    assert.equal(d.remember, true)
  })

  it('accepts anything under the insecure policy, with a warning', () => {
    const d = decideHostKey({
      entries: entries(`db.example.com ssh-ed25519 ${b64(KEY)}`),
      host: 'db.example.com',
      port: 22,
      keyBlob: OTHER,
      policy: POLICY_INSECURE,
    })
    assert.equal(d.ok, true)
    assert.match(d.warning, /NOT verified/)
  })
})

describe('host key of an unrecorded type', () => {
  const entries = (text) => parseKnownHosts(text)
  const RSA = blob('ssh-rsa', 'rsa-key')

  it('is refused, but not reported as an attack', () => {
    // known_hosts has only ed25519; the server negotiated rsa. Unverifiable,
    // but calling this a man-in-the-middle teaches people to ignore the real one.
    const d = decideHostKey({
      entries: entries(`db.example.com ssh-ed25519 ${b64(KEY)}`),
      host: 'db.example.com',
      port: 22,
      keyBlob: RSA,
      policy: POLICY_STRICT,
    })
    assert.equal(d.ok, false)
    assert.doesNotMatch(d.reason, /man-in-the-middle/)
    assert.match(d.reason, /ssh-rsa/)
    assert.match(d.reason, /ssh-keyscan -t ssh-rsa/)
  })

  it('still reports a same-type key change as an attack', () => {
    const d = decideHostKey({
      entries: entries(`db.example.com ssh-ed25519 ${b64(KEY)}`),
      host: 'db.example.com',
      port: 22,
      keyBlob: OTHER,
      policy: POLICY_STRICT,
    })
    assert.equal(d.ok, false)
    assert.match(d.reason, /man-in-the-middle/)
  })

  it('matches the recorded key when the type does line up', () => {
    const d = decideHostKey({
      entries: entries(
        `db.example.com ssh-ed25519 ${b64(KEY)}\ndb.example.com ssh-rsa ${b64(RSA)}`
      ),
      host: 'db.example.com',
      port: 22,
      keyBlob: RSA,
      policy: POLICY_STRICT,
    })
    assert.equal(d.ok, true)
  })
})

describe('rememberHostKey', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'dbmcp-kh-'))

  it('does not splice onto a file with no trailing newline', () => {
    // Hand-edited known_hosts files often lack one. Appending blind destroyed
    // both the previous host's entry and the new one in a single write.
    const target = join(dir(), 'known_hosts')
    writeFileSync(target, 'other.example.com ssh-ed25519 AAAAsomekey')
    rememberHostKey('db.example.com', 22, KEY, [target])

    const lines = readFileSync(target, 'utf8').split('\n').filter(Boolean)
    assert.equal(lines.length, 2)
    assert.equal(lines[0], 'other.example.com ssh-ed25519 AAAAsomekey')
    assert.match(lines[1], /^db\.example\.com ssh-ed25519 /)
    // The entry must be parseable, which is the thing splicing broke.
    assert.equal(parseKnownHosts(readFileSync(target, 'utf8')).length, 2)
  })

  it('does not add a blank line when the file already ends in one', () => {
    const target = join(dir(), 'known_hosts')
    writeFileSync(target, 'other.example.com ssh-ed25519 AAAAsomekey\n')
    rememberHostKey('db.example.com', 22, KEY, [target])
    assert.equal(readFileSync(target, 'utf8').includes('\n\n'), false)
    assert.equal(parseKnownHosts(readFileSync(target, 'utf8')).length, 2)
  })

  it('creates the file when absent, and uses the bracket form for odd ports', () => {
    const target = join(dir(), 'known_hosts')
    rememberHostKey('db.example.com', 2222, KEY, [target])
    assert.match(readFileSync(target, 'utf8'), /^\[db\.example\.com\]:2222 ssh-ed25519 /)
  })
})

describe('key helpers', () => {
  it('reads the key type out of the blob', () => {
    assert.equal(keyTypeFromBlob(KEY), 'ssh-ed25519')
    assert.equal(keyTypeFromBlob(Buffer.alloc(2)), null)
  })

  it('renders an OpenSSH-style fingerprint', () => {
    assert.match(fingerprint(KEY), /^SHA256:[A-Za-z0-9+/]+$/)
  })
})
