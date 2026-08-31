import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { isObject } from '../shared/is-object.ts'
import { encodeJsonLine, JsonLineDecoder } from '../server/jsonl.ts'

const host = '127.0.0.1'

interface BackendFixture {
  baseUrl: string
  close: () => Promise<void>
  genericSessionPath: string
  managerRequests: Array<Record<string, unknown>>
  sessionPath: string
  workspace: string
}

test('Firstmate preset sessions remain usable through a symlinked workspace override', async (t) => {
  const fixture = await createBackendFixture()
  t.after(fixture.close)

  await t.test('lists a preset session when the workspace override is a symlink', async () => {
    const response = await fetch(
      `${fixture.baseUrl}/api/sessions/recent?cwd=${encodeURIComponent(fixture.workspace)}`,
    )

    assert.equal(response.status, 200)
    const recent = await response.json() as Array<{ sessionPath?: string }>
    assert.equal(recent.some(({ sessionPath }) => sessionPath === fixture.sessionPath), true)
  })

  await t.test('opens a preset-profile session through the symlinked workspace', async () => {
    const response = await fetch(`${fixture.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: fixture.workspace, sessionPath: fixture.sessionPath }),
    })

    assert.equal(response.status, 201)
    assert.deepEqual(await response.json(), { sessionId: 'opened-firstmate' })
    const request = fixture.managerRequests.find(({ action }) => action === 'open_preset')
    assert.deepEqual(request, {
      action: 'open_preset',
      id: request?.id,
      preset: 'firstmate',
      sessionPath: fixture.sessionPath,
    })
  })

  await t.test('keeps a standard-profile session on the generic open path', async () => {
    const response = await fetch(`${fixture.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd: fixture.workspace,
        sessionPath: fixture.genericSessionPath,
      }),
    })

    assert.equal(response.status, 201)
    assert.deepEqual(await response.json(), { sessionId: 'opened-generic' })
    const request = fixture.managerRequests.find(({ action }) => action === 'open')
    assert.deepEqual(request, {
      action: 'open',
      cwd: fixture.workspace,
      id: request?.id,
      name: 'Generic session',
      sessionPath: fixture.genericSessionPath,
    })
  })

  await t.test('renames a preset-profile session through the symlinked workspace', async () => {
    const response = await fetch(`${fixture.baseUrl}/api/sessions/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd: fixture.workspace,
        name: 'Renamed Firstmate session',
        sessionPath: fixture.sessionPath,
      }),
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { name: 'Renamed Firstmate session' })
    const request = fixture.managerRequests.find(({ action }) => action === 'rename')
    assert.deepEqual(request, {
      action: 'rename',
      cwd: fixture.workspace,
      id: request?.id,
      name: 'Renamed Firstmate session',
      sessionPath: fixture.sessionPath,
    })
  })
})

async function createBackendFixture(): Promise<BackendFixture> {
  const root = await mkdtemp(join(tmpdir(), 'livecraft-backend-sessions-'))
  const workspacePath = join(root, 'workspace')
  const workspaceOverride = join(root, 'firstmate-workspace-link')
  const standardAgentDirectory = join(root, 'standard-agent')
  const firstmateAgentDirectory = join(root, 'firstmate-agent')
  const firstmateSessionDirectory = join(firstmateAgentDirectory, 'sessions', 'workspace')
  const standardSessionDirectory = join(standardAgentDirectory, 'sessions', 'workspace')
  await Promise.all([
    mkdir(workspacePath),
    mkdir(standardSessionDirectory, { recursive: true }),
    mkdir(firstmateSessionDirectory, { recursive: true }),
  ])
  await symlink(workspacePath, workspaceOverride, process.platform === 'win32' ? 'junction' : 'dir')
  const workspace = await realpath(workspacePath)
  assert.notEqual(workspaceOverride, workspace)
  assert.equal(await realpath(workspaceOverride), workspace)
  const sessionPath = join(firstmateSessionDirectory, 'firstmate.jsonl')
  const genericSessionPath = join(standardSessionDirectory, 'generic.jsonl')
  await Promise.all([
    writeSession(sessionPath, workspace, 'firstmate-session', 'Firstmate session'),
    writeSession(genericSessionPath, workspace, 'generic-session', 'Generic session'),
  ])

  const managerRequests: Array<Record<string, unknown>> = []
  const managerServer = createServer((socket) => {
    const decoder = new JsonLineDecoder((value) => {
      if (!isObject(value) || typeof value.id !== 'string' || typeof value.action !== 'string')
        return
      managerRequests.push(value)
      const data = value.action === 'status'
        ? {
          instanceId: 'test-manager',
          startedAt: '2026-07-19T10:00:00.000Z',
          runtimeRevision: null,
          supervised: false,
        }
        : value.action === 'open_preset'
        ? { sessionId: 'opened-firstmate' }
        : value.action === 'open'
        ? { sessionId: 'opened-generic' }
        : {}
      socket.write(encodeJsonLine({ kind: 'response', id: value.id, ok: true, data }))
    })
    socket.on('data', (chunk) => decoder.push(chunk))
    socket.on('end', () => decoder.end())
  })
  await listen(managerServer)
  const managerPort = serverPort(managerServer)
  const backendPort = await reservePort()
  const backend = spawn(process.execPath, ['server/backend.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: standardAgentDirectory,
      PI_LIVECRAFT_BACKEND_PORT: String(backendPort),
      PI_LIVECRAFT_FIRSTMATE_AGENT_DIR: firstmateAgentDirectory,
      PI_LIVECRAFT_FIRSTMATE_WORKSPACE: workspaceOverride,
      PI_LIVECRAFT_MANAGER_PORT: String(managerPort),
    },
  })
  let output = ''
  backend.stdout.on('data', (chunk) => output += String(chunk))
  backend.stderr.on('data', (chunk) => output += String(chunk))
  const baseUrl = `http://${host}:${String(backendPort)}`

  try {
    await waitForBackend(baseUrl, backend, () => output)
  } catch (error) {
    await stopChild(backend)
    await closeServer(managerServer)
    await rm(root, { recursive: true, force: true })
    throw error
  }

  return {
    baseUrl,
    genericSessionPath: await realpath(genericSessionPath),
    managerRequests,
    sessionPath: await realpath(sessionPath),
    workspace,
    close: async () => {
      await stopChild(backend)
      await closeServer(managerServer)
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function writeSession(
  path: string,
  workspace: string,
  id: string,
  name: string,
): Promise<void> {
  await writeFile(
    path,
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id,
        timestamp: '2026-07-19T10:00:00.000Z',
        cwd: workspace,
      }),
      JSON.stringify({ type: 'session_info', name }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-07-19T10:00:00.000Z',
        message: { role: 'user', content: name },
      }),
    ]
      .join('\n'),
  )
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

async function reservePort(): Promise<number> {
  const server = createServer()
  await listen(server)
  const port = serverPort(server)
  await closeServer(server)
  return port
}

function serverPort(server: Server): number {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address')
  return address.port
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), delay(2_000)])
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await once(child, 'exit')
  }
}

async function waitForBackend(
  baseUrl: string,
  child: ChildProcessWithoutNullStreams,
  output: () => string,
): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Backend exited early:\n${output()}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(250) })
      if (response.status === 200) return
    } catch {
      // The backend may still be binding its port or connecting to the fake manager.
    }
    await delay(50)
  }
  throw new Error(`Backend did not become ready:\n${output()}`)
}
