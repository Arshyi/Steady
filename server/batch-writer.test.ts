import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBatchWriter } from './batch-writer.ts'

const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

test('a successful response waits for the shared database batch to commit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let commit!: () => void
  const batches: number[][] = []
  const put = createBatchWriter<number>(async (rows) => {
    batches.push(rows)
    await new Promise<void>((resolve) => { commit = resolve })
  })
  let acknowledged = false
  const request = Promise.all([put(1), put(2)]).then(() => { acknowledged = true })
  t.mock.timers.tick(3000)
  await turn()
  assert.deepEqual(batches, [[1, 2]])
  assert.equal(acknowledged, false)
  commit()
  await request
  assert.equal(acknowledged, true)
})

test('database failure reaches the sender and a later retry can succeed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let attempts = 0
  const put = createBatchWriter<number>(async () => {
    if (++attempts === 1) throw new Error('database unavailable')
  })
  const failure = assert.rejects(put(1), /database unavailable/)
  t.mock.timers.tick(3000)
  await failure
  const retry = put(1)
  t.mock.timers.tick(3000)
  await retry
  assert.equal(attempts, 2)
})

test('writes arriving during a slow batch wait rather than overlap it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let finish!: () => void
  const batches: number[][] = []
  const put = createBatchWriter<number>(async (rows) => {
    batches.push(rows)
    if (batches.length === 1) await new Promise<void>((resolve) => { finish = resolve })
  }, { maxBatchSize: 1 })
  const first = put(1)
  t.mock.timers.tick(3000)
  const second = put(2)
  t.mock.timers.tick(30_000)
  assert.deepEqual(batches, [[1]])
  finish()
  await first
  t.mock.timers.tick(3000)
  await second
  assert.deepEqual(batches, [[1], [2]])
})

test('an overloaded queue rejects new readings instead of growing without bound', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const put = createBatchWriter<number>(async () => {}, { maxQueued: 1 })
  const first = put(1)
  await assert.rejects(put(2), /queue is full/)
  t.mock.timers.tick(3000)
  await first
})
