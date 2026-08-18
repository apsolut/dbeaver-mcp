import { createDecipheriv } from 'node:crypto'
import { readFileSync } from 'node:fs'

/**
 * DBeaver Community encrypts credentials-config.json with a published AES key.
 * Source: DefaultSecureStorage.LOCAL_KEY_CACHE in the DBeaver repo.
 */
const LOCAL_KEY = Buffer.from([
  186, 187, 74, 159, 119, 74, 184, 83, 201, 108, 45, 101, 61, 254, 84, 74,
])

export function decryptCredentialsFile(filePath) {
  const raw = readFileSync(filePath)
  if (raw.length < 32) {
    throw new Error(`credentials file too small: ${filePath}`)
  }
  const iv = raw.subarray(0, 16)
  const payload = raw.subarray(16)
  const decipher = createDecipheriv('aes-128-cbc', LOCAL_KEY, iv)
  const json = Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8')
  return JSON.parse(json)
}
