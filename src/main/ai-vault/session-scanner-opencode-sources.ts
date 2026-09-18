import { basename, dirname, join } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { wslGatedReaddir } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { resolveOpenCodeStorageDirectory } from '../opencode/opencode-data-directory'
import { listOpenCodeDatabases } from '../opencode-usage/opencode-database-discovery'
import { recordSessionScanIssue } from './session-scan-issues'
import { discoverOpenCodeSessions } from './session-scanner-opencode-sqlite-discovery'
import { listOpenCode2SqliteSessionsViaWorker } from './session-scanner-opencode-sqlite-worker-spawn'
import { isOpenCodeV2DatabaseName } from '../../shared/opencode-database-name'
import type { AiVaultScanOptions, SessionFileDiscovery } from './session-scanner-types'

// Why: opencode2 (beta) stores sessions in channel-scoped DBs
// (opencode-next.db / opencode-local.db) alongside the v1 opencode.db. Both
// match the `opencode*.db` glob, so paths are split by basename here: the v1
// discovery never sees v2 DBs (different, beta-unstable schema) and vice versa.

function splitDatabasePaths(dbPaths: readonly string[]): {
  v1Paths: string[]
  v2Paths: string[]
} {
  const v1Paths: string[] = []
  const v2Paths: string[] = []
  for (const dbPath of dbPaths) {
    if (isOpenCodeV2DatabaseName(basename(dbPath))) {
      v2Paths.push(dbPath)
    } else {
      v1Paths.push(dbPath)
    }
  }
  return { v1Paths, v2Paths }
}

export function opencodeDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  const storageDirs = opencodeStorageDirs(options, wslHomeDirs)
  return storageDirs.map(async (storageDir, index) => {
    const { v1Paths } = splitDatabasePaths(
      await opencodeDbPathsForSource(options, wslHomeDirs, storageDir, index, issues)
    )
    return discoverOpenCodeSessions({ storageDir, dbPaths: v1Paths, limitPerAgent: limit, issues })
  })
}

export function opencode2Discoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  return opencodeStorageDirs(options, wslHomeDirs).map(async (storageDir, index) => {
    const { v2Paths } = splitDatabasePaths(
      await opencodeDbPathsForSource(options, wslHomeDirs, storageDir, index, issues)
    )
    return v2Paths.length > 0
      ? discoverOpenCode2Sessions(storageDir, v2Paths, limit, issues)
      : emptyOpenCode2Discovery(storageDir)
  })
}

function opencodeStorageDirs(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[]
): string[] {
  return [
    options.opencodeStorageDir ?? resolveOpenCodeStorageDirectory(),
    ...wslHomeDirs.map((homeDir) => join(homeDir, '.local', 'share', 'opencode', 'storage'))
  ]
}

async function opencodeDbPathsForSource(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  storageDir: string,
  sourceIndex: number,
  issues: AiVaultScanIssue[]
): Promise<readonly string[]> {
  if (options.opencodeDbPaths) {
    const split = splitDatabasePaths(sourceIndex === 0 ? options.opencodeDbPaths : [])
    return [...split.v1Paths, ...split.v2Paths]
  }
  // Why: custom OpenCode storage roots still keep SQLite DBs in the parent data dir.
  if (sourceIndex === 0 && options.opencodeStorageDir) {
    return listOpenCodeDatabasesInDirectory(dirname(storageDir), issues)
  }
  if (sourceIndex === 0) {
    return listOpenCodeDatabases((path, error) => {
      recordSessionScanIssue(issues, { agent: 'opencode', path, message: error.message })
    })
  }
  const wslHomeDir = wslHomeDirs[sourceIndex - 1]
  return wslHomeDir
    ? listOpenCodeDatabasesInDirectory(join(wslHomeDir, '.local', 'share', 'opencode'), issues)
    : []
}

async function listOpenCodeDatabasesInDirectory(
  dataDir: string,
  issues: AiVaultScanIssue[]
): Promise<string[]> {
  try {
    const entries = await wslGatedReaddir(dataDir, 'scan')
    return entries
      .filter((entry) => entry.isFile() && /^opencode(?:-[A-Za-z0-9_.-]+)?\.db$/.test(entry.name))
      .map((entry) => join(dataDir, entry.name))
      .sort()
  } catch (error) {
    // A stalled WSL data dir still degrades to "no databases", but the gap has
    // to be reportable — an empty list otherwise reads as "OpenCode not used".
    if (error instanceof WslTranscriptFsError) {
      recordSessionScanIssue(issues, {
        agent: 'opencode',
        path: dataDir,
        message: error.message
      })
    }
    return []
  }
}

async function discoverOpenCode2Sessions(
  storageDir: string,
  dbPaths: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery> {
  const files = await listOpenCode2SqliteSessionsViaWorker({ dbPaths, limit, issues })
  return {
    agent: 'opencode2' as const,
    rootDir: storageDir,
    files: files.map((candidate) => candidate.file)
  }
}

function emptyOpenCode2Discovery(storageDir: string): SessionFileDiscovery {
  return {
    agent: 'opencode2' as const,
    rootDir: storageDir,
    files: []
  }
}
