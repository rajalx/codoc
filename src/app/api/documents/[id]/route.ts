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
 * Access model (share-key collaboration): identity is the display name in
 * the `user` query parameter (no auth in this app). A user can see a
 * document if they own it, appear in the Collaborator table (joined via
 * share key), or the document is public (`ownerName` ""). Only the owner
 * (or a public doc) may rename or delete.
 *
 * Gotchas:
 * - `id` is a UUID string, but it is NOT format-validated here. Prisma
 *   passes it straight into `findUnique`/`update`/`delete`, so a malformed
 *   id simply finds nothing (GET -> 404) or throws (PATCH/DELETE -> 500).
 * - DELETE cascades to DocumentVersion, OperationEntry and Collaborator
 *   rows (all declare `onDelete: Cascade` in prisma/schema.prisma).
 *   Deleting a document that has live editors silently destroys the
 *   history the sync service may still be writing to.
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

type Params = { params: Promise<{ id: string }> }

/** Reads and normalizes the requester's display name from `?user=`. */
function userName(req: NextRequest): string {
  return (req.nextUrl.searchParams.get('user') ?? '').trim().slice(0, 40)
}

/**
 * Access check shared by all three handlers: loads the document with its
 * owner and collaborators, returns the row when `user` may see it.
 * Public docs (ownerName "") are visible to everyone, including an
 * anonymous user (no `user` parameter at all).
 */
async function loadForUser(id: string, user: string) {
  return db.document.findFirst({
    where: {
      id,
      OR: [
        { ownerName: '' },
        ...(user ? [{ ownerName: user }, { collaborators: { some: { userName: user } } }] : []),
      ],
    },
    select: {
      id: true,
      title: true,
      revision: true,
      updatedAt: true,
      ownerName: true,
    },
  })
}

/**
 * GET /api/documents/[id]?user=<display name>
 *
 * Fetches document metadata (no content) for an editor screen header,
 * with an access check: outsiders get 403 instead of the metadata.
 *
 * Request shape: path parameter `id` (UUID string); `?user=` display name.
 *
 * Response:
 *   200 — { id, title, revision, updatedAt, owner, isOwner }.
 *   403 — { error: "You do not have access to this document" } when the
 *         user is not the owner, a collaborator, and the doc is not public.
 *   404 — { error: "Document not found" } when no row matches `id`.
 *   500 — { error: "Failed to load document" } on any other failure.
 */
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    const user = userName(req)
    const doc = await loadForUser(id, user)
    if (!doc) {
      // Distinguish "no such document" from "exists but not yours" so the
      // client can show the right screen; only report existence when the
      // caller is authenticated against it.
      const exists = await db.document.findUnique({ where: { id }, select: { id: true } })
      if (exists) {
        return NextResponse.json(
          { error: 'You do not have access to this document' },
          { status: 403 }
        )
      }
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }
    return NextResponse.json({
      ...doc,
      owner: doc.ownerName,
      isOwner: doc.ownerName === '' || doc.ownerName === user,
    })
  } catch (err) {
    console.error('GET /api/documents/[id] failed:', err)
    return NextResponse.json({ error: 'Failed to load document' }, { status: 500 })
  }
}

/**
 * PATCH /api/documents/[id]?user=<display name>
 *
 * Renames a document (title only — content is never touched via REST).
 * Owner-only (or public docs): collaborators edit content but cannot
 * rename.
 *
 * Request shape: JSON body `{ title: string }`; the title is trimmed and
 * truncated to 120 characters.
 *
 * Response:
 *   200 — { id, title } for the updated row.
 *   400 — { error: "Title cannot be empty" } when the title is missing,
 *         not a string, or whitespace-only after trimming.
 *   403 — { error: "Only the owner can rename this document" } when the
 *         user is not the document owner.
 *   404 — { error: "Document not found" } when the row does not exist.
 *   500 — { error: "Failed to rename document" } on any other failure.
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    const user = userName(req)
    const body = await req.json().catch(() => ({}))
    // Non-string titles normalize to "", which the check below rejects —
    // so a malformed body is treated the same as an empty rename.
    const title = typeof body?.title === 'string' ? body.title.trim().slice(0, 120) : ''
    if (title.length === 0) {
      return NextResponse.json({ error: 'Title cannot be empty' }, { status: 400 })
    }
    const doc = await db.document.findUnique({
      where: { id },
      select: { ownerName: true },
    })
    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }
    if (doc.ownerName !== '' && doc.ownerName !== user) {
      return NextResponse.json(
        { error: 'Only the owner can rename this document' },
        { status: 403 }
      )
    }
    const updated = await db.document.update({
      where: { id },
      data: { title },
      select: { id: true, title: true },
    })
    return NextResponse.json(updated)
  } catch (err) {
    console.error('PATCH /api/documents/[id] failed:', err)
    return NextResponse.json({ error: 'Failed to rename document' }, { status: 500 })
  }
}

/**
 * DELETE /api/documents/[id]?user=<display name>
 *
 * Deletes a document. Owner-only. Side effects: cascades to all
 * DocumentVersion, OperationEntry and Collaborator rows for this document
 * (declared `onDelete: Cascade` in the Prisma schema), so the version
 * timeline, the operation audit log and the share list are destroyed with
 * it.
 *
 * Request shape: path parameter `id` (UUID string); `?user=` display name.
 *
 * Response:
 *   200 — { ok: true }.
 *   403 — { error: "Only the owner can delete this document" } when the
 *         user is not the document owner.
 *   404 — { error: "Document not found" } when no row matches.
 *   500 — { error: "Failed to delete document" } on any other failure.
 */
export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    const user = userName(req)
    const doc = await db.document.findUnique({
      where: { id },
      select: { ownerName: true },
    })
    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }
    if (doc.ownerName !== '' && doc.ownerName !== user) {
      return NextResponse.json(
        { error: 'Only the owner can delete this document' },
        { status: 403 }
      )
    }
    await db.document.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('DELETE /api/documents/[id] failed:', err)
    return NextResponse.json({ error: 'Failed to delete document' }, { status: 500 })
  }
}
