// Run the actual Python simulator and read its wire protocol with Node's
// independent WebSocket implementation. No board, browser, or backend required.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const simulator = fileURLToPath(new URL('./simulator.py', import.meta.url))
const child = spawn(process.env.PYTHON ?? 'python', ['-u', simulator, '--port', '0', '--fall-every', '1'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
})
let ws
let errors = ''
child.stderr.on('data', (data) => { errors += data })
const deadline = AbortSignal.timeout(8000)
try {
  const url = await new Promise((resolve, reject) => {
    let output = ''
    deadline.addEventListener('abort', () => reject(new Error(`Simulator timed out: ${errors}`)), { once: true })
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`Simulator exited ${code}: ${errors}`)))
    child.stdout.on('data', (data) => {
      output += data
      const match = output.match(/serving (ws:\/\/127\.0\.0\.1:\d+)/)
      if (match) resolve(match[1])
    })
  })
  let samples = 0
  let info = false
  let fall = false
  const started = performance.now()
  await new Promise((resolve, reject) => {
    deadline.addEventListener('abort', () => reject(new Error(`Protocol timed out: ${samples} samples, info=${info}, fall=${fall}`)), { once: true })
    ws = new WebSocket(url)
    ws.addEventListener('open', () => ws.send('I?\n'))
    ws.addEventListener('error', reject)
    ws.addEventListener('message', ({ data }) => {
      try {
        for (const line of String(data).trim().split('\n')) {
          const fields = line.split(',')
          if (fields[0] === 'I') {
            assert.equal(fields[1], 'ST-SIM1')
            info = true
          } else if (fields[0] === 'M') {
            assert.equal(fields.length, 7)
            assert.ok(fields.slice(1).map(Number).every(Number.isFinite))
            samples++
          } else if (fields[0] === 'F') {
            fall = true
          }
        }
        if (info && fall && samples >= 50) resolve()
      } catch (error) { reject(error) }
    })
  })
  console.log(JSON.stringify({ passed: true, identity: 'ST-SIM1', samples, fall,
    elapsed_ms: Math.round(performance.now() - started),
    scope: 'Python simulator -> real WebSocket -> host client; no MCU/Bridge or physical validation' }, null, 2))
} finally {
  ws?.close()
  if (child.exitCode === null) {
    const exited = once(child, 'exit')
    child.kill()
    await exited
  }
}
