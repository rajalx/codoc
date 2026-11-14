/**
 * CoDoc OT core — server-authoritative Operational Transformation.
 *
 * This module is pure TypeScript with zero imports so the exact same code
 * runs in three places:
 *   1. the browser (client-side OT controller),
 *   2. the sync service (server-side transform + apply),
 *   3. the fuzz tester (convergence verification).
 *
 * DESIGN
 * ------
 * A document is a plain UTF-8 string. An operation ("op") is a primitive:
 *
 *   { type: "insert", pos: number, text: string }   insert `text` at `pos`
 *   { type: "delete", pos: number, len: 1 }          delete ONE character
 *
 * Constraint that keeps the transform math simple: every delete op deletes
 * exactly one character. Deleting a selection of N chars therefore produces
 * N single-char deletes (all at the same `pos`, applied in order). With this
 * constraint no transform ever has to split an operation, and insertions can
 * still be arbitrarily long (fast pastes).
 *
 * Revision numbers: the server owns a monotonically increasing `revision`
 * counter. Client ops are sent tagged with the client's last-acked revision
 * (`base`). The server transforms late ops forward against everything that
 * happened since `base`, applies them, increments the revision, and echoes an
 * ack. Remote ops are broadcast in server order so every client sees the same
 * total order — that is what makes the system "server-authoritative".
 */

export type InsertOp = { type: 'insert'; pos: number; text: string }
export type DeleteOp = { type: 'delete'; pos: number; len: number }
export type Op = InsertOp | DeleteOp

export function isOp(x: unknown): x is Op {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  if (o.type === 'insert')
    return typeof o.pos === 'number' && typeof o.text === 'string'
  if (o.type === 'delete')
    return typeof o.pos === 'number' && typeof o.len === 'number'
  return false
}

/* ------------------------------------------------------------------ */
/* Applying operations                                                 */
/* ------------------------------------------------------------------ */

export function applyOp(text: string, op: Op): string {
  if (op.type === 'insert') {
    const pos = clamp(op.pos, 0, text.length)
    return text.slice(0, pos) + op.text + text.slice(pos)
  }
  const pos = clamp(op.pos, 0, Math.max(0, text.length - 1))
  const len = Math.min(op.len, text.length - pos)
  if (len <= 0) return text
  return text.slice(0, pos) + text.slice(pos + len)
}

export function applyOps(text: string, ops: Op[]): string {
  let t = text
  for (const op of ops) t = applyOp(t, op)
  return t
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

/* ------------------------------------------------------------------ */
/* Transforming one primitive against another                          */
/* ------------------------------------------------------------------ */

/**
 * Transform primitive `a` against primitive `b`, where `a` is defined as
 * applying FIRST. Returns `[a2, b2]`:
 *   - `a2` is `a` adjusted to apply AFTER `b` (null if it becomes a no-op),
 *   - `b2` is `b` adjusted to apply AFTER `a` (null if it becomes a no-op).
 *
 * Convergence law:  base + a + b2  ===  base + b + a2
 */
function transformPrim(a: Op, b: Op): [Op | null, Op | null] {
  if (a.type === 'insert' && b.type === 'insert') {
    // Both insert. Whoever is "first" (a) wins the tie at equal positions,
    // which keeps the transform deterministic and order-independent.
    if (a.pos <= b.pos) return [a, { ...b, pos: b.pos + a.text.length }]
    return [{ ...a, pos: a.pos + b.text.length }, b]
  }
  if (a.type === 'insert' && b.type === 'delete') {
    if (a.pos <= b.pos)
      return [a, { ...b, pos: b.pos + a.text.length }]
    return [{ ...a, pos: a.pos - b.len }, b]
  }
  if (a.type === 'delete' && b.type === 'insert') {
    if (b.pos <= a.pos)
      return [{ ...a, pos: a.pos + b.text.length }, b]
    return [a, { ...b, pos: b.pos - a.len }]
  }
  // Remaining combination: delete vs delete. The three cases above are
  // exhaustive over (insert,insert) / (insert,delete) / (delete,insert),
  // so narrowing here also satisfies the type checker for `.len` access.
  if (a.type === 'delete' && b.type === 'delete') {
    // Single-char deletes either hit the same character (both become
    // no-ops) or different characters (pure position shifts).
    if (a.pos < b.pos) return [a, { ...b, pos: b.pos - a.len }]
    if (b.pos < a.pos) return [{ ...a, pos: a.pos - b.len }, b]
    return [null, null]
  }
  // Unreachable for well-typed ops; defensive identity so the function is
  // total (transformLists relies on receiving an op back for either side).
  return [a, b]
}

/**
 * Transform two SEQUENTIAL op lists `A` and `B` that branch from the same
 * base state, where `A` is considered "first". Returns `[A2, B2]` with
 *
 *   base + A + B2  ===  base + B + A2
 *
 * Implemented as the classic grid walk: op A[i] sweeps left-to-right across
 * the current row of B ops (each cell transforms one a against one b in the
 * shared coordinate space of "everything above and to the left"). Because
 * primitives never split, each cell is a single transformPrim call.
 */
export function transformLists(A: Op[], B: Op[]): [Op[], Op[]] {
  if (A.length === 0) return [[], B.slice()]
  if (B.length === 0) return [A.slice(), []]

  const A2: Op[] = []
  // bRow[j] holds B[j] transformed past A[0..i-1]; it becomes B2 at the end.
  let bRow: (Op | null)[] = B.slice()

  for (const a of A) {
    let aCur: Op | null = a
    const bNext: (Op | null)[] = new Array(bRow.length)
    for (let j = 0; j < bRow.length; j++) {
      const b = bRow[j]
      if (aCur && b) {
        const [a2, b2] = transformPrim(aCur, b)
        aCur = a2
        bNext[j] = b2
      } else {
        // If a dropped out (fully-overlapped delete) b is unchanged; if b
        // was already dropped it stays dropped.
        bNext[j] = b
      }
    }
    bRow = bNext
    if (aCur) A2.push(aCur)
  }
  const B2: Op[] = bRow.filter((x): x is Op => x !== null)
  return [A2, B2]
}

/**
 * Server-side helper: incoming client ops were computed against revision
 * `base` but the server has already applied `log` batches since then.
 * Transform the incoming ops forward across every batch.
 *
 * NOTE on argument order: transformLists(A, B) makes A the tie-break WINNER
 * for concurrent inserts at the same position. The client-side controller
 * always passes its own outstanding ops as the first argument when a remote
 * broadcast arrives — so the server MUST do the same here (incoming client
 * ops first, logged batch second) or the two sides break ties differently
 * and diverge. This is the classic OT tie-break pitfall.
 */
export function transformAgainstLog(ops: Op[], log: Op[][]): Op[] {
  let cur = ops
  for (const batch of log) {
    // cur (the incoming client ops) is the first argument: tie winner.
    const [cur2] = transformLists(cur, batch)
    cur = cur2
    if (cur.length === 0) break
  }
  return cur
}

/* ------------------------------------------------------------------ */
/* Cursor / position transforms                                        */
/* ------------------------------------------------------------------ */

/**
 * Move a caret position across a list of applied ops.
 * An insert at or before the caret pushes it right; a delete strictly
 * before the caret pulls it left; a delete at the caret leaves it in place.
 */
export function transformPosition(pos: number, ops: Op[]): number {
  let p = pos
  for (const op of ops) {
    if (op.type === 'insert') {
      if (op.pos <= p) p += op.text.length
    } else {
      if (op.pos < p) p -= Math.min(op.len, p - op.pos)
    }
  }
  return p
}

/* ------------------------------------------------------------------ */
/* Diffing (for turning textarea changes into ops)                      */
/* ------------------------------------------------------------------ */

/**
 * Compute the minimal op list that turns `oldText` into `newText`.
 * Deletions are emitted first (all at the change start), then the insertion,
 * which correctly expresses "replace this range with that text".
 */
export function diffToOps(oldText: string, newText: string): Op[] {
  const oldLen = oldText.length
  const newLen = newText.length
  const maxPrefix = Math.min(oldLen, newLen)
  let start = 0
  while (start < maxPrefix && oldText.charCodeAt(start) === newText.charCodeAt(start)) start++
  let endOld = oldLen
  let endNew = newLen
  while (endOld > start && endNew > start && oldText.charCodeAt(endOld - 1) === newText.charCodeAt(endNew - 1)) {
    endOld--
    endNew--
  }
  const deleted = endOld - start
  const inserted = newText.slice(start, endNew)
  const ops: Op[] = []
  for (let i = 0; i < deleted; i++) ops.push({ type: 'delete', pos: start, len: 1 })
  if (inserted.length > 0) ops.push({ type: 'insert', pos: start, text: inserted })
  return ops
}

/* ------------------------------------------------------------------ */
/* Client-side OT controller                                           */
/* ------------------------------------------------------------------ */

export interface OTClientHooks {
  /** Called whenever the authoritative-visible text changes. */
  onUpdate: (text: string) => void
  /** Called when a batch of local ops should be shipped to the server. */
  onSend: (ops: Op[], baseRevision: number) => void
}

/**
 * The client half of the protocol, following the classic ot.js
 * outstanding/buffer state machine:
 *
 *   text      = lastServerState + outstanding + buffer  (all local knowledge)
 *   outstanding: ops of the batch currently in flight, awaiting its ack
 *   buffer:    ops made while a batch is still in flight
 *
 * When a remote op arrives it is transformed against `outstanding` and then
 * `buffer` before being applied locally, and both lists are re-based so the
 * coordinate spaces stay consistent. The same math runs on the server for
 * the opposite direction, which is what guarantees convergence without
 * locking.
 *
 * IMPORTANT: "outstanding is empty" does NOT mean "no batch is in flight" —
 * a batch can be fully neutralized by concurrent deletes while its ack is
 * still on the wire. Promoting the buffer early would misattribute that ack
 * to the wrong batch and corrupt revision tracking, so `inFlight` is tracked
 * explicitly.
 */
export class OTClient {
  text: string
  revision: number
  outstanding: Op[] = []
  buffer: Op[] = []
  private inFlight = false
  private hooks: OTClientHooks

  constructor(text: string, revision: number, hooks: OTClientHooks) {
    this.text = text
    this.revision = revision
    this.hooks = hooks
  }

  /** True while local edits have not been acknowledged by the server yet. */
  get pending(): boolean {
    return this.inFlight || this.buffer.length > 0
  }

  /** The user edited the textarea; `newText` is the full new content. */
  localChange(newText: string): Op[] {
    const ops = diffToOps(this.text, newText)
    if (ops.length === 0) return []
    this.text = newText
    this.buffer.push(...ops)
    this.flush()
    this.hooks.onUpdate(this.text)
    return ops
  }

  private flush(): void {
    if (!this.inFlight && this.buffer.length > 0) {
      this.outstanding = this.buffer
      this.buffer = []
      this.inFlight = true
      this.hooks.onSend(this.outstanding, this.revision)
    }
  }

  /** The server accepted our in-flight batch; `version` is the new revision. */
  ack(version: number): void {
    this.revision = version
    this.inFlight = false
    this.outstanding = []
    this.flush()
  }

  /**
   * A remote op batch broadcast by the server (arrives in server order).
   * Returns the ops as they were finally applied to OUR local text (i.e.
   * already transformed past our outstanding + buffer) — useful for moving
   * things like remote cursor markers.
   */
  remoteOps(ops: Op[], version: number): Op[] {
    let s = ops
    if (this.outstanding.length > 0) {
      // Locally the outstanding ops are already in the text, so they are
      // "first"; the remote batch is re-based on top of them.
      const [outstanding2, s2] = transformLists(this.outstanding, s)
      this.outstanding = outstanding2
      s = s2
    }
    if (this.buffer.length > 0) {
      const [buffer2, s3] = transformLists(this.buffer, s)
      this.buffer = buffer2
      s = s3
    }
    this.text = applyOps(this.text, s)
    this.revision = version
    this.hooks.onUpdate(this.text)
    return s
  }

  /** Hard resync (first join, restore, or unrecoverable divergence). */
  reset(text: string, revision: number): void {
    this.text = text
    this.revision = revision
    this.outstanding = []
    this.buffer = []
    this.inFlight = false
    this.hooks.onUpdate(this.text)
  }
}
