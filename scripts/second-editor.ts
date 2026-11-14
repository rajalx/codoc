/**
 * Second-editor simulation: connects like a real browser window, joins the
 * same doc, types a phrase, moves its cursor around. Used to verify the
 * in-browser experience of live collaboration.
 *
 * Run: bun scripts/second-editor.ts <docId> [text]
 */
import { io } from 'socket.io-client'
import { Op, OTClient } from '../src/lib/ot-core'

const URL = 'http://localhost:3003'

async function main() {
  const docId = process.argv[2]
  if (!docId) throw new Error('usage: second-editor.ts <docId> [text]')
  const phrase = process.argv[3] ?? 'Hello from the second editor! '

  const textRef = { current: '' }
  const socket = io(URL, { path: '/', transports: ['websocket'] })

  const ot = new OTClient('', 0, {
    onUpdate: (t) => {
      textRef.current = t
    },
    onSend: (ops: Op[], base: number) => socket.emit('doc:op', { ops, base }),
  })

  await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => resolve())
    socket.on('connect_error', reject)
  })
  socket.emit('doc:join', { docId, name: 'Second Editor', color: '#f43f5e' })

  await new Promise<void>((resolve) => {
    socket.on('doc:init', (data: { text: string; revision: number }) => {
      ot.reset(data.text, data.revision)
      resolve()
    })
  })
  socket.on('doc:op', (d: { ops: Op[]; version: number }) => ot.remoteOps(d.ops, d.version))
  socket.on('doc:ack', (d: { version: number }) => ot.ack(d.version))

  // Type the phrase character by character near the top of the document.
  for (const ch of phrase) {
    const insertAt = Math.min(ot.text.length, 25)
    const before = ot.text.slice(0, insertAt)
    const after = ot.text.slice(insertAt)
    ot.localChange(before + ch + after)
    socket.emit('doc:cursor', { pos: insertAt + 1 })
    await new Promise((r) => setTimeout(r, 30))
  }

  // Wait until all acks are in.
  for (let i = 0; i < 100 && ot.pending; i++) {
    await new Promise((r) => setTimeout(r, 50))
  }
  await new Promise((r) => setTimeout(r, 400))

  console.log('SECOND EDITOR FINAL TEXT (first 120):', JSON.stringify(ot.text.slice(0, 120)))
  console.log('SECOND EDITOR revision:', ot.revision, 'pending:', ot.pending)

  // Keep the connection open briefly so the browser can see the cursor.
  await new Promise((r) => setTimeout(r, 2500))
  socket.disconnect()
  process.exit(0)
}

main().catch((err) => {
  console.error('second-editor failed:', err.message)
  process.exit(1)
})
