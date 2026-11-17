/**
 * Share key retrieval: `GET /api/documents/[id]/share?user=<display name>`.
 *
 * Owner-only: returns the document's share key so the owner can hand it
 * out (or a copyable share link built from it). If the document predates
 * the share-key feature (shareKey null), a key is generated and persisted
 * here — lazily upgrading legacy rows.
 *
 * Talks to PostgreSQL through the shared Prisma client (`@/lib/db`).
 * Identity model: display name in `?user=` (no authentication).
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { newShareKey } from '../../route'

type Params = { params: Promise<{ id: string }> }

/**
 * GET /api/documents/[id]/share?user=<display name>
 *
 * Response:
 *   200 — { shareKey } (owner only).
 *   403 — { error: "Only the owner can share this document" } when the
 *         user is not the document owner.
 *   404 — { error: "Document not found" } when no row matches `id`.
 *   500 — { error: "Failed to load share key" } on any other failure.
 */
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    const user = (req.nextUrl.searchParams.get('user') ?? '').trim().slice(0, 40)
    const doc = await db.document.findUnique({
      where: { id },
      select: { ownerName: true, shareKey: true },
    })
    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }
    if (doc.ownerName !== '' && doc.ownerName !== user) {
      return NextResponse.json(
        { error: 'Only the owner can share this document' },
        { status: 403 }
      )
    }

    // Legacy row without a key: generate one and persist it (unique; a
    // collision retry is a 1-in-billions event but costs one extra query).
    let shareKey = doc.shareKey
    if (!shareKey) {
      shareKey = newShareKey()
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await db.document.update({ where: { id }, data: { shareKey } })
          break
        } catch (err: unknown) {
          if ((err as { code?: string })?.code !== 'P2002') throw err
          shareKey = newShareKey()
        }
      }
    }

    return NextResponse.json({ shareKey })
  } catch (err) {
    console.error('GET /api/documents/[id]/share failed:', err)
    return NextResponse.json({ error: 'Failed to load share key' }, { status: 500 })
  }
}
