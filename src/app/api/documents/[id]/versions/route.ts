/**
 * Version timeline listing: `GET /api/documents/[id]/versions`.
 *
 * Talks to PostgreSQL through the shared Prisma client (`@/lib/db`).
 *
 * Division of responsibility: read-only. Version snapshots are created
 * exclusively by the sync service (mini-services/sync-service, socket.io
 * on port 3003) — automatically every SNAPSHOT_EVERY_OPS (40) applied
 * operations, on a client's manual "save version", and whenever a
 * snapshot is restored. The REST API only lists them. `author` is a
 * display name captured from the sync client (there is no authentication
 * in this application), and `revision` is the server revision the
 * snapshot was taken at.
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

type Params = { params: Promise<{ id: string }> }

/**
 * GET /api/documents/[id]/versions
 *
 * Lists up to 100 version snapshots for a document, newest first. Served
 * to the version-timeline UI, which previews and restores snapshots.
 *
 * Request shape: path parameter `id` (document UUID).
 *
 * Response:
 *   200 — array of { id, revision, label, author, createdAt, chars,
 *         content }. `content` is the full snapshot body (full text is
 *         included so the client can preview and restore without a second
 *         request); `chars` is its length in characters.
 *   500 — { error: "Failed to load versions" } on database failure.
 *
 * Notes: an unknown `documentId` yields 200 with an empty array rather
 * than 404, since this is a plain filtered query. The result is capped at
 * 100 rows; older snapshots are not reachable through this endpoint.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    const versions = await db.documentVersion.findMany({
      where: { documentId: id },
      // Newest first, matching the timeline UI. Backed by the
      // @@index([documentId, createdAt]) index in the Prisma schema,
      // which serves exactly this filter + order + take-100 query.
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        revision: true,
        label: true,
        author: true,
        createdAt: true,
        content: true,
      },
    })
    return NextResponse.json(
      versions.map((v) => ({
        id: v.id,
        revision: v.revision,
        label: v.label,
        author: v.author,
        createdAt: v.createdAt,
        chars: v.content.length,
        content: v.content,
      }))
    )
  } catch (err) {
    console.error('GET /api/documents/[id]/versions failed:', err)
    return NextResponse.json({ error: 'Failed to load versions' }, { status: 500 })
  }
}
