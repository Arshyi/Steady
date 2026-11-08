/** Coalesce writes without acknowledging data before the database commits it. */
export function createBatchWriter<T>(
  write: (rows: T[]) => Promise<void>,
  { delayMs = 3000, maxBatchSize = 1000, maxQueued = 10_000 } = {},
) {
  type Entry = { row: T; resolve: () => void; reject: (error: unknown) => void }
  const pending: Entry[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let writing = false

  function schedule() {
    if (!writing && !timer && pending.length) timer = setTimeout(flush, delayMs)
  }

  async function flush() {
    timer = undefined
    if (writing || !pending.length) return
    writing = true
    const batch = pending.splice(0, maxBatchSize)
    try {
      await write(batch.map((entry) => entry.row))
      batch.forEach((entry) => entry.resolve())
    } catch (error) {
      // The sender retains responsibility for retrying until it receives success.
      batch.forEach((entry) => entry.reject(error))
    } finally {
      writing = false
      schedule()
    }
  }

  return (row: T): Promise<void> => {
    if (pending.length >= maxQueued) return Promise.reject(new Error('Reading queue is full; retry later'))
    return new Promise<void>((resolve, reject) => {
      pending.push({ row, resolve, reject })
      schedule()
    })
  }
}
