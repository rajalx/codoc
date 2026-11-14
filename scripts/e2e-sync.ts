/**
 * Live integration test for the sync service: two real socket.io clients
 * running the REAL OTClient controller (the exact class the browser uses),
 * typing concurrently at the same spot without waiting for acks.
 *
 * Run: bun scripts/e2e-sync.ts [docId]
 */
import { io } from 'socket.io-client'
import { Op, OTClient, applyOps } from '../src/lib/ot-core'

const URL = 'http://localhost:3003'

// Seeded PRNG for reproducible delete positions.
let rngState = 12345
function rng() {
  rngState = (rngState * 1103515245 + 12345) & 0x7fffffff
  return rngState / 0x7fffffff
}

interface TestClient {
  name: string
  socket: ReturnType<typeof io>
  ot: OTClient
  joined: boolean
}

function makeClient(name: string, color: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = io(URL, { path: '/', transports: ['websocket'] })
    const c: TestClient = { name, socket, ot: null as unknown as OTClient, joined: false }
    socket.on('doc:init', (data: { text: string; revision: number }) => {
      if (c.ot) {
        // Reconnect / re-join: merge unsent local edits back on top.
        const myText = c.ot.text
        const hadPending = c.ot.pending
        c.ot = new OTClient(data.text, data.revision, hooks)
        if (hadPending && myText !== data.text) c.ot.localChange(myText)
        return
      }
      c.ot = new OTClient(data.text, data.revision, hooks)
      c.joined = true
    })
    const hooks = {
      onUpdate: () => {},
      onSend: (ops: Op[], base: number) => {
        socket.emit('doc:op', { ops, base })
      },
    }
    socket.on('doc:op', (data: { ops: Op[]; version: number }) => {
      c.ot?.remoteOps(data.ops, data.version)
    })
    socket.on('doc:ack', (data: { version: number }) => {
      c.ot?.ack(data.version)
    })
    socket.on('connect', () => resolve(c))
    socket.on('connect_error', (err: Error) => reject(err))
  })
}

async function waitFor(cond: () => boolean, timeoutMs = 5000, what: string): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function main() {
  const DOC = process.argv[2] ?? 'test-doc-1'

  const a = await makeClient('Alice', '#10b981')
  const b = await makeClient('Bob', '#f43f5e')
  a.socket.emit('doc:join', { docId: DOC, name: 'Alice', color: '#10b981' })
  b.socket.emit('doc:join', { docId: DOC, name: 'Bob', color: '#f43f5e' })
  await waitFor(() => a.joined && b.joined, 5000, 'doc:init')
  console.log(`init  Alice: ${JSON.stringify(a.ot.text)} rev=${a.ot.revision}`)
  console.log(`init  Bob  : ${JSON.stringify(b.ot.text)} rev=${b.ot.revision}`)
  if (a.ot.text !== b.ot.text) throw new Error('init texts differ')

  // Concurrent burst: both type at the same spot; acks are NOT awaited, so
  // ops buffer client-side exactly like a fast human typist.
  const n = 30
  for (let i = 0; i < n; i++) {
    a.ot.localChange(applyOps(a.ot.text, [{ type: 'insert', pos: 0, text: `A${i} ` }]))
    b.ot.localChange(applyOps(b.ot.text, [{ type: 'insert', pos: 0, text: `B${i} ` }]))
  }
  // Also throw in some deletes in the middle of the chaos.
  for (let i = 0; i < 10; i++) {
    const posA = Math.floor(rng() * Math.max(1, a.ot.text.length - 1))
    a.ot.localChange(applyOps(a.ot.text, [{ type: 'delete', pos: posA, len: 1 }]))
    const posB = Math.floor(rng() * Math.max(1, b.ot.text.length - 1))
    b.ot.localChange(applyOps(b.ot.text, [{ type: 'delete', pos: posB, len: 1 }]))
  }

  await waitFor(() => !a.ot.pending && !b.ot.pending, 8000, 'all acks')
  await new Promise((r) => setTimeout(r, 500))

  console.log(`done  Alice: ${JSON.stringify(a.ot.text.slice(0, 60))}... rev=${a.ot.revision} len=${a.ot.text.length}`)
  console.log(`done  Bob  : ${JSON.stringify(b.ot.text.slice(0, 60))}... rev=${b.ot.revision} len=${b.ot.text.length}`)

  if (a.ot.text !== b.ot.text) {
    const t1 = a.ot.text
    const t2 = b.ot.text
    let i = 0
    while (i < Math.min(t1.length, t2.length) && t1[i] === t2[i]) i++
    console.error(`FAIL: clients diverged at index ${i} (lens ${t1.length} vs ${t2.length})`)
    console.error(`  Alice: ...${JSON.stringify(t1.slice(Math.max(0, i - 25), i + 25))}`)
    console.error(`  Bob  : ...${JSON.stringify(t2.slice(Math.max(0, i - 25), i + 25))}`)
    process.exit(1)
  }
  if (a.ot.revision !== b.ot.revision) {
    console.error(`FAIL: revisions differ (${a.ot.revision} vs ${b.ot.revision})`)
    process.exit(1)
  }
  console.log(`PASS: converged at rev ${a.ot.revision}, ${a.ot.text.length} chars`)

  // Cursor relay check
  const cursorEvents: Array<{ id: string; pos: number }> = []
  b.socket.on('doc:cursor', (d: { id: string; pos: number }) => cursorEvents.push(d))
  a.socket.emit('doc:cursor', { pos: 5 })
  await new Promise((r) => setTimeout(r, 300))
  if (cursorEvents.length === 0 || cursorEvents[0].pos !== 5) {
    console.error('FAIL: cursor relay broken', cursorEvents)
    process.exit(1)
  }
  console.log('PASS: cursor relay works')

  // Presence check: Alice should see Bob in the user list
  const presence: Array<{ users: Array<{ name: string }> }> = []
  a.socket.on('doc:presence', (d) => presence.push(d))
  b.socket.disconnect()
  await new Promise((r) => setTimeout(r, 400))
  const last = presence[presence.length - 1]
  if (!last || last.users.some((u) => u.name === 'Bob')) {
    console.error('FAIL: presence did not update on disconnect', last)
    process.exit(1)
  }
  console.log('PASS: presence updates on disconnect')

  a.socket.disconnect()
  process.exit(0)
}

main().catch((err) => {
  console.error('E2E sync test failed:', err.message)
  process.exit(1)
})
