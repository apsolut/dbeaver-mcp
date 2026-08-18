import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { BACKUP_ART, isFirstRun, markBackupSeen } from '../src/banner.js'

describe('backup banner first-run', () => {
  let dir
  let prev

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dbeaver-mcp-'))
    prev = process.env.DBEAVER_MCP_STATE
    process.env.DBEAVER_MCP_STATE = dir
  })

  afterEach(() => {
    if (prev === undefined) delete process.env.DBEAVER_MCP_STATE
    else process.env.DBEAVER_MCP_STATE = prev
    rmSync(dir, { recursive: true, force: true })
  })

  it('is first run until marked, then not', () => {
    assert.equal(isFirstRun(), true)
    assert.match(BACKUP_ART, /BACKUP FIRST YOUR DATABASE/)
    markBackupSeen()
    assert.equal(isFirstRun(), false)
  })
})
