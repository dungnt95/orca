/**
 * Paired remote server: a cold-parked remote terminal must not lose its scrollback when the host
 * cannot answer the restore the park was licensed against.
 *
 * Topology: headed Orca desktop host (remote server) + a separate paired Orca desktop client —
 * the "SSH into the box, open the workspace, switch away, come back" shape. A remote-runtime
 * pty's bytes never transit the client's main process, so the client's xterm buffer is the only
 * client-side copy, and the paired-parking capability that licenses the unmount is a static build
 * string that says nothing about whether the host retained this pty's buffer.
 *
 * Oracle: a token the test typed into the terminal before the park, echoed back by the fixture, is
 * still in the revealed pane's buffer. Nothing replays stdin, so a respawned command cannot
 * reproduce that line — only the pre-park buffer can.
 *
 * The two scenarios are deliberately opposite directions of the same oracle:
 *   - "host retains the buffer" is the control. It fails if the harness never parks, never
 *     reveals, or never echoed the token in the first place — so a green regression case cannot be
 *     green for an unrelated reason.
 *   - "host retains nothing" is the regression. ORCA_E2E_FORCE_REMOTE_TERMINAL_SNAPSHOT_UNAVAILABLE
 *     makes the host answer `no-serializable-buffer` — the state a client cannot tell apart from a
 *     host that is merely slow. Pre-fix the reveal paints an empty pane.
 *
 * Run:
 *   pnpm exec playwright test \
 *     tests/e2e/paired-remote-terminal-parked-scrollback-survives.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import {
  callEnvironment,
  createPairedHostTerminal,
  openPairedClientTab,
  waitForPairedPaneMarker,
  type PairedHostTerminal
} from './helpers/paired-host-terminal'
import { focusActiveTerminalInput } from './helpers/terminal'
import { waitForTabParked } from './helpers/terminal-hidden-parking'

const PARK_DELAY_MS = 2_000
const PAINT_BUDGET_MS = 30_000
const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-parked-scrollback-'))

// Why the token arrives over stdin rather than argv or a startup write: a respawn of the same
// command reprints anything baked into the command, and a startup write only reaches a client
// that was already subscribed — which the forced-unavailable host snapshot makes racy. Nothing
// replays stdin, so an echoed line can only come back from the buffer that was there pre-park.
const fixturePath = path.join(scratch, 'parked-scrollback-terminal.mjs')
writeFileSync(
  fixturePath,
  [
    "process.stdout.write('READY\\r\\n')",
    "process.stdin.setEncoding('utf8')",
    "let pending = ''",
    "process.stdin.on('data', (data) => {",
    '  pending += data',
    '  const lines = pending.split(/\\r\\n|\\r|\\n/)',
    "  pending = lines.pop() ?? ''",
    '  for (const line of lines) {',
    '    process.stdout.write(`LINE:${line}\\r\\n`)',
    '  }',
    '})',
    'process.stdin.resume()'
  ].join('\n')
)

test.afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function fixtureCommand(): string {
  const command = [process.execPath, fixturePath]
  return process.platform === 'win32'
    ? command.map((value) => `"${value.replaceAll('"', '""')}"`).join(' ')
    : command.map(shellQuote).join(' ')
}

type ParkRevealOutcome = {
  /** The echoed token painted live before the park, so the pane really held it. */
  tokenBeforePark: boolean
  parked: boolean
  /** The same echoed line is back. Nothing replays stdin, so a respawn cannot produce it. */
  tokenAfterReveal: boolean
}

async function readHostWorktreeId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const id = window.__store?.getState().activeWorktreeId
    if (!id) {
      throw new Error('headed host has no active worktree')
    }
    return id
  })
}

/** Creates a host terminal, mirrors it on the client, parks it behind two decoys, reveals it, and
 *  reports whether its pre-park content came back. Two decoys: the most recently hidden tab is
 *  exempt from cold-park (#8262), so one decoy hides the target and the second moves the exemption. */
async function runParkRevealScenario(
  clientPage: Page,
  environmentId: string,
  worktreeId: string,
  createdTerminals: string[]
): Promise<ParkRevealOutcome> {
  const target = await createPairedHostTerminal(
    clientPage,
    environmentId,
    worktreeId,
    fixtureCommand()
  )
  // Two decoys: the most recently hidden tab is exempt from cold-park (#8262), so one decoy hides
  // the target and the second moves the exemption.
  const decoys: PairedHostTerminal[] = []
  for (let index = 0; index < 2; index += 1) {
    decoys.push(
      await createPairedHostTerminal(clientPage, environmentId, worktreeId, fixtureCommand())
    )
  }
  createdTerminals.push(target.terminal, ...decoys.map((decoy) => decoy.terminal))

  await openPairedClientTab(clientPage, worktreeId, target.webTabId)
  await waitForPairedPaneMarker(clientPage, target.webTabId, 'READY', PAINT_BUDGET_MS)
  const token = `LINE:token-${randomUUID()}`
  await focusActiveTerminalInput(clientPage)
  await clientPage.keyboard.type(token.slice('LINE:'.length))
  await clientPage.keyboard.press('Enter')
  const tokenBeforePark = await waitForPairedPaneMarker(
    clientPage,
    target.webTabId,
    token,
    PAINT_BUDGET_MS
  )

  await openPairedClientTab(clientPage, worktreeId, decoys[0].webTabId)
  await openPairedClientTab(clientPage, worktreeId, decoys[1].webTabId)
  let parked = true
  try {
    await waitForTabParked(clientPage, target.webTabId, { parkDelayMs: PARK_DELAY_MS })
  } catch {
    parked = false
  }

  // Logged, not asserted: on failure this is the whole diagnosis — whether the park left a client
  // copy at all, and if not, whether the repo catalog ruled the worktree local.
  const parkDiagnostics = await clientPage.evaluate(
    ({ webTabId, worktreeId }) => {
      const state = window.__store?.getState()
      const layout = state?.terminalLayoutsByTabId?.[webTabId]
      const repoId = worktreeId.split('::')[0]
      const repo = (state?.repos ?? []).find((entry) => entry.id === repoId)
      return {
        storedBufferLeafIds: Object.keys(layout?.buffersByLeafId ?? {}),
        storedBufferLength: Object.values(layout?.buffersByLeafId ?? {}).join('').length,
        layoutRoot: layout?.root ? JSON.stringify(layout.root) : null,
        repoKnown: repo !== undefined,
        repoConnectionId: repo?.connectionId ?? null,
        repoExecutionHostId: repo?.executionHostId ?? null
      }
    },
    { webTabId: target.webTabId, worktreeId }
  )
  console.log(`[parked-scrollback] park-diagnostics ${JSON.stringify(parkDiagnostics)}`)

  // Why a forced inventory frame: without one this spec passes whether or not the mirrored-layout
  // rebuild carries the capture, because no frame happens to land in its window. A host frame
  // rebuilds the tab's layout bufferless; terminalLayoutEqual compares buffers, so the write is
  // not bailed out and apply-terminal-records assigns it wholesale. That wipes the only
  // client-side copy. This is the destroying event, so it belongs inside the window under test.
  const probeTab = await createPairedHostTerminal(
    clientPage,
    environmentId,
    worktreeId,
    fixtureCommand()
  )
  createdTerminals.push(probeTab.terminal)
  await expect
    .poll(
      () =>
        clientPage.evaluate(
          (id) => (window.__store?.getState().tabsByWorktree[id] ?? []).map((tab) => tab.id),
          worktreeId
        ),
      {
        timeout: 60_000,
        message: 'client never mirrored the probe tab (no inventory frame landed)'
      }
    )
    .toContain(probeTab.webTabId)
  const afterInventoryFrame = await clientPage.evaluate((webTabId) => {
    const layout = window.__store?.getState().terminalLayoutsByTabId?.[webTabId]
    return {
      leafIds: Object.keys(layout?.buffersByLeafId ?? {}),
      length: Object.values(layout?.buffersByLeafId ?? {}).join('').length,
      layoutKnown: layout !== undefined
    }
  }, target.webTabId)
  console.log(`[parked-scrollback] after-inventory-frame ${JSON.stringify(afterInventoryFrame)}`)
  expect(
    { survivedInventoryFrame: afterInventoryFrame.length > 0 },
    'a host inventory frame wiped the park capture before the reveal'
  ).toEqual({ survivedInventoryFrame: true })

  await openPairedClientTab(clientPage, worktreeId, target.webTabId)
  const tokenAfterReveal = await waitForPairedPaneMarker(
    clientPage,
    target.webTabId,
    token,
    PAINT_BUDGET_MS
  )
  return { tokenBeforePark, parked, tokenAfterReveal }
}

async function runScenario(
  orcaPage: Page,
  testInfo: Parameters<Parameters<typeof test>[1]>[1],
  clientName: string
): Promise<ParkRevealOutcome> {
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedElectronClient(offer, testInfo, clientName, {
    extraEnv: { ORCA_E2E_TERMINAL_PARKING_DELAY_MS: String(PARK_DELAY_MS) }
  })
  const createdTerminals: string[] = []
  try {
    const worktreeId = await readHostWorktreeId(orcaPage)
    await expect
      .poll(
        () =>
          client.page.evaluate(
            (id) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .some((worktree) => worktree.id === id) ?? false,
            worktreeId
          ),
        { timeout: 60_000, message: 'paired client never saw the host worktree' }
      )
      .toBe(true)
    await client.page.evaluate((id) => {
      const state = window.__store?.getState()
      state?.setActiveView('terminal')
      state?.setActiveWorktree(id)
    }, worktreeId)
    const outcome = await runParkRevealScenario(
      client.page,
      client.environmentId,
      worktreeId,
      createdTerminals
    )
    console.log(`[parked-scrollback] ${clientName} ${JSON.stringify(outcome)}`)
    return outcome
  } finally {
    for (const terminal of createdTerminals) {
      await callEnvironment(client.page, client.environmentId, 'terminal.closeTab', {
        terminal
      }).catch(() => undefined)
    }
    await client.dispose()
  }
}

const RESTORED = { tokenBeforePark: true, parked: true, tokenAfterReveal: true }

test.describe('host retains the buffer', () => {
  test('a cold-parked remote terminal restores its scrollback on reveal', async ({
    orcaPage
  }, testInfo) => {
    test.setTimeout(600_000)
    expect(await runScenario(orcaPage, testInfo, 'host-retains')).toEqual(RESTORED)
  })
})

test.describe('host retains nothing', () => {
  test.use({
    orcaAppExtraEnv: { ORCA_E2E_FORCE_REMOTE_TERMINAL_SNAPSHOT_UNAVAILABLE: '1' }
  })

  test('a cold-parked remote terminal keeps its scrollback when the host cannot answer', async ({
    orcaPage
  }, testInfo) => {
    test.setTimeout(600_000)
    expect(await runScenario(orcaPage, testInfo, 'host-empty')).toEqual(RESTORED)
  })
})
