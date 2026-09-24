import { createDecipheriv } from 'node:crypto'
import { readFileSync } from 'node:fs'

/**
 * DBeaver Community encrypts credentials-config.json with a published AES key.
 * Source: DefaultSecureStorage.LOCAL_KEY_CACHE in the DBeaver repo.
 */
const LOCAL_KEY = Buffer.from([
  186, 187, 74, 159, 119, 74, 184, 83, 201, 108, 45, 101, 61, 254, 84, 74,
])

export class CredentialsError extends Error {
  constructor(message, { cause, hint } = {}) {
    super(message)
    this.name = 'CredentialsError'
    if (hint) this.hint = hint
    if (cause) this.cause = cause
  }
}

/** Some DBeaver setups keep this file as plain JSON. */
function looksLikeJson(buf) {
  for (let i = 0; i < Math.min(buf.length, 8); i++) {
    const c = buf[i]
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue
    return c === 0x7b
  }
  return false
}

export function decryptCredentialsFile(filePath) {
  let raw
  try {
    raw = readFileSync(filePath)
  } catch (err) {
    throw new CredentialsError(`Cannot read ${filePath}: ${err.message}`, {
      cause: err,
      hint: 'Close DBeaver or check file permissions.',
    })
  }

  if (raw.length === 0) return {}

  if (looksLikeJson(raw)) {
    try {
      return JSON.parse(raw.toString('utf8'))
    } catch (err) {
      throw new CredentialsError(`${filePath} is not valid JSON`, { cause: err })
    }
  }

  if (raw.length < 32) {
    throw new CredentialsError(`Credentials file is too small to be valid: ${filePath}`)
  }

  let json
  try {
    const decipher = createDecipheriv('aes-128-cbc', LOCAL_KEY, raw.subarray(0, 16))
    json = Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString('utf8')
  } catch (err) {
    throw new CredentialsError(`Could not decrypt ${filePath} with the DBeaver Community key`, {
      cause: err,
      hint:
        'This usually means a DBeaver master password is enabled, or the workspace belongs to DBeaver PRO/EE, ' +
        'which uses a different credential store. Connections will still be listed, but without saved passwords.',
    })
  }

  try {
    return JSON.parse(json)
  } catch (err) {
    throw new CredentialsError(`${filePath} decrypted but did not contain JSON`, {
      cause: err,
      hint: 'The credential format may have changed in a newer DBeaver release.',
    })
  }
}
