import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Shown on first run and before the first write of a process. stderr + tool text. */
export const BACKUP_ART = [
  '+==============================================+',
  '|                                              |',
  '|      BACKUP FIRST YOUR DATABASE              |',
  '|                                              |',
  '|         .----------------------.             |',
  '|        /   BACKUP.SQL     DUMP /             |',
  '|       +-----------------------+              |',
  '|       |  pg_dump   last night |              |',
  '|       |_______________________|              |',
  '|              ||    ||                        |',
  '|                                              |',
  '|   Writes go last.  Dump goes first.          |',
  '|                                              |',
  '+==============================================+',
].join('\n')

export const BACKUP_LINE = '[dbeaver-mcp] BACKUP FIRST YOUR DATABASE — dump before write_query / run_script.'

export function stateDir() {
  return process.env.DBEAVER_MCP_STATE || join(homedir(), '.dbeaver-mcp')
}

export function seenFile() {
  return join(stateDir(), 'backup-seen')
}

export function isFirstRun() {
  return !existsSync(seenFile())
}

export function markBackupSeen() {
  mkdirSync(stateDir(), { recursive: true })
  writeFileSync(seenFile(), `${new Date().toISOString()}\n`, 'utf8')
}

/** MCP stdout is the protocol — banners go to stderr only. */
export function printStartupBanner() {
  if (isFirstRun()) {
    console.error(BACKUP_ART)
    console.error(BACKUP_LINE)
    return
  }
  console.error(BACKUP_LINE)
}

export function backupNotice({ full = false } = {}) {
  return {
    backupFirst: true,
    firstRun: isFirstRun(),
    message: 'BACKUP FIRST YOUR DATABASE. Take a dump before write_query / run_script.',
    art: full ? BACKUP_ART : undefined,
  }
}

export function backupBannerText({ full = true } = {}) {
  return full ? `${BACKUP_ART}\n\n${BACKUP_LINE}` : BACKUP_LINE
}
