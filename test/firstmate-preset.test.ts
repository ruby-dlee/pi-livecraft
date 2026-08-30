import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  commandOwnsPiSession,
  FIRSTMATE_PRESET_ID,
  firstmatePreset,
} from '../server/firstmate-preset.ts'

test('defines the constrained production Firstmate launch preset', () => {
  assert.deepEqual(firstmatePreset({}), {
    id: FIRSTMATE_PRESET_ID,
    workspace: '/Users/dongkeun/firstmate',
    fmHome: '/mnt/task/.fm-return',
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

test('exposes livecraft without removing the pi-livecraft command', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
    bin?: Record<string, string>
  }
  assert.deepEqual(packageJson.bin, {
    livecraft: './bin/pi-livecraft.mjs',
    'pi-livecraft': './bin/pi-livecraft.mjs',
  })
})
