import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  commandMayOwnPiWorkspace,
  commandOwnsPiSession,
  externalPiSessionOwner,
  FIRSTMATE_PRESET_ID,
  firstmatePreset,
} from '../server/firstmate-preset.ts'

test('defines the constrained production Firstmate launch preset', () => {
  assert.deepEqual(firstmatePreset({}), {
    id: FIRSTMATE_PRESET_ID,
    workspace: '/Users/dongkeun/firstmate',
    fmHome: '/Users/dongkeun/firstmate-home',
    agentDirectory: '/Users/dongkeun/.pi/firstmate-local',
    sessionDirectory: '/Users/dongkeun/.pi/firstmate-local/sessions',
    extensions: [
      '/Users/dongkeun/firstmate/.pi/extensions/fm-primary-turnend-guard.ts',
      '/Users/dongkeun/firstmate/.pi/extensions/fm-primary-pi-watch.ts',
    ],
  })
})

test('accepts only trusted launcher environment configuration for preset paths', () => {
  assert.deepEqual(
    firstmatePreset({
      PI_LIVECRAFT_FIRSTMATE_WORKSPACE: '/test/workspace',
      PI_LIVECRAFT_FIRSTMATE_HOME: '/test/home',
      PI_LIVECRAFT_FIRSTMATE_AGENT_DIR: '/test/profile',
      PI_LIVECRAFT_FIRSTMATE_TURNEND_GUARD: '/test/guard.ts',
      PI_LIVECRAFT_FIRSTMATE_PI_WATCH: '/test/watch.ts',
    }),
    {
      id: FIRSTMATE_PRESET_ID,
      workspace: '/test/workspace',
      fmHome: '/test/home',
      agentDirectory: '/test/profile',
      sessionDirectory: '/test/profile/sessions',
      extensions: ['/test/guard.ts', '/test/watch.ts'],
    },
  )
})

test('recognizes only an explicit persisted-session argument', () => {
  const sessionPath = '/profile/sessions/primary session.jsonl'
  assert.equal(
    commandOwnsPiSession(`node pi --mode rpc --session "${sessionPath}"`, sessionPath),
    true,
  )
  assert.equal(commandOwnsPiSession(`pi --session='${sessionPath}'`, sessionPath), true)
  assert.equal(commandOwnsPiSession(`pi -s "${sessionPath}"`, sessionPath), true)
  assert.equal(commandOwnsPiSession(`grep '${sessionPath}' process.log`, sessionPath), false)
  assert.equal(
    commandOwnsPiSession('pi --session /profile/sessions/other.jsonl', sessionPath),
    false,
  )
})

test('recognizes bare and continuing Pi commands as implicit cwd owners', () => {
  assert.equal(commandMayOwnPiWorkspace('pi'), true)
  assert.equal(commandMayOwnPiWorkspace('/usr/local/bin/pi -c'), true)
  assert.equal(commandMayOwnPiWorkspace('node /usr/local/bin/pi --continue'), true)
  assert.equal(
    commandMayOwnPiWorkspace(
      'node /opt/pi-coding-agent/dist/bundle/cli.js --mode rpc --continue',
    ),
    true,
  )
  assert.equal(commandMayOwnPiWorkspace('pi --session /tmp/other.jsonl'), false)
  assert.equal(commandMayOwnPiWorkspace('pi --session-id new-session'), false)
  assert.equal(commandMayOwnPiWorkspace('pi --help'), false)
  assert.equal(commandMayOwnPiWorkspace('grep pi'), false)
})

test(
  'finds an unmanaged bare Pi cwd owner while excluding managed PIDs and unrelated cwd',
  { skip: process.platform === 'win32', timeout: 10_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'livecraft-firstmate-owner-'))
    const workspace = join(root, 'workspace')
    const workspaceAlias = join(root, 'workspace-alias')
    const unrelatedWorkspace = join(root, 'unrelated')
    await Promise.all([mkdir(workspace), mkdir(unrelatedWorkspace)])
    await symlink(workspace, workspaceAlias)
    const child = spawn('/bin/cat', [], {
      argv0: 'pi',
      cwd: workspaceAlias,
      stdio: ['pipe', 'ignore', 'ignore'],
    })

    try {
      await once(child, 'spawn')
      assert.equal(
        await externalPiSessionOwner(undefined, workspace),
        child.pid,
      )
      assert.equal(
        await externalPiSessionOwner(undefined, workspace, new Set([child.pid!])),
        undefined,
      )
      assert.equal(
        await externalPiSessionOwner(undefined, unrelatedWorkspace),
        undefined,
      )
    } finally {
      await terminate(child)
      await rm(root, { recursive: true, force: true })
    }
  },
)

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  await exited
}

test('exposes livecraft without removing the pi-livecraft command', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
    bin?: Record<string, string>
  }
  assert.deepEqual(packageJson.bin, {
    livecraft: './bin/pi-livecraft.mjs',
    'pi-livecraft': './bin/pi-livecraft.mjs',
  })
})
