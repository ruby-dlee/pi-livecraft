import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const FIRSTMATE_PRESET_ID = 'firstmate' as const

export interface FirstmatePreset {
  id: typeof FIRSTMATE_PRESET_ID
  workspace: string
  fmHome: string
  agentDirectory: string
  sessionDirectory: string
  extensions: [string, string]
}

const defaults = {
  workspace: '/Users/dongkeun/firstmate',
  fmHome: '/mnt/task/.fm-return',
  agentDirectory: '/Users/dongkeun/.pi/firstmate-local',
  extensions: [
    '/Users/dongkeun/firstmate/.pi/extensions/fm-primary-turnend-guard.ts',
    '/Users/dongkeun/firstmate/.pi/extensions/fm-primary-pi-watch.ts',
  ] as const,
}

/** Builds the fixed Firstmate preset from trusted launcher environment overrides, never HTTP input. */
export function firstmatePreset(
  environment: NodeJS.ProcessEnv = process.env,
): FirstmatePreset {
  const agentDirectory = environment.PI_LIVECRAFT_FIRSTMATE_AGENT_DIR
    ?? defaults.agentDirectory
  return {
    id: FIRSTMATE_PRESET_ID,
    workspace: environment.PI_LIVECRAFT_FIRSTMATE_WORKSPACE ?? defaults.workspace,
    fmHome: environment.PI_LIVECRAFT_FIRSTMATE_HOME ?? defaults.fmHome,
    agentDirectory,
    sessionDirectory: join(agentDirectory, 'sessions'),
    extensions: [
      environment.PI_LIVECRAFT_FIRSTMATE_TURNEND_GUARD ?? defaults.extensions[0],
      environment.PI_LIVECRAFT_FIRSTMATE_PI_WATCH ?? defaults.extensions[1],
    ],
  }
}

/** Fails before spawning Pi when a local preset path is absent or has the wrong kind. */
export async function validateFirstmatePreset(preset: FirstmatePreset): Promise<void> {
  await Promise.all([
    requirePath(preset.workspace, 'workspace', 'directory'),
    requirePath(preset.fmHome, 'FM_HOME', 'directory'),
    requirePath(preset.agentDirectory, 'Pi profile', 'directory'),
    requirePath(preset.extensions[0], 'turn-end guard extension', 'file'),
    requirePath(preset.extensions[1], 'Pi watch extension', 'file'),
  ])
}

async function requirePath(
  path: string,
  label: string,
  kind: 'directory' | 'file',
): Promise<void> {
  if (!isAbsolute(path)) throw new Error(`Firstmate ${label} must be an absolute local path`)
  try {
    const details = await stat(path)
    if (kind === 'directory' ? !details.isDirectory() : !details.isFile()) throw new Error()
  } catch {
    throw new Error(`Firstmate ${label} is unavailable: ${path}`)
  }
}

/** Detects a process whose argv explicitly opens the same persisted Pi session. */
export async function externalPiSessionOwner(
  sessionPath: string,
  ignoredPids: ReadonlySet<number> = new Set(),
): Promise<number | undefined> {
  if (process.platform === 'win32') return undefined

  let stdout: string
  try {
    const result = await execFileAsync('ps', ['-axo', 'pid=,args='], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    })
    stdout = result.stdout
  } catch {
    throw new Error('Could not verify whether Firstmate is already open in another Pi process')
  }

  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/)
    if (!match) continue
    const pid = Number(match[1])
    if (!Number.isSafeInteger(pid) || ignoredPids.has(pid)) continue
    if (commandOwnsPiSession(match[2], sessionPath)) return pid
  }
  return undefined
}

/** Matches only an argv-style --session/-s value, not an arbitrary path mention. */
export function commandOwnsPiSession(command: string, sessionPath: string): boolean {
  const path = escapeRegex(sessionPath)
  return new RegExp(
    `(?:^|\\s)(?:--session(?:=|\\s+)|-s\\s+)(?:"${path}"|'${path}'|${path})(?=\\s|$)`,
  )
    .test(command)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
