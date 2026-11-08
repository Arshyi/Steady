import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createConnectionSession } from '../src/hardware/connection-session.ts'

function device() {
  let disconnects = 0
  const connection = {
    transport: 'simulated',
    identify: async () => {},
    disconnect: async () => { disconnects++ },
  }
  return { connection, disconnects: () => disconnects }
}

test('leaving Settings disconnects the device and ignores queued sensor events', async () => {
  const session = createConnectionSession()
  const attempt = session.begin()
  const d = device()
  let samples = 0
  const receive = attempt.guard(() => { samples++ })
  await attempt.attach(d.connection)
  receive()
  session.close()
  receive()
  assert.equal(samples, 1)
  assert.equal(d.disconnects(), 1)
})

test('a connection completing after navigation is immediately disconnected', async () => {
  const session = createConnectionSession()
  const attempt = session.begin()
  session.close()
  const d = device()
  assert.equal(await attempt.attach(d.connection), false)
  assert.equal(d.disconnects(), 1)
})

test('old disconnect callbacks cannot release a newer device connection', async () => {
  const session = createConnectionSession()
  const first = session.begin()
  const oldDevice = device()
  await first.attach(oldDevice.connection)
  const second = session.begin()
  const newDevice = device()
  await second.attach(newDevice.connection)
  first.disconnected()
  session.close()
  assert.equal(oldDevice.disconnects(), 1)
  assert.equal(newDevice.disconnects(), 1)
})
