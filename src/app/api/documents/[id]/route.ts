/**
 * REST endpoints for a single document: `GET/PATCH/DELETE /api/documents/[id]`.
 *
 * Talks to PostgreSQL through the shared Prisma client (`@/lib/db`).
 *
 * Division of responsibility: this REST API handles metadata only — reads,
 * renames and deletes. Live content and `revision` are owned by the sync
 * service (mini-services/sync-service, socket.io on port 3003), the sole
 * writer of `Document.content`, `Document.revision`, `OperationEntry` rows
 * and `DocumentVersion` snapshots.
 *
 * Gotchas:
 * - `id` is a UUID string, but it is NOT format-validated here. Prisma
 *   passes it straight into `findUnique`/`update`/`delete`, so a malformed
 *   id simply finds nothing (GET -> 404) or throws (PATCH/DELETE -> 500).
 * - DELETE cascades to DocumentVersion and OperationEntry rows (both
 *   declare `onDelete: Cascade` in prisma/schema.prisma). Deleting a
 *   document that has live editors silently destroys the history the sync
 *   service may still be writing to.
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

type Params = { params: Promise<{ id: string }> }

/**
 * GET /api/documents/[id]
 *
 * Fetches document metadata (no content) for an editor screen header.
 *
 * Request shape: path parameter `id` (UUID string).
 *
 * Response:
 *   200 — { id, title, revision, updatedAt }.
 *   404 — { error: "Document not found" } when no row matches `id`.
 *   500 — { error: "Failed to load document" } on any other failure.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    const doc = await db.document.findUnique({
      where: { id },
      // Content is deliberately excluded: it can be large and the sync
      // service is its authoritative source once a session starts.
      select: { id: true, title: true, revision: true, updatedAt: true },
    })
    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }
    return NextResponse.json(doc)
  } catch (err) {
    console.error('GET /api/documents/[id] failed:', err)
    return NextResponse.json({ error: 'Failed to load document' }, { status: 500 })
  }
}

/**
 * PATCH /api/documents/[id]
 *
 * Renames a document (title only — content is never touched via REST).
 *
 * Request shape: JSON body `{ title: string }`; the title is trimmed and
 * truncated to 120 characters.
 *
 * Response:
 *   200 — { id, title } for the updated row.
 *   400 — { error: "Title cannot be empty" } when the title is missing,
 *         not a string, or whitespace-only after trimming.
 *   500 — { error: "Failed to rename document" } when the row does not
 *         exist (Prisma throws P2025) or on any other database failure.
 *         Note the inconsistency: a missing document yields 500 here, but
 *         404 on GET.
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    // Non-string titles normalize to "", which the check below rejects —
    // so a malformed body is treated the same as an empty rename.
    const title = typeof body?.title === 'string' ? body.title.trim().slice(0, 120) : ''
    if (title.length === 0) {
      return NextResponse.json({ error: 'Title cannot be empty' }, { status: 400 })
    }
    const doc = await db.document.update({
      where: { id },
      data: { title },
      select: { id: true, title: true },
    })
    return NextResponse.json(doc)
  } catch (err) {
    console.error('PATCH /api/documents/[id] failed:', err)
    return NextResponse.json({ error: 'Failed to rename document' }, { status: 500 })
  }
}

/**
 * DELETE /api/documents/[id]
 *
 * Deletes a document. Side effects: cascades to all DocumentVersion and
 * OperationEntry rows for this document (declared `onDelete: Cascade` in
 * the Prisma schema), so the version timeline and the operation audit log
 * are destroyed with it.
 *
 * Request shape: path parameter `id` (UUID string).
 *
 * Response:
 *   200 — { ok: true }.
 *   500 — { error: "Failed to delete document" } when no row matches
 *         (Prisma throws P2025 — again surfaced as 500, not 404) or on any
 *         other database failure.
 */
export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    await db.document.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('DELETE /api/documents/[id] failed:', err)
    return NextResponse.json({ error: 'Failed to delete document' }, { status: 500 })
  }
}
