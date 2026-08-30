import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
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
  fmHome: '/Users/dongkeun/firstmate-home',
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

/** Detects an unmanaged process that explicitly owns the session or implicitly owns the cwd. */
export async function externalPiSessionOwner(
  sessionPath: string | undefined,
  workspace: string,
  ignoredPids: ReadonlySet<number> = new Set(),
): Promise<number | undefined> {
  if (process.platform === 'win32') return undefined

  let stdout: string
  let canonicalWorkspace: string
  try {
    const [result, resolvedWorkspace] = await Promise.all([
      execFileAsync('ps', ['-axo', 'pid=,args='], {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      }),
      realpath(workspace),
    ])
    stdout = result.stdout
    canonicalWorkspace = resolvedWorkspace
  } catch {
    throw verificationError()
  }

  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/)
    if (!match) continue
    const pid = Number(match[1])
    if (!Number.isSafeInteger(pid) || ignoredPids.has(pid)) continue
    if (sessionPath && commandOwnsPiSession(match[2], sessionPath)) return pid
    if (!commandMayOwnPiWorkspace(match[2])) continue
    const cwd = await processCwd(pid)
    if (cwd === canonicalWorkspace) return pid
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

/** Treats bare and continue-mode Pi invocations as implicit owners of their cwd. */
export function commandMayOwnPiWorkspace(command: string): boolean {
  const argumentsAfterEntrypoint = piArguments(command)
  if (!argumentsAfterEntrypoint) return false
  if (
    argumentsAfterEntrypoint.some((argument) =>
      argument === '--session' || argument.startsWith('--session=') || argument === '-s'
      || argument === '--session-id' || argument.startsWith('--session-id=')
    )
  ) return false
  return argumentsAfterEntrypoint.length === 0
    || argumentsAfterEntrypoint.includes('-c')
    || argumentsAfterEntrypoint.includes('--continue')
}

function piArguments(command: string): string[] | undefined {
  const tokens = command.match(/(?:"[^"]*"|'[^']*'|\S+)/g)?.map(unquote) ?? []
  if (tokens.length === 0) return undefined
  if (isPiEntrypoint(tokens[0])) return tokens.slice(1)
  if (!['node', 'nodejs'].includes(basename(tokens[0]))) return undefined
  const entrypoint = tokens.slice(1, 4).findIndex(isPiEntrypoint)
  return entrypoint < 0 ? undefined : tokens.slice(entrypoint + 2)
}

function isPiEntrypoint(value: string): boolean {
  const normalized = value.replaceAll('\\', '/')
  return basename(normalized) === 'pi'
    || /(?:^|\/)pi-coding-agent\/.+\/cli(?:\.js)?$/.test(normalized)
}

function unquote(value: string): string {
  if (
    value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith('\'') && value.endsWith('\'')))
  ) return value.slice(1, -1)
  return value
}

async function processCwd(pid: number): Promise<string | undefined> {
  try {
    if (process.platform === 'linux') return await realpath(`/proc/${pid}/cwd`)
    if (process.platform !== 'darwin') return undefined
    const { stdout } = await execFileAsync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
    })
    const cwd = stdout.split('\n').find((line) => line.startsWith('n'))?.slice(1)
    if (!cwd) throw new Error('Missing cwd')
    return await realpath(cwd)
  } catch {
    if (!isProcessAlive(pid)) return undefined
    throw verificationError()
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function verificationError(): Error {
  return new Error('Could not verify whether Firstmate is already open in another Pi process')
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
