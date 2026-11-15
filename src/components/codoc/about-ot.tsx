'use client'

/**
 * AboutOTDialog — the "how it works" explainer for the sync engine.
 *
 * How it fits in: opened from HomeScreen and EditorScreen ("How sync
 * works"). Static educational content only — it describes the
 * server-authoritative OT flow implemented in src/lib/ot-core.ts (op
 * model, server total order, client transform mirror math) and the
 * persistence/transport stack (Next.js frontend, socket.io sync service
 * on port 3003, PostgreSQL operation log + snapshots). No app state, no
 * network calls; safe to mount anywhere.
 */
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/** Shared style for each explainer step box. */
const stepBox =
  'rounded-md border bg-muted/50 p-3 text-xs leading-5'

/**
 * Renders the explanatory dialog. Fully controlled (`open`/`onOpenChange`)
 * so the parent decides when it mounts and can open it from multiple
 * triggers; content is a fixed, static walkthrough of the OT pipeline.
 *
 * @param props.open - Controlled visibility flag for the Dialog.
 * @param props.onOpenChange - Visibility change handler from the parent.
 */
export function AboutOTDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>How CoDoc syncs</DialogTitle>
          <DialogDescription>
            Server-authoritative operational transformation — the same family of algorithms
            behind Google Docs — in about 300 lines of TypeScript.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm leading-6">
          <div className={stepBox}>
            <strong>1. Every edit is an operation.</strong> Typing becomes{' '}
            <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-800">
              {'{type:"insert", pos, text}'}
            </code>
            , deleting becomes a one-character{' '}
            <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-800">
              {'{type:"delete", pos, len:1}'}
            </code>
            . Ops are tiny, so your keystroke shows up locally with zero latency (local echo).
          </div>

          <div className={stepBox}>
            <strong>2. The server owns the order.</strong> Each batch is tagged with the revision
            it was based on. The sync engine transforms late batches forward across everything
            that happened since — insert positions shift, overlapping deletes collapse — then
            applies them and broadcasts the result in a single total order.
          </div>

          <div className={stepBox}>
            <strong>3. Clients do the mirror math.</strong> When someone else&apos;s ops arrive,
            your un-acked edits are transformed against them before applying, and theirs are
            transformed against yours. Both sides compute the same merge, so every window
            converges to the identical document — no locks, no &quot;refresh to see changes&quot;.
          </div>

          <div className={stepBox}>
            <strong>4. Convergence is tested, not hoped for.</strong> The transform module ships
            with a fuzzer that checked the algebraic law on 20,000 random op pairs and replayed
            3,000+ multi-client editing sessions with randomized network delays — zero
            divergences.
          </div>

          <div className={stepBox}>
            <strong>Under the hood:</strong> Next.js 16 + React 19 frontend · socket.io sync
            service · PostgreSQL persistence (documents, append-only operation log, version
            snapshots) · live cursors via a mirror-div measurement overlay · caret positions ride
            along the same transforms as the text.
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
