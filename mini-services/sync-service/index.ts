/**
 * CoDoc sync service — the server-authoritative OT engine.
 *
 * A single socket.io process (port 3003) that owns the live state of every
 * open document:
 *   - applies client op batches in arrival order (transforming late batches
 *     forward against everything that happened since their base revision),
 *   - broadcasts the applied ops to every other editor,
 *   - tracks presence (who is in the doc, with what color) and relays cursor
 *     positions,
 *   - persists content + an append-only operation audit log to PostgreSQL,
 *     and cuts version snapshots for the timeline (auto every N ops, on
 *     manual save, and on restore).
 *
 * The OT math lives in ../../src/lib/ot-core.ts — the exact same module the
 * browser runs (verified for convergence by scripts/ot-fuzz.ts).
 */
import { createServer } from 'http'
import { Server, Socket } from 'socket.io'
import { Pool } from 'pg'
import { randomUUID } from 'crypto'
import {
  Op,
  applyOps,
  isOp,
  transformAgainstLog,
} from '../../src/lib/ot-core'

const PORT = 3003
const LOG_CAP = 2000 // max retained op batches per doc for late transforms
const SNAPSHOT_EVERY_OPS = 40
const FLUSH_INTERVAL_MS = 900
const MAX_INSERT_CHARS = 5000
const MAX_BATCH_OPS = 2000

/* ------------------------------------------------------------------ */
/* Database                                                            */
/* ------------------------------------------------------------------ */

// Explicit config with env override: reads DATABASE_URL when it is a
// PostgreSQL URL (local dev, .env — supports passwords/custom hosts), and
// otherwise falls back to the sandbox default. The check matters because the
// sandbox exports a stale sqlite DATABASE_URL pointing at a file, which we
// must never use here.
function pgPoolConfig() {
  const url = process.env.DATABASE_URL
  if (url && /^postgres(ql)?:\/\//.test(url)) {
    try {
      const u = new URL(url)
      return {
        host: u.hostname || '127.0.0.1',
        port: Number(u.port) || 5432,
        user: decodeURIComponent(u.username) || 'postgres',
        ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
        database: u.pathname.replace(/^\//, '') || 'codoc',
      }
    } catch {
      // malformed URL -> fall through to defaults
    }
  }
  // Same reasoning as src/lib/db.ts: warn loudly when falling back, because
  // a password-protected PostgreSQL (e.g. Docker) will reject the passwordless
  // default with an auth failure.
  console.warn(
    '[db] DATABASE_URL is missing or not a postgres:// URL — ' +
      'using passwordless default postgres@127.0.0.1:5432/codoc.\n' +
      '     If your PostgreSQL requires a password, set DATABASE_URL in the ' +
      "project root .env (e.g. postgresql://postgres:PASSWORD@localhost:5432/codoc) " +
      'and restart this service from the project root so the .env is found.'
  )
  return { host: '127.0.0.1', port: 5432, user: 'postgres', database: 'codoc' }
}

const pool = new Pool({
  ...pgPoolConfig(),
  max: 10,
  idleTimeoutMillis: 30000,
})

pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message)
})

/* ------------------------------------------------------------------ */
/* In-memory document registry                                         */
/* ------------------------------------------------------------------ */

interface PresenceUser {
  id: string // socket id
  name: string
  color: string
  pos: number | null // last known caret position
}

interface DocState {
  id: string
  title: string
  text: string
  revision: number
  /** log[i] produced revision logBase + i + 1. Used to transform late ops. */
  log: Op[][]
  logBase: number
  dirty: boolean
  pendingOpRows: { revision: number; ops: Op[]; author: string }[]
  opsSinceSnapshot: number
  users: Map<string, PresenceUser> // socket id -> user
}

const docs = new Map<string, DocState>()

async function loadDoc(docId: string): Promise<DocState | null> {
  const cached = docs.get(docId)
  if (cached) return cached
  // Dedup concurrent loads so two simultaneous joiners can't create two
  // separate DocState objects for the same document.
  const inflight = loadingDocs.get(docId)
  if (inflight) return inflight
  const p = (async (): Promise<DocState | null> => {
    try {
      const res = await pool.query(
        'SELECT id, title, content, revision FROM "Document" WHERE id = $1',
        [docId]
      )
      if (res.rowCount === 0) return null
      const row = res.rows[0]
      const doc: DocState = {
        id: row.id,
        title: row.title,
        text: row.content ?? '',
        revision: row.revision ?? 0,
        log: [],
        logBase: row.revision ?? 0,
        dirty: false,
        pendingOpRows: [],
        opsSinceSnapshot: 0,
        users: new Map(),
      }
      docs.set(docId, doc)
      return doc
    } catch (err) {
      console.error(`[db] failed to load doc ${docId}:`, err)
      return null
    } finally {
      loadingDocs.delete(docId)
    }
  })()
  loadingDocs.set(docId, p)
  return p
}

const loadingDocs = new Map<string, Promise<DocState | null>>()

/**
 * Share-key access check for doc:join. Returns true when `name` may open
 * the document: public docs (ownerName "" — e.g. the seeded Welcome doc),
 * the owner themselves, or a user recorded in the Collaborator table
 * (joined via share key). Mirrors the REST API's visibility rules so the
 * socket path is not an access bypass. Unknown documents return true —
 * joinDoc's loadDoc emits the proper "not found" error for those.
 */
async function canJoin(docId: string, name: string): Promise<boolean> {
  try {
    const res = await pool.query('SELECT "ownerName" FROM "Document" WHERE id = $1', [docId])
    if (res.rowCount === 0) return true
    const owner = (res.rows[0].ownerName as string | null) ?? ''
    if (owner === '' || owner === name) return true
    const collab = await pool.query(
      'SELECT 1 FROM "Collaborator" WHERE "documentId" = $1 AND "userName" = $2 LIMIT 1',
      [docId, name]
    )
    return (collab.rowCount ?? 0) > 0
  } catch (err) {
    // Fail closed: the DB is broken, so loadDoc would fail right after
    // anyway — rejecting with a clear message beats a cryptic failure.
    console.error('[auth] access check failed for doc', docId, err)
    return false
  }
}

async function flushDoc(doc: DocState): Promise<void> {
  if (!doc.dirty && doc.pendingOpRows.length === 0) return
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (doc.dirty) {
      await client.query(
        'UPDATE "Document" SET content = $1, revision = $2, "updatedAt" = now() WHERE id = $3',
        [doc.text, doc.revision, doc.id]
      )
      doc.dirty = false
    }
    for (const row of doc.pendingOpRows.splice(0)) {
      await client.query(
        'INSERT INTO "OperationEntry" (id, "documentId", revision, ops, author, "createdAt") VALUES ($1, $2, $3, $4, $5, now())',
        [randomUUID(), doc.id, row.revision, JSON.stringify(row.ops), row.author]
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    console.error(`[db] flush failed for doc ${doc.id}:`, err)
    await client.query('ROLLBACK').catch(() => {})
  } finally {
    client.release()
  }
}

async function createSnapshot(doc: DocState, label: string, author: string): Promise<void> {
  await flushDoc(doc) // make sure the row reflects current content/revision
  try {
    await pool.query(
      'INSERT INTO "DocumentVersion" (id, "documentId", revision, content, label, author, "createdAt") VALUES ($1, $2, $3, $4, $5, $6, now())',
      [randomUUID(), doc.id, doc.revision, doc.text, label, author]
    )
    doc.opsSinceSnapshot = 0
    console.log(`[snapshot] doc ${doc.id} @ rev ${doc.revision} ("${label}" by ${author})`)
  } catch (err) {
    console.error(`[db] snapshot failed for doc ${doc.id}:`, err)
  }
}

setInterval(() => {
  for (const doc of docs.values()) {
    flushDoc(doc).catch(() => {})
  }
}, FLUSH_INTERVAL_MS)

/* ------------------------------------------------------------------ */
/* Op sanitation                                                       */
/* ------------------------------------------------------------------ */

/**
 * Validate and normalize one incoming op. Returns null for garbage.
 *
 * NOTE: positions are NOT clamped to the current server text length — ops
 * arrive in the CLIENT's coordinate space (their base revision plus their
 * own unacked edits) and are only re-based via transformAgainstLog before
 * application. applyOp() clamps defensively at apply time.
 */
function sanitizeOp(raw: unknown): Op | null {
  if (!isOp(raw)) return null
  if (raw.type === 'insert') {
    const text = String(raw.text).slice(0, MAX_INSERT_CHARS)
    if (text.length === 0) return null
    const pos = Math.max(0, Math.floor(raw.pos) || 0)
    return { type: 'insert', pos, text }
  }
  // Deletes arrive as single-char ops.
  const pos = Math.max(0, Math.floor(raw.pos) || 0)
  return { type: 'delete', pos, len: 1 }
}

function sanitizeBatch(rawOps: unknown): Op[] {
  if (!Array.isArray(rawOps) || rawOps.length === 0) return []
  const out: Op[] = []
  for (const raw of rawOps.slice(0, MAX_BATCH_OPS)) {
    const op = sanitizeOp(raw)
    if (op) out.push(op)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Socket.io wiring                                                    */
/* ------------------------------------------------------------------ */

const httpServer = createServer()
const io = new Server(httpServer, {
  // DO NOT change the path: Caddy forwards on it.
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 2 * 1024 * 1024,
})

function roomFor(docId: string) {
  return `doc:${docId}`
}

function presenceList(doc: DocState): PresenceUser[] {
  return Array.from(doc.users.values())
}

function broadcastPresence(docId: string) {
  const doc = docs.get(docId)
  if (!doc) return
  io.to(roomFor(docId)).emit('doc:presence', { users: presenceList(doc) })
}

async function joinDoc(socket: Socket, docId: string, name: string, color: string) {
  // Leave any previous room first.
  const prevId = socket.data.docId as string | undefined
  if (prevId && prevId !== docId) {
    const prev = docs.get(prevId)
    if (prev) {
      prev.users.delete(socket.id)
      if (prev.users.size === 0) {
        flushDoc(prev).catch(() => {})
      } else {
        broadcastPresence(prevId)
      }
    }
    socket.leave(roomFor(prevId))
  }

  // Share-key access check: outsiders get a clear error instead of the
  // document (mirrors the REST API's visibility rules).
  if (!(await canJoin(docId, name))) {
    socket.emit('doc:error', { message: 'You have not been invited to this document.' })
    return
  }

  const doc = await loadDoc(docId)
  if (!doc) {
    socket.emit('doc:error', { message: 'Document not found.' })
    return
  }

  socket.data.docId = docId
  socket.join(roomFor(docId))
  doc.users.set(socket.id, {
    id: socket.id,
    name: (name || 'Anonymous').slice(0, 40),
    color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#10b981',
    pos: null,
  })

  socket.emit('doc:init', {
    docId,
    text: doc.text,
    revision: doc.revision,
    users: presenceList(doc),
  })
  broadcastPresence(docId)
  console.log(`[join] ${name} (${socket.id}) -> doc ${docId} (${doc.users.size} online)`)
}

io.on('connection', (socket) => {
  socket.data.docId = undefined

  socket.on('doc:join', (data: { docId?: string; name?: string; color?: string }) => {
    if (typeof data?.docId !== 'string' || data.docId.length === 0) return
    joinDoc(socket, data.docId, String(data?.name ?? 'Anonymous'), String(data?.color ?? '#10b981')).catch((err) => {
      console.error('[join] failed:', err)
      socket.emit('doc:error', { message: 'Failed to open document.' })
    })
  })

  socket.on('doc:op', (data: { ops?: unknown; base?: number }) => {
    const doc = docs.get(socket.data.docId as string)
    if (!doc) return
    const base = Number(data?.base)
    if (!Number.isInteger(base) || base < 0) return

    // Too old (or from before a restore) -> hard resync.
    if (base > doc.revision || base < doc.logBase) {
      socket.emit('doc:reset', {
        docId: doc.id,
        text: doc.text,
        revision: doc.revision,
        reason: 'stale-base',
      })
      return
    }

    const ops = sanitizeBatch(data?.ops)
    if (ops.length === 0) {
      // Nothing applicable (fully-invalid or empty batch): still ack so the
      // client can flush its buffer.
      socket.emit('doc:ack', { version: doc.revision })
      return
    }

    // THE core move: transform the late batch forward against everything
    // the server has applied since the client's base revision.
    const transformed = transformAgainstLog(ops, doc.log.slice(base - doc.logBase))

    if (transformed.length > 0) {
      doc.text = applyOps(doc.text, transformed)
      doc.revision++
      doc.log.push(transformed)
      if (doc.log.length > LOG_CAP) {
        const drop = doc.log.length - LOG_CAP
        doc.log.splice(0, drop)
        doc.logBase += drop
      }
      doc.dirty = true
      const author = doc.users.get(socket.id)?.name ?? 'anonymous'
      doc.pendingOpRows.push({ revision: doc.revision, ops: transformed, author })
      doc.opsSinceSnapshot += transformed.length

      // Ack the sender FIRST (their ops are already reflected locally),
      // then broadcast to everyone else — both in server order.
      socket.emit('doc:ack', { version: doc.revision })
      socket.to(roomFor(doc.id)).emit('doc:op', {
        ops: transformed,
        version: doc.revision,
        author: { id: socket.id, name: author },
      })

      if (doc.opsSinceSnapshot >= SNAPSHOT_EVERY_OPS) {
        // Reset synchronously: a second batch could otherwise cross the
        // threshold again before the async snapshot finishes and reset it.
        doc.opsSinceSnapshot = 0
        createSnapshot(doc, 'Autosave', author).catch(() => {})
        io.to(roomFor(doc.id)).emit('doc:snapshot-created', {
          label: 'Autosave',
          author,
        })
      }
    } else {
      // Batch was fully neutralized by concurrent deletes: still advances
      // the revision so ordering stays total.
      doc.revision++
      doc.log.push([])
      doc.dirty = true
      socket.emit('doc:ack', { version: doc.revision })
      socket.to(roomFor(doc.id)).emit('doc:op', {
        ops: [],
        version: doc.revision,
        author: { id: socket.id, name: doc.users.get(socket.id)?.name ?? 'anonymous' },
      })
    }
  })

  socket.on('doc:cursor', (data: { pos?: number }) => {
    const docId = socket.data.docId as string
    const doc = docs.get(docId)
    if (!doc) return
    const pos = Number(data?.pos)
    if (!Number.isInteger(pos) || pos < 0) return
    const user = doc.users.get(socket.id)
    if (user) user.pos = Math.min(pos, 1_000_000)
    socket.to(roomFor(docId)).emit('doc:cursor', { id: socket.id, pos: user?.pos ?? pos })
  })

  socket.on('doc:snapshot', (data: { label?: string }) => {
    const doc = docs.get(socket.data.docId as string)
    if (!doc) return
    const author = doc.users.get(socket.id)?.name ?? 'anonymous'
    const label = (String(data?.label ?? 'Manual save').slice(0, 80)) || 'Manual save'
    createSnapshot(doc, label, author)
      .then(() => {
        io.to(roomFor(doc.id)).emit('doc:snapshot-created', { label, author })
      })
      .catch(() => {})
  })

  socket.on('doc:restore', async (data: { versionId?: string }) => {
    const doc = docs.get(socket.data.docId as string)
    if (!doc) return
    const versionId = String(data?.versionId ?? '')
    if (versionId.length === 0) return
    try {
      const res = await pool.query(
        'SELECT content, label, revision FROM "DocumentVersion" WHERE id = $1 AND "documentId" = $2',
        [versionId, doc.id]
      )
      if (res.rowCount === 0) {
        socket.emit('doc:error', { message: 'Version not found.' })
        return
      }
      const row = res.rows[0]
      const author = doc.users.get(socket.id)?.name ?? 'anonymous'
      doc.text = row.content ?? ''
      doc.revision++
      doc.log = []
      doc.logBase = doc.revision
      doc.dirty = true
      doc.opsSinceSnapshot = 0
      io.to(roomFor(doc.id)).emit('doc:reset', {
        docId: doc.id,
        text: doc.text,
        revision: doc.revision,
        reason: 'restore',
      })
      await createSnapshot(doc, `Restored from v${row.revision} (${row.label})`, author)
      io.to(roomFor(doc.id)).emit('doc:snapshot-created', { label: 'Restore', author })
      console.log(`[restore] doc ${doc.id} to version ${versionId} -> rev ${doc.revision}`)
    } catch (err) {
      console.error('[restore] failed:', err)
      socket.emit('doc:error', { message: 'Restore failed.' })
    }
  })

  socket.on('disconnect', () => {
    const docId = socket.data.docId as string | undefined
    if (!docId) return
    const doc = docs.get(docId)
    if (doc) {
      const user = doc.users.get(socket.id)
      doc.users.delete(socket.id)
      if (doc.users.size === 0) {
        flushDoc(doc)
          .catch(() => {})
          .finally(() => {
            // Keep the doc cached a moment so reloads are instant; the flush
            // loop keeps it persisted either way.
          })
      } else {
        broadcastPresence(docId)
      }
      console.log(`[leave] ${user?.name ?? socket.id} left doc ${docId}`)
    }
  })

  socket.on('error', (err: Error) => {
    console.error(`[socket] error (${socket.id}):`, err.message)
  })
})

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

httpServer.listen(PORT, () => {
  console.log(`CoDoc sync service running on port ${PORT}`)
  console.log('OT engine: src/lib/ot-core.ts (fuzz-verified, 3000+ convergence sims)')
})

async function shutdown() {
  console.log('Shutting down, flushing documents...')
  for (const doc of docs.values()) {
    await flushDoc(doc).catch(() => {})
  }
  await pool.end().catch(() => {})
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
