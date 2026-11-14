/**
 * REST collection endpoint for documents: `GET /api/documents` (list) and
 * `POST /api/documents` (create).
 *
 * Talks to PostgreSQL through the shared Prisma client (`@/lib/db`).
 *
 * Division of responsibility: this REST API handles metadata, listing,
 * seeding and creation only. During live editing, document content and
 * `revision` are owned by the sync service (mini-services/sync-service,
 * socket.io on port 3003), which is the sole writer of `Document.content`,
 * `Document.revision`, `OperationEntry` rows and `DocumentVersion`
 * snapshots. REST handlers therefore never mutate content or revision
 * while a session is active.
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

/**
 * GET /api/documents
 *
 * Lists every document with a small text preview for the home screen.
 * Side effect: on the very first call against an empty database, seeds the
 * "Welcome to CoDoc" document (see WELCOME_CONTENT below).
 *
 * Request shape: none (no query parameters consumed).
 *
 * Response:
 *   200 — array of { id, title, revision, updatedAt, preview, chars }.
 *         `preview` is the markdown content stripped of syntax characters,
 *         truncated to 120 chars; `chars` is the raw content length.
 *   500 — { error: "Failed to load documents" } on any database failure.
 */
export async function GET() {
  try {
    // Seed the welcome doc on first ever load. A Postgres advisory lock
    // prevents two simultaneous first-visitors from double-seeding.
    // pg_advisory_xact_lock is transaction-scoped: it is released
    // automatically when the transaction commits or rolls back, and the
    // arbitrary constant (918273645) is just a rendezvous key shared by
    // all callers of this handler.
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(918273645)`
      const count = await tx.document.count()
      if (count === 0) {
        await tx.document.create({
          data: { title: 'Welcome to CoDoc', content: WELCOME_CONTENT },
        })
      }
    })

    // Read after the seed transaction completes so the welcome document
    // appears in this same first response.
    const documents = await db.document.findMany({
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        title: true,
        revision: true,
        updatedAt: true,
        content: true,
      },
    })

    return NextResponse.json(
      documents.map((d) => ({
        id: d.id,
        title: d.title,
        revision: d.revision,
        updatedAt: d.updatedAt,
        // Strip the most common Markdown syntax characters so the preview
        // reads as plain text; trimmed and capped at 120 chars.
        preview: (d.content ?? '').replace(/[#>*`\-]/g, '').trim().slice(0, 120),
        chars: (d.content ?? '').length,
      }))
    )
  } catch (err) {
    console.error('GET /api/documents failed:', err)
    return NextResponse.json({ error: 'Failed to load documents' }, { status: 500 })
  }
}

/**
 * Seed content served on the first visit to an empty database. Also serves
 * as the two-window demo instructions for new users.
 */
const WELCOME_CONTENT = `# Welcome to CoDoc

A **real-time collaborative** Markdown editor — a mini Google Docs for Markdown.

## Try the two-window demo

1. Click anywhere in this text and start typing.
2. Open this same page in a **second browser window** (or an incognito tab).
3. Type in both windows at once — watch the text stay in sync and see the
   other person's **live cursor** with their name on it.
4. Delete and re-type in the same spot from both windows at the same time.
   The [operational transform](https://en.wikipedia.org/wiki/Operational_transformation)
   engine merges everything without losing a keystroke.

## What you're looking at

- **Live editing** — every keystroke becomes an *operation* ({type: "insert", pos, text})
  that is sent to a server-authoritative sync engine.
- **Live cursors & presence** — colored carets show where everyone is.
- **Version timeline** — open the *clock* icon up top: CoDoc snapshots the
  document automatically as you edit, and you can restore any point.
- **Markdown preview** — split view renders headings, lists, tables and code
  as you type.

## Markdown cheat sheet

| Syntax | Result |
| --- | --- |
| \`# Title\` | Heading |
| \`**bold**\` | **bold** |
| \`*italic*\` | *italic* |
| \`~~strike~~\` | ~~strike~~ |
| \`- item\` | list item |
| \`> quote\` | blockquote |

### Code blocks work too

\`\`\`js
// the sync engine in one line
server.apply(transform(clientOp, opsSince(clientBase)))
\`\`\`

> Tip: use the *Save version* button before a big rewrite, then compare
> snapshots in the timeline. Everything is stored in PostgreSQL.

---

*Made with Next.js, socket.io, operational transforms, and PostgreSQL.*
`

/**
 * Starter body for every newly created document. Purpose: an empty editor
 * pane reads as broken — this gives both panes (editor + preview)
 * immediately meaningful content: a live-demo hook, a working checklist,
 * and a Markdown cheat sheet the user can delete as they write.
 */
function newDocTemplate(title: string): string {
  return `# ${title}

Start here — this document is **live**. Open it in a second browser window
and watch every keystroke appear in both views in real time.

## Notes

Write anything here. Every keystroke syncs instantly to everyone viewing
this page — try it from two windows at once.

## Getting-started checklist

- [ ] Draft your outline below
- [ ] Invite a friend to co-edit (share this document)
- [ ] Save a version before a big rewrite — *clock* icon, top right
- [ ] Try restoring it from the version timeline

## Markdown cheat sheet

| Syntax | Result |
| --- | --- |
| \`# Heading\` | Heading |
| \`**bold**\` | **bold** |
| \`*italic*\` | *italic* |
| \`- item\` | List item |
| \`- [ ] task\` | Checkbox |
| \`> quote\` | Blockquote |
| \`\\\`code\\\`\` | Inline code |

> Tip: use the *Editor / Split / Preview* buttons in the top-right corner
> to switch layouts. Everything you type is stored in PostgreSQL.
`
}

/**
 * POST /api/documents
 *
 * Creates a new document with a starter Markdown body.
 *
 * Request shape: JSON body `{ title?: string }`. Missing title, an empty
 * title, or an unparseable body falls back to "Untitled document"; a
 * provided title is trimmed and truncated to 120 characters.
 *
 * Response:
 *   201 — { id, title }.
 *   500 — { error: "Failed to create document" } on database failure.
 *
 * Side effects: inserts a Document row with the default content template
 * (newDocTemplate above). The row starts at revision 0; the sync service
 * takes over content and revision ownership as soon as a client joins the
 * document's room. Note: the created content never enters the
 * OperationEntry audit log — it exists before any sync session for this
 * document begins.
 */
export async function POST(req: NextRequest) {
  try {
    // `.catch(() => ({}))` treats an empty/invalid JSON body as "no title"
    // rather than rejecting the request outright.
    const body = await req.json().catch(() => ({}))
    const title = typeof body?.title === 'string' && body.title.trim().length > 0
      ? body.title.trim().slice(0, 120)
      : 'Untitled document'
    const doc = await db.document.create({
      data: {
        title,
        content: newDocTemplate(title),
      },
    })
    return NextResponse.json({ id: doc.id, title: doc.title }, { status: 201 })
  } catch (err) {
    console.error('POST /api/documents failed:', err)
    return NextResponse.json({ error: 'Failed to create document' }, { status: 500 })
  }
}
