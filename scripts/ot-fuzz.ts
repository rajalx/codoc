/**
 * CoDoc OT fuzz tester.
 *
 * Three levels of verification:
 *  1. Algebraic law of transformLists on thousands of random op-list pairs.
 *  2. Full protocol simulation: N virtual clients running the REAL OTClient
 *     class against a virtual server running the REAL transformAgainstLog,
 *     with random edit bursts and random per-message network delays.
 *     At the end every client and the server must hold identical text.
 *  3. Deterministic replay: each simulation has its own seed, so a failure
 *     can be re-run with full event logging to find the root cause.
 *
 * Run: bun scripts/ot-fuzz.ts [sims]
 */
import {
  Op,
  OTClient,
  applyOps,
  diffToOps,
  transformAgainstLog,
  transformLists,
  transformPosition,
} from '../src/lib/ot-core'

/* ---------------- seeded PRNG ---------------- */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
type Rnd = () => number
const mkRi = (rnd: Rnd) => (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1))
const CHARS = 'abcdefgh \nXY'

function randomText(rnd: Rnd, len: number): string {
  const ri = mkRi(rnd)
  let s = ''
  for (let i = 0; i < len; i++) s += CHARS[ri(0, CHARS.length - 1)]
  return s
}

/** A realistic user edit: type a word, paste a blob, or delete a few chars. */
function randomEdit(rnd: Rnd, text: string): Op[] {
  const ri = mkRi(rnd)
  const kind = rnd()
  if (kind < 0.6) {
    const pos = ri(0, text.length)
    return [{ type: 'insert', pos, text: randomText(rnd, ri(1, 5)) }]
  }
  if (kind < 0.75) {
    const pos = ri(0, text.length)
    return [{ type: 'insert', pos, text: randomText(rnd, ri(6, 30)) }] // big paste
  }
  if (text.length === 0) return []
  const pos = ri(0, text.length - 1)
  const n = ri(1, Math.min(6, text.length - pos))
  const ops: Op[] = []
  for (let i = 0; i < n; i++) ops.push({ type: 'delete', pos, len: 1 })
  return ops
}

/* ---------------- Part 1: transformLists algebraic law ---------------- */
function testTransformLaw(iterations: number): number {
  const rnd = mulberry32(42)
  let failures = 0
  for (let it = 0; it < iterations; it++) {
    const base = randomText(rnd, mkRi(rnd)(0, 40))
    const A: Op[] = []
    const B: Op[] = []
    let ta = base
    let tb = base
    for (let i = 0; i < mkRi(rnd)(1, 6); i++) {
      const ops = randomEdit(rnd, ta)
      ta = applyOps(ta, ops)
      A.push(...ops)
    }
    for (let i = 0; i < mkRi(rnd)(1, 6); i++) {
      const ops = randomEdit(rnd, tb)
      tb = applyOps(tb, ops)
      B.push(...ops)
    }
    const [A2, B2] = transformLists(A, B)
    const left = applyOps(applyOps(base, A), B2)
    const right = applyOps(applyOps(base, B), A2)
    if (left !== right) {
      failures++
      if (failures <= 3) {
        console.error(`LAW FAILURE #${failures}\n base=${JSON.stringify(base)}\n A=`, A, `\n B=`, B, `\n A2=`, A2, `\n B2=`, B2)
      }
    }
  }
  return failures
}

/* ---------------- Part 2: full protocol simulation ---------------- */
interface Msg {
  deliverAt: number
  ops?: Op[]
  base?: number
  version?: number
}

interface SimServer {
  text: string
  revision: number
  log: Op[][] // log[i] produced revision i+1
}

interface SimResult {
  ok: boolean
  detail?: string
}

/**
 * Network model: socket.io guarantees FIFO delivery per connection, and the
 * OT protocol relies on that (remote ops + acks must arrive in server order).
 * So each client has its own ordered inbox/outbox; only the DELAY is random.
 */
function runSimulation(seed: number, logging: boolean): SimResult {
  const rnd = mulberry32(seed)
  const ri = mkRi(rnd)
  const log = (...args: unknown[]) => {
    if (logging) console.log(...args)
  }

  const nClients = ri(2, 3)
  const server: SimServer = { text: randomText(rnd, ri(0, 25)), revision: 0, log: [] }
  const clients: OTClient[] = []
  const texts: string[] = []
  const toServer: Msg[][] = [] // per-client FIFO (client -> server)
  const toClient: Msg[][] = [] // per-client FIFO (server -> client)
  for (let i = 0; i < nClients; i++) {
    texts[i] = server.text
    toServer[i] = []
    toClient[i] = []
    clients.push(
      new OTClient(server.text, 0, {
        onUpdate: (t) => {
          texts[i] = t
        },
        onSend: (ops, base) => {
          log(`t${tick} c${i} SEND`, JSON.stringify(ops), `base=${base}`)
          toServer[i].push({ deliverAt: tick + ri(0, 12), ops, base })
        },
      })
    )
  }
  log(`=== sim seed=${seed} clients=${nClients} base=${JSON.stringify(server.text)}`)

  let tick = 0
  const totalTicks = 60

  const pendingWork = () =>
    toServer.some((q) => q.length > 0) || toClient.some((q) => q.length > 0) || clients.some((c) => c.pending)

  while (tick < totalTicks || pendingWork()) {
    // Random typing bursts
    if (tick < totalTicks) {
      for (let i = 0; i < nClients; i++) {
        if (rnd() < 0.4) {
          const ops = randomEdit(rnd, texts[i])
          if (ops.length === 0) continue
          const newText = applyOps(texts[i], ops)
          log(`t${tick} c${i} TYPE`, JSON.stringify(ops))
          clients[i].localChange(newText)
        }
      }
    }

    // Deliver client->server heads (per-client FIFO, random delay).
    for (let i = 0; i < nClients; i++) {
      while (toServer[i].length > 0 && toServer[i][0].deliverAt <= tick) {
        const m = toServer[i].shift()!
        const base = m.base ?? 0
        if (base > server.revision) {
          return { ok: false, detail: `protocol violation (base ${base} > rev ${server.revision})` }
        }
        const missed = server.log.slice(base)
        const transformed = transformAgainstLog(m.ops ?? [], missed)
        server.text = applyOps(server.text, transformed)
        server.revision++
        server.log.push(transformed)
        log(`t${tick} SERVER apply c${i} ->`, JSON.stringify(transformed), `rev=${server.revision}`)
        for (let j = 0; j < nClients; j++) {
          if (j === i) {
            toClient[j].push({ deliverAt: tick + ri(0, 8), version: server.revision })
          } else {
            toClient[j].push({ deliverAt: tick + ri(0, 8), ops: transformed, version: server.revision })
          }
        }
      }
    }

    // Deliver server->client heads (per-client FIFO preserves server order).
    for (let j = 0; j < nClients; j++) {
      while (toClient[j].length > 0 && toClient[j][0].deliverAt <= tick) {
        const m = toClient[j].shift()!
        if (m.ops) {
          if (m.version !== clients[j].revision + 1) {
            return { ok: false, detail: `out-of-order delivery to client ${j} (got v${m.version}, expected v${clients[j].revision + 1})` }
          }
          log(`t${tick} c${j} RECV op`, JSON.stringify(m.ops), `v${m.version}`)
          clients[j].remoteOps(m.ops, m.version!)
        } else {
          log(`t${tick} c${j} ACK v${m.version}`)
          clients[j].ack(m.version!)
        }
      }
    }

    tick++
    if (tick > 5000) {
      return { ok: false, detail: 'livelock' }
    }
  }

  // Final check: everyone converged.
  for (let i = 0; i < nClients; i++) {
    if (texts[i] !== server.text) {
      return {
        ok: false,
        detail: `DIVERGENCE client ${i}\n  server=${JSON.stringify(server.text)}\n  client=${JSON.stringify(texts[i])}`,
      }
    }
    if (clients[i].revision !== server.revision) {
      return { ok: false, detail: `revision mismatch client ${i}: ${clients[i].revision} vs ${server.revision}` }
    }
  }
  return { ok: true }
}

/* ---------------- Part 3: sanity of diffToOps + transformPosition ---------------- */
function testSanity(iterations: number): number {
  const rnd = mulberry32(7)
  const ri = mkRi(rnd)
  let failures = 0
  for (let it = 0; it < iterations; it++) {
    const a = randomText(rnd, ri(0, 40))
    const b = randomText(rnd, ri(0, 40))
    if (applyOps(a, diffToOps(a, b)) !== b) {
      failures++
      console.error('diffToOps failure', JSON.stringify(a), '->', JSON.stringify(b))
    }
    const ops = randomEdit(rnd, a)
    const pos = ri(0, a.length)
    const np = transformPosition(pos, ops)
    const after = applyOps(a, ops)
    if (np < 0 || np > after.length) {
      failures++
      console.error('transformPosition out of range', pos, ops)
    }
  }
  return failures
}

/* ---------------- run ---------------- */
const argSims = Number(process.argv[2] ?? 500)
console.log(`CoDoc OT fuzz\n`)
const lawFails = testTransformLaw(20000)
console.log(`transformLists law: 20000 cases, ${lawFails} failures`)
const sanityFails = testSanity(20000)
console.log(`diffToOps/position sanity: 20000 cases, ${sanityFails} failures`)

let simFails = 0
const failedSeeds: number[] = []
for (let s = 0; s < argSims; s++) {
  const seed = 100000 + s
  const r = runSimulation(seed, false)
  if (!r.ok) {
    simFails++
    failedSeeds.push(seed)
  }
  if (s % 100 === 99) console.log(`  simulations: ${s + 1}/${argSims} done (${simFails} failures so far)`)
}
console.log(`protocol simulations: ${argSims} runs, ${simFails} failures`)
if (failedSeeds.length > 0) {
  console.log(`failing seeds: ${failedSeeds.slice(0, 10).join(', ')}${failedSeeds.length > 10 ? ' ...' : ''}`)
  // Deterministically replay the first failure with full logging.
  console.log(`\n--- replaying seed ${failedSeeds[0]} with logging ---`)
  const r = runSimulation(failedSeeds[0], true)
  console.log(r.detail ?? 'unexpectedly passed')
}

if (lawFails + sanityFails + simFails === 0) {
  console.log('\nALL FUZZ TESTS PASSED — OT engine converges.')
  process.exit(0)
} else {
  console.log('\nFUZZ FAILURES DETECTED')
  process.exit(1)
}
