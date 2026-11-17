/**
 * Join by share key: `POST /api/documents/join`.
 *
 * The invite flow: the document owner hands out the share key (from
 * GET /api/documents/[id]/share or the Share dialog); anyone who has the
 * key posts it here together with their display name and is recorded in
 * the Collaborator table — granting edit access. Joining is idempotent:
 * the same display name joining twice updates nothing (unique constraint
 * on documentId+userName). Joining with the owner's own key simply
 * returns the document (the owner needs no Collaborator row).
 *
 * Talks to PostgreSQL through the shared Prisma client (`@/lib/db`).
 * Identity model: display names in the body (no authentication).
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

/**
 * POST /api/documents/join
 *
 * Request shape: JSON body `{ shareKey: string, user: string }`. The key
 * is normalized to lowercase (keys are generated lowercase; the
 * normalization absorbs paste artifacts like trailing spaces or caps-lock).
 *
 * Response:
 *   200 — { id, title, role: "owner" } when the user is the owner.
 *   201 — { id, title, role: "collaborator" } when a new Collaborator row
 *         was created (the user now has edit access).
 *   200 — { id, title, role: "collaborator" } when the user had already
 *         joined before (nothing changed).
 *   400 — { error: "Share key and name are required" } on a malformed
 *         body (missing/blank key or name).
 *   404 — { error: "Invalid share key" } when no document matches the key.
 *   500 — { error: "Failed to join document" } on any other failure.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const shareKey = typeof body?.shareKey === 'string' ? body.shareKey.trim().toLowerCase() : ''
    const user = typeof body?.user === 'string' ? body.user.trim().slice(0, 40) : ''
    if (!shareKey || !user) {
      return NextResponse.json(
        { error: 'Share key and name are required' },
        { status: 400 }
      )
    }

    const doc = await db.document.findUnique({
      where: { shareKey },
      select: { id: true, title: true, ownerName: true },
    })
    if (!doc) {
      return NextResponse.json({ error: 'Invalid share key' }, { status: 404 })
    }

    // The owner needs no Collaborator row — their access already exists.
    if (doc.ownerName === user) {
      return NextResponse.json({ id: doc.id, title: doc.title, role: 'owner' })
    }

    // Upsert semantics via unique (documentId, userName): re-joining is a
    // no-op that still confirms access.
    const wasNew = !(await db.collaborator.findFirst({
      where: { documentId: doc.id, userName: user },
      select: { id: true },
    }))
    await db.collaborator.upsert({
      where: { documentId_userName: { documentId: doc.id, userName: user } },
      update: {},
      create: { documentId: doc.id, userName: user },
    })

    return NextResponse.json(
      { id: doc.id, title: doc.title, role: 'collaborator' },
      { status: wasNew ? 201 : 200 }
    )
  } catch (err) {
    console.error('POST /api/documents/join failed:', err)
    return NextResponse.json({ error: 'Failed to join document' }, { status: 500 })
  }
}
