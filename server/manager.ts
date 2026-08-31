/**
 * Single owner of all `pi --mode rpc` processes.
 *
 * Invariant: a guarded restart closes owned Pi processes, while persisted
 * sessions remain reopenable from history. The backend communicates through
 * ManagerClient; never spawn Pi directly or bypass the supervised lifecycle.
 */
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { JsonLineDecoder, encodeJsonLine } from './jsonl.ts'
import { PiProcess, terminateAllPiProcesses } from './pi-process.ts'
import {
  externalPiSessionOwner,
  FIRSTMATE_PRESET_ID,
  firstmatePreset,
  validateFirstmatePreset,
} from './firstmate-preset.ts'
import { listRecentPiSessions, loadPiSession } from './pi-session-store.ts'
import {
  generateProjectMap,
  improvementDirectionInstruction,
  loadPromptImprovementSystemPrompt,
} from './prompt-improvement.ts'
import { runIsolatedPrompt } from './run-isolated-prompt.ts'
import { isObject } from '../shared/is-object.ts'
import type {
  JsonObject,
  ManagerEvent,
  ManagerRequest,
  ManagerResponse,
  SessionSummary,
} from '../shared/types.ts'

const host = '127.0.0.1'
const port = readPort('PI_LIVECRAFT_MANAGER_PORT', 43_120)
const minimumOpenSessionsPerWorkspace = 3
const idleReuseAfterMs = readDuration('PI_LIVECRAFT_IDLE_REUSE_AFTER_MS', 3 * 60_000)
const clients = new Set<Socket>()
const sessions = new Map<string, ManagedSession>()
const openingSessions = new Map<string, Promise<SessionSummary>>()
let firstmateLaunch: Promise<SessionSummary> | undefined
const restartExitCode = readRestartExitCode()
const supervised = process.env.PI_LIVECRAFT_MANAGER_SUPERVISED === '1'
  && restartExitCode !== undefined
const runtimeIdentity = {
  instanceId: randomUUID(),
  startedAt: new Date().toISOString(),
  runtimeRevision: process.env.PI_LIVECRAFT_MANAGER_RUNTIME_REVISION ?? null,
  supervised,
}
let shuttingDown = false
let restartAccepted = false
let activeRequests = 0

interface ManagedSession {
  summary: SessionSummary
  pi: PiProcess
  presetId?: typeof FIRSTMATE_PRESET_ID
  pendingUi: Map<string, JsonObject>
  inFlightRequests: number
  switching: boolean
  bufferedEvents: JsonObject[]
  idleSince: number | undefined
}

const server = createServer((socket) => {
  clients.add(socket)
  socket.setNoDelay(true)
  const decoder = new JsonLineDecoder((value) => void handleRequest(socket, value))
  socket.on('data', (chunk) => {
    try {
      decoder.push(chunk)
    } catch (error) {
      respond(socket, { kind: 'response', id: '', ok: false, error: errorMessage(error) })
      socket.destroy()
    }
  })
  socket.on('end', () => decoder.end())
  socket.on('close', () => clients.delete(socket))
  socket.on('error', () => clients.delete(socket))
})

server.on('error', (error) => {
  console.error(`Pi manager failed: ${error.message}`)
  void shutdown(1)
})

server.listen(port, host, () => {
  console.log(`Pi manager listening on tcp://${host}:${port}`)
})

process.on('SIGINT', () => void shutdown(0))
process.on('SIGTERM', () => void shutdown(0))

/** Closes manager connections and every owned Pi process before exiting. */
async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  const serverClosed = server.listening
    ? new Promise<void>((resolve) => server.close(() => resolve()))
    : Promise.resolve()
  for (const client of clients) client.end()
  await Promise.race([
    Promise.all([serverClosed, terminateAllPiProcesses()]),
    new Promise<void>((resolve) => setTimeout(resolve, 4_000)),
  ])
  for (const client of clients) client.destroy()
  process.exit(exitCode)
}

async function handleRequest(socket: Socket, value: unknown): Promise<void> {
  if (!isManagerRequest(value)) {
    respond(socket, { kind: 'response', id: '', ok: false, error: 'Invalid manager request' })
    return
  }
  if (restartAccepted) {
    respond(socket, {
      kind: 'response',
      id: value.id,
      ok: false,
      error: 'Pi manager restart is already in progress',
    })
    return
  }

  const tracksActivity = value.action === 'create' || value.action === 'open'
    || value.action === 'open_preset' || value.action === 'close'
    || value.action === 'rename' || value.action === 'command'
    || value.action === 'improve_prompt' || value.action === 'run_prompt'
    || value.action === 'launch_preset'
  if (tracksActivity) activeRequests += 1
  try {
    let data: unknown
    if (value.action === 'status') data = runtimeIdentity
    else if (value.action === 'restart') {
      if (!supervised || restartExitCode === undefined)
        throw new Error('Pi manager is not supervised')
      if (activeRequests > 0) throw new Error('Active Pi work must settle before restarting')
      const activePiWork = await refreshSessionActivity()
      const activityStartedDuringCheck = activeRequests > 0
        || [...sessions.values()].some(({ summary }) =>
          summary.status === 'starting' || summary.status === 'running'
        )
      if (activePiWork || activityStartedDuringCheck)
        throw new Error('Active Pi work must settle before restarting')
      restartAccepted = true
      respond(socket, { kind: 'response', id: value.id, ok: true, data: { accepted: true } })
      setImmediate(() => void shutdown(restartExitCode))
      return
    } else if (value.action === 'list') {
      await refreshSessionActivity()
      data = listSessions()
    } else if (value.action === 'launch_preset') {
      if (value.preset !== FIRSTMATE_PRESET_ID) throw new Error('Unknown launch preset')
      data = await launchFirstmate()
    } else if (value.action === 'open_preset') {
      if (value.preset !== FIRSTMATE_PRESET_ID) throw new Error('Unknown launch preset')
      if (typeof value.sessionPath !== 'string') throw new Error('Preset session path is required')
      data = await launchFirstmate(value.sessionPath)
    } else if (value.action === 'create') data = await createSession(value)
    else if (value.action === 'open') data = await openSession(value)
    else if (value.action === 'close') data = await closeSession(value)
    else if (value.action === 'rename') data = await renameSession(value)
    else if (value.action === 'improve_prompt') data = await improvePrompt(value)
    else if (value.action === 'run_prompt') data = await runPrompt(value)
    else data = await sendCommand(value)
    respond(socket, { kind: 'response', id: value.id, ok: true, data })
  } catch (error) {
    respond(socket, { kind: 'response', id: value.id, ok: false, error: errorMessage(error) })
  } finally {
    if (tracksActivity) activeRequests -= 1
  }
}

function listSessions(): SessionSummary[] {
  return [...sessions.values()].map(({ summary, pendingUi }) => ({
    ...summary,
    pendingUi: [...pendingUi.values()],
  }))
}

/** Reconciles cached session activity with Pi's live state before reporting or acting on it. */
async function refreshSessionActivity(): Promise<boolean> {
  const managedSessions = [...sessions.values()].filter(({ summary, switching }) =>
    summary.status !== 'exited' && !switching
  )
  const activity = await Promise.all(managedSessions.map(async (session) => {
    const running = piHasActiveWork(await requestPi(session, { type: 'get_state' }, 5_000))
    if (running) markSessionRunning(session)
    else markSessionIdle(session)
    return running || session.pendingUi.size > 0
  }))
  return activity.some(Boolean)
}

function piHasActiveWork(state: JsonObject): boolean {
  if (
    !isObject(state.data)
    || typeof state.data.isStreaming !== 'boolean'
    || typeof state.data.isCompacting !== 'boolean'
    || typeof state.data.pendingMessageCount !== 'number'
    || !Number.isInteger(state.data.pendingMessageCount)
    || state.data.pendingMessageCount < 0
  ) throw new Error('Pi returned an invalid session state')
  return state.data.isStreaming || state.data.isCompacting
    || state.data.pendingMessageCount > 0
}

function markSessionRunning(session: ManagedSession): void {
  session.summary.status = 'running'
  session.idleSince = undefined
}

function markSessionIdle(session: ManagedSession, resetIdleSince = false): void {
  session.summary.status = 'idle'
  if (resetIdleSince || session.idleSince === undefined) session.idleSince = Date.now()
}

function hasBeenIdleLongEnough(session: ManagedSession): boolean {
  return session.idleSince !== undefined && Date.now() - session.idleSince > idleReuseAfterMs
}

/** Opens or safely resumes the one manager-owned primary Firstmate process. */
async function launchFirstmate(sessionPath?: string): Promise<SessionSummary> {
  const existing = [...sessions.values()].find((session) =>
    session.presetId === FIRSTMATE_PRESET_ID && session.summary.status !== 'exited'
  )
  if (existing) return { ...existing.summary, pendingUi: [...existing.pendingUi.values()] }
  if (firstmateLaunch) return { ...await firstmateLaunch, pendingUi: [] }

  const operation = (async (): Promise<SessionSummary> => {
    const preset = firstmatePreset()
    await validateFirstmatePreset(preset)
    const workspace = await realpath(preset.workspace)
    const recent = sessionPath
      ? await loadPiSession(sessionPath, preset.sessionDirectory)
      : (await listRecentPiSessions(workspace, preset.sessionDirectory))[0]
    if (recent && recent.cwd !== workspace)
      throw new Error('Firstmate session does not belong to the configured workspace')
    if (recent) {
      const managedOwner = [...sessions.values()].find((session) =>
        session.summary.sessionPath === recent.sessionPath && session.summary.status !== 'exited'
      )
      if (managedOwner) {
        if (managedOwner.presetId === FIRSTMATE_PRESET_ID) return managedOwner.summary
        throw new Error(
          'Firstmate is already open in another Pi process. Quit it, then try again.',
        )
      }
    }
    const managedPids = new Set(
      [...sessions.values()].flatMap(({ pi }) => pi.child.pid ? [pi.child.pid] : []),
    )
    if (await externalPiSessionOwner(recent?.sessionPath, workspace, managedPids)) {
      throw new Error(
        'Firstmate is already open in another Pi process. Quit it, then try again.',
      )
    }

    const summary: SessionSummary = {
      id: randomUUID(),
      cwd: workspace,
      name: recent?.name ?? 'Firstmate',
      sessionPath: recent?.sessionPath,
      status: 'starting',
      pendingUi: [],
    }
    await startSession(summary, {
      presetId: preset.id,
      persistentExtensions: preset.extensions,
      persistentEnvironment: {
        FM_HOME: preset.fmHome,
        PI_CODING_AGENT_DIR: preset.agentDirectory,
      },
    })
    broadcast({ kind: 'event', event: 'session_created', sessionId: summary.id, data: summary })
    return summary
  })()
  firstmateLaunch = operation
  try {
    const summary = await operation
    return { ...summary, pendingUi: [] }
  } finally {
    if (firstmateLaunch === operation) firstmateLaunch = undefined
  }
}

async function createSession(request: ManagerRequest): Promise<SessionSummary> {
  if (typeof request.cwd !== 'string') throw new Error('Session cwd is required')
  const cwd = await realpath(request.cwd)
  if (!(await stat(cwd)).isDirectory()) throw new Error('Session cwd must be a directory')

  const summary: SessionSummary = {
    id: randomUUID(),
    cwd,
    name: 'New session',
    status: 'starting',
    pendingUi: [],
  }

  await startSession(summary)
  broadcast({ kind: 'event', event: 'session_created', sessionId: summary.id, data: summary })
  return { ...summary, pendingUi: [] }
}

async function openSession(request: ManagerRequest): Promise<SessionSummary> {
  const cwd = request.cwd
  const name = request.name
  const sessionPath = request.sessionPath
  if (typeof cwd !== 'string' || typeof name !== 'string' || typeof sessionPath !== 'string') {
    throw new Error('Session cwd, name and path are required')
  }

  const opening = openingSessions.get(sessionPath)
  if (opening) {
    const summary = await opening
    return { ...summary, pendingUi: [] }
  }

  const existing = [...sessions.values()].find(({ summary }) => summary.sessionPath === sessionPath)
  if (existing?.switching) throw new Error('Pi session is switching')
  if (existing && existing.summary.status !== 'exited')
    return {
      ...existing.summary,
      pendingUi: [...existing.pendingUi.values()],
    }
  if (existing?.summary.status === 'exited') sessions.delete(existing.summary.id)

  const operation = (async (): Promise<SessionSummary> => {
    const summary: SessionSummary = {
      id: randomUUID(),
      cwd,
      name,
      sessionPath,
      status: 'starting',
      pendingUi: [],
    }
    await startSession(summary)
    broadcast({ kind: 'event', event: 'session_created', sessionId: summary.id, data: summary })
    return summary
  })()
  openingSessions.set(sessionPath, operation)
  try {
    const summary = await operation
    return { ...summary, pendingUi: [] }
  } finally {
    if (openingSessions.get(sessionPath) === operation)
      openingSessions.delete(sessionPath)
  }
}

/** Stops a managed Pi process while leaving its persisted session available for reopening. */
async function closeSession(request: ManagerRequest): Promise<{ closed: true }> {
  if (typeof request.sessionId !== 'string') throw new Error('Session id is required')
  const session = sessions.get(request.sessionId)
  if (!session) throw new Error('Unknown session')
  if (session.summary.status === 'exited') return { closed: true }

  await session.pi.terminate()
  if ((session.summary.status as SessionSummary['status']) !== 'exited') {
    session.summary.status = 'exited'
    broadcast({
      kind: 'event',
      event: 'session_exited',
      sessionId: session.summary.id,
      data: { reason: 'closed' },
    })
  }
  return { closed: true }
}

/** Renames a persisted session through a disposable public Pi RPC process. */
async function renameSession(request: ManagerRequest): Promise<{ name: string }> {
  if (
    typeof request.cwd !== 'string' || typeof request.name !== 'string'
    || typeof request.sessionPath !== 'string'
  ) throw new Error('Session cwd, name and path are required')
  const name = request.name.trim()
  if (!name || name.length > 120 || /[\r\n]/.test(name))
    throw new Error('Session name must contain between 1 and 120 characters')
  const cwd = await realpath(request.cwd)
  if (!(await stat(cwd)).isDirectory()) throw new Error('Session cwd must be a directory')

  const pi = new PiProcess(cwd, randomUUID(), request.sessionPath)
  try {
    await pi.request({ type: 'get_state' })
    await pi.request({ type: 'set_session_name', name })
    return { name }
  } finally {
    await pi.terminate()
  }
}

interface SessionLaunchOptions {
  presetId: typeof FIRSTMATE_PRESET_ID
  persistentExtensions: string[]
  persistentEnvironment: NodeJS.ProcessEnv
}

/** Keeps three generic workspace sessions alive and keeps launch presets out of that reuse pool. */
async function startSession(
  summary: SessionSummary,
  launchOptions?: SessionLaunchOptions,
): Promise<void> {
  const openSessions = launchOptions
    ? 0
    : [...sessions.values()]
      .filter((session) =>
        !session.presetId
        && session.summary.cwd === summary.cwd
        && session.summary.status !== 'exited'
      )
      .length
  const reusable = !launchOptions && openSessions >= minimumOpenSessionsPerWorkspace
    ? [...sessions.values()].find((session) =>
      !session.presetId
      && session.summary.cwd === summary.cwd
      && session.summary.status === 'idle'
      && session.pendingUi.size === 0
      && session.inFlightRequests === 0
      && !session.switching
      && hasBeenIdleLongEnough(session)
    )
    : undefined
  if (reusable && await reuseSession(reusable, summary)) return

  const pi = new PiProcess(summary.cwd, summary.id, summary.sessionPath, launchOptions)
  const session: ManagedSession = {
    summary,
    pi,
    presetId: launchOptions?.presetId,
    pendingUi: new Map(),
    inFlightRequests: 0,
    switching: false,
    bufferedEvents: [],
    idleSince: undefined,
  }

  sessions.set(summary.id, session)
  pi.on('event', (event: JsonObject) => handlePiEvent(session, event))
  pi.on('exit', (detail: unknown) => {
    if (session.summary.status === 'exited') return
    session.summary.status = 'exited'
    broadcast({
      kind: 'event',
      event: 'session_exited',
      sessionId: session.summary.id,
      data: detail,
    })
  })

  try {
    const state = await requestPi(session, { type: 'get_state' })
    const sessionPath = isObject(state.data) && typeof state.data.sessionFile === 'string'
      ? state.data.sessionFile
      : undefined
    if (sessionPath) summary.sessionPath = sessionPath
    markSessionIdle(session)
  } catch (error) {
    sessions.delete(summary.id)
    await pi.terminate()
    throw error
  }
}

/** Reassigns one idle Pi process without exposing the target session before the switch completes. */
async function reuseSession(session: ManagedSession, summary: SessionSummary): Promise<boolean> {
  const previousSessionId = session.summary.id
  session.switching = true
  session.bufferedEvents = []
  try {
    const running = piHasActiveWork(
      await requestPi(session, { type: 'get_state' }, 5_000),
    )
    if (running) markSessionRunning(session)
    else markSessionIdle(session)
    if (running || session.pendingUi.size > 0) {
      session.switching = false
      flushBufferedEvents(session)
      return false
    }

    const response = await requestPi(
      session,
      summary.sessionPath
        ? { type: 'switch_session', sessionPath: summary.sessionPath }
        : { type: 'new_session' },
    )
    if (isObject(response.data) && response.data.cancelled === true) {
      session.switching = false
      flushBufferedEvents(session)
      return false
    }
    if (
      session.pendingUi.size > 0
      || session.bufferedEvents.some((event) =>
        event.type === 'extension_ui_request'
        && isBlockingUiRequest(event)
        && typeof event.id === 'string'
      )
    ) throw new Error('Pi left blocking UI pending after switching')

    const state = await requestPi(session, { type: 'get_state' })
    const sessionPath = isObject(state.data) && typeof state.data.sessionFile === 'string'
      ? state.data.sessionFile
      : undefined
    if (sessionPath) summary.sessionPath = sessionPath

    sessions.delete(previousSessionId)
    session.summary = summary
    session.pendingUi.clear()
    markSessionIdle(session, true)
    sessions.set(summary.id, session)
    session.switching = false
    broadcast({
      kind: 'event',
      event: 'session_reassigned',
      sessionId: previousSessionId,
      data: { newSessionId: summary.id },
    })
    flushBufferedEvents(session)
    return true
  } catch {
    session.switching = false
    flushBufferedEvents(session)
    await session.pi.terminate()
    return false
  } finally {
    session.switching = false
  }
}

function flushBufferedEvents(session: ManagedSession): void {
  const bufferedEvents = session.bufferedEvents
  session.bufferedEvents = []
  for (const event of bufferedEvents) handlePiEvent(session, event)
}

async function requestPi(
  session: ManagedSession,
  command: JsonObject,
  timeoutMs?: number,
): Promise<JsonObject> {
  session.inFlightRequests += 1
  try {
    return await session.pi.request(command, timeoutMs)
  } finally {
    session.inFlightRequests -= 1
  }
}

/** Rewrites a draft in a disposable, tool-free Pi process without touching the active session. */
async function improvePrompt(request: ManagerRequest): Promise<{ prompt: string; cost?: number }> {
  if (
    typeof request.sessionId !== 'string' || typeof request.prompt !== 'string' || !request
      .prompt
      .trim()
    || request.prompt.length > 100_000
  ) {
    throw new Error('Session id and a prompt between 1 and 100,000 characters are required')
  }
  const session = sessions.get(request.sessionId)
  if (!session || session.summary.status === 'exited')
    throw new Error('Active Pi session is unavailable')

  const direction = typeof request.direction === 'string'
    ? improvementDirectionInstruction(request.direction)
    : undefined
  const [systemPrompt, projectMap] = await Promise.all([
    loadPromptImprovementSystemPrompt(),
    generateProjectMap(session.summary.cwd),
  ])
  const directionBlock = direction
    ? `<improvement_direction>${direction}</improvement_direction>\n\n`
    : ''
  const result = await runIsolatedPrompt({
    cwd: session.summary.cwd,
    prompt: `<user_prompt>\n${request.prompt.trim()}\n</user_prompt>`,
    systemPrompt: `${systemPrompt}\n\n${directionBlock}${projectMap}`,
    includeContextFiles: false,
  })
  return { prompt: result.text, cost: result.cost }
}

/** Runs a prompt in an isolated, disposable Pi process with caller-controlled configuration. */
async function runPrompt(request: ManagerRequest): Promise<{ text: string }> {
  if (
    typeof request.sessionId !== 'string' || typeof request.prompt !== 'string' || !request
      .prompt
      .trim()
    || request.prompt.length > 100_000
  ) {
    throw new Error('Session id and a prompt between 1 and 100,000 characters are required')
  }
  const session = sessions.get(request.sessionId)
  if (!session || session.summary.status === 'exited')
    throw new Error('Active Pi session is unavailable')

  const result = await runIsolatedPrompt({
    cwd: session.summary.cwd,
    prompt: request.prompt.trim(),
    systemPrompt: typeof request.systemPrompt === 'string' ? request.systemPrompt : undefined,
    thinkingLevel: typeof request.thinkingLevel === 'string' ? request.thinkingLevel : undefined,
    model: isModelOption(request.model) ? request.model : undefined,
    extensions: Array.isArray(request.extensions)
      ? request.extensions.filter((e): e is string => typeof e === 'string')
      : undefined,
    tools: Array.isArray(request.tools)
      ? request.tools.filter((t): t is string => typeof t === 'string')
      : undefined,
    includeContextFiles: typeof request.includeContextFiles === 'boolean'
      ? request.includeContextFiles
      : undefined,
  })
  return { text: result.text }
}

function isModelOption(value: unknown): value is { provider: string; modelId: string } {
  return isObject(value) && typeof value.provider === 'string' && typeof value.modelId === 'string'
}

/** Forwards one RPC command while making prompt activity visible before Pi emits its first event. */
async function sendCommand(request: ManagerRequest): Promise<JsonObject> {
  if (typeof request.sessionId !== 'string' || !isObject(request.command)) {
    throw new Error('Session id and Pi command are required')
  }
  const session = sessions.get(request.sessionId)
  if (!session) throw new Error('Unknown session')
  if (session.summary.status === 'exited') throw new Error('Pi session has exited')
  if (session.switching && request.command.type !== 'extension_ui_response')
    throw new Error('Pi session is switching')

  if (request.command.type === 'extension_ui_response') {
    if (typeof request.command.id === 'string') session.pendingUi.delete(request.command.id)
    session.pi.send(request.command)
    if (session.summary.status === 'idle' && session.pendingUi.size === 0)
      markSessionIdle(session, true)
    return { success: true }
  }

  const startsAgent = request.command.type === 'prompt'
    && (typeof request.command.message !== 'string' || !request.command.message.startsWith('/'))
  if (startsAgent) markSessionRunning(session)
  try {
    const response = await requestPi(session, request.command)
    if (
      request.command.type === 'fork'
      && (!isObject(response.data) || response.data.cancelled !== true)
    ) {
      const state = await requestPi(session, { type: 'get_state' })
      if (!isObject(state.data) || typeof state.data.sessionFile !== 'string')
        throw new Error('Pi returned an invalid session file after forking')
      session.summary.sessionPath = state.data.sessionFile
    }
    if (!startsAgent && session.summary.status === 'idle' && session.pendingUi.size === 0)
      markSessionIdle(session, true)
    return response
  } catch (error) {
    if (startsAgent && session.summary.status === 'running') markSessionIdle(session, true)
    throw error
  }
}

function handlePiEvent(session: ManagedSession, event: JsonObject): void {
  if (session.switching) {
    session.bufferedEvents.push(event)
    return
  }
  if (event.type === 'session_info_changed') {
    session.summary.name = typeof event.name === 'string' && event.name.trim()
      ? event.name.trim()
      : 'New session'
  }
  if (event.type === 'agent_start') markSessionRunning(session)
  if (event.type === 'agent_settled') markSessionIdle(session, true)
  if (
    event.type === 'extension_ui_request' && event.method === 'setStatus'
    && event.statusKey === 'agent'
  ) {
    session.summary.activeAgent = activeAgentFromStatus(event.statusText)
    event.activeAgent = session.summary.activeAgent
  }
  if (
    event.type === 'extension_ui_request' && isBlockingUiRequest(event)
    && typeof event.id === 'string'
  ) {
    session.pendingUi.set(event.id, event)
  }
  broadcast({ kind: 'event', event: 'pi', sessionId: session.summary.id, data: event })
}

function activeAgentFromStatus(statusText: unknown): string | undefined {
  if (typeof statusText !== 'string') return undefined
  const prefix = 'Agent:'
  const prefixIndex = statusText.indexOf(prefix)
  if (prefixIndex === -1) return undefined
  const rawName = statusText.slice(prefixIndex + prefix.length)
  const endIndex = rawName.indexOf('\u001b')
  const name = rawName.slice(0, endIndex === -1 ? undefined : endIndex).trim()
  return name || undefined
}

function isBlockingUiRequest(event: JsonObject): boolean {
  return event.method === 'select' || event.method === 'confirm' || event.method === 'input'
    || event.method === 'editor'
}

function broadcast(event: ManagerEvent): void {
  const line = encodeJsonLine(event)
  for (const client of clients) {
    if (client.writable) client.write(line)
  }
}

function respond(socket: Socket, response: ManagerResponse): void {
  if (socket.writable) socket.write(encodeJsonLine(response))
}

function isManagerRequest(value: unknown): value is ManagerRequest {
  if (!isObject(value) || typeof value.id !== 'string') return false
  return value.action === 'list' || value.action === 'create' || value.action === 'open'
    || value.action === 'open_preset' || value.action === 'close'
    || value.action === 'rename' || value.action === 'command'
    || value.action === 'improve_prompt' || value.action === 'run_prompt'
    || value.action === 'launch_preset' || value.action === 'status'
    || value.action === 'restart'
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Reads and validates a port from the environment, using the supplied default when unset. */
function readPort(primary: string, fallback: number): number {
  const value = Number(process.env[primary] ?? fallback)
  if (!Number.isInteger(value) || value < 1 || value > 65_535)
    throw new Error(`${primary} must be a valid port`)
  return value
}

function readRestartExitCode(): number | undefined {
  const rawValue = process.env.PI_LIVECRAFT_MANAGER_RESTART_EXIT_CODE
  if (rawValue === undefined) return undefined
  const value = Number(rawValue)
  return Number.isInteger(value) && value > 0 && value <= 255 ? value : undefined
}

/** Reads a non-negative duration, with an explicit default for normal runtime use. */
function readDuration(name: string, fallback: number): number {
  const rawValue = process.env[name]
  if (rawValue === undefined) return fallback
  const value = Number(rawValue)
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${name} must be a non-negative number`)
  return value
}
