import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

let write
mock.module('./databricks.ts', {
  namedExports: { SCHEMA: 'test.steady', lit: JSON.stringify, sql: (...args) => write(...args) },
})
mock.module('./schema.ts', {
  namedExports: {
    residentSeeds: [{ id: '1', simDevice: 'SIM-1' }],
    insertAlerts: async () => {},
  },
})
const { startSimulator, stopSimulator } = await import('./simulator.ts')
const turn = () => new Promise((resolve) => setImmediate(resolve))

test('stopping while a write is pending cannot revive the simulator', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let finish
  let calls = 0
  write = async () => {
    calls++
    await new Promise((resolve) => { finish = resolve })
  }
  startSimulator()
  t.mock.timers.tick(1)
  assert.equal(calls, 1)
  stopSimulator()
  finish()
  await turn()
  t.mock.timers.tick(60_000)
  assert.equal(calls, 1)
})

test('restarting during an old write leaves exactly one active loop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let finishOld
  let calls = 0
  write = async () => {
    if (++calls === 1) await new Promise((resolve) => { finishOld = resolve })
  }
  startSimulator()
  t.mock.timers.tick(1)
  stopSimulator()
  startSimulator()
  t.mock.timers.tick(1)
  await turn()
  assert.equal(calls, 2)
  finishOld()
  await turn()
  t.mock.timers.tick(5000)
  await turn()
  assert.equal(calls, 3)
  stopSimulator()
})
