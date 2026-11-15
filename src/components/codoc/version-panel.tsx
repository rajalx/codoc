'use client'

/**
 * VersionPanel — the version timeline (right-hand sheet).
 * Lists snapshots, previews the selected one, restores with confirmation.
 *
 * How it fits in: mounted by `EditorScreen` and opened from the header's
 * history button. Version data flows over plain REST
 * (GET /api/documents/:id/versions); restoring goes through the real-time
 * path instead — `onRestore` -> `useDocSync.restoreVersion` -> socket.io
 * `doc:restore` event -> the server broadcasts `doc:reset` to every
 * client, so all editors converge on the snapshot text via the OTClient
 * reset path. Nothing here mutates local document text directly.
 *
 * Gotcha: the panel fetches when `open` flips true AND whenever
 * `snapshotSignal` increments, so it stays current while the sheet sits
 * open and new snapshots land in the background.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { History, RotateCcw, FileText } from 'lucide-react'
import { MarkdownPreview } from './markdown-preview'

/** One snapshot entry, as returned by GET /api/documents/:id/versions. */
interface DocVersion {
  id: string
  /** Server OT revision the snapshot was cut at. */
  revision: number
  /** Human label ("Manual save", "Autosave", …). */
  label: string
  /** Display name of the user who created the snapshot. */
  author: string
  /** ISO 8601 creation timestamp. */
  createdAt: string
  /** Snapshot body length in characters. */
  chars: number
  /** Full document text of the snapshot (used for previewing). */
  content: string
}

/**
 * Renders the version-history side sheet: a scrollable snapshot list, an
 * inline Markdown preview of the selected version, a restore action with
 * confirmation dialog, and empty/loading states.
 *
 * Owns: version list + selection + confirm-dialog state. Does NOT apply
 * restores itself — that is delegated to `onRestore` (the real-time
 * broadcast path).
 *
 * @param props.docId - Active document id; versions are fetched per this
 *   id. The parent remounts per document, so no per-doc state reset needed.
 * @param props.open - Controlled open flag for the Sheet.
 * @param props.onOpenChange - Open-state change handler from the parent.
 * @param props.snapshotSignal - Monotonic counter from useDocSync that
 *   increments on every `doc:snapshot-created` event; each increment
 *   triggers a refetch so the timeline updates live while open.
 * @param props.onRestore - Called with the confirmed version id; the
 *   parent routes it through the socket (`doc:restore`).
 */
export function VersionPanel({
  docId,
  open,
  onOpenChange,
  snapshotSignal,
  onRestore,
}: {
  docId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  snapshotSignal: number
  onRestore: (versionId: string) => void
}) {
  const [versions, setVersions] = useState<DocVersion[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<DocVersion | null>(null)
  // id (not object) of the version awaiting restore confirmation; keeps
  // the dialog stable across background refetches.
  const [confirmId, setConfirmId] = useState<string | null>(null)

  /**
   * Fetch the snapshot list from the API route. On success, keep the
   * currently selected version selected if it still exists; otherwise
   * fall back to the newest entry (data[0] — the endpoint returns newest
   * first). Swallowed errors are acceptable: the next snapshotSignal
   * increment retries the fetch.
   */
  const fetchVersions = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/documents/${docId}/versions`, { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setVersions(data)
        // Preserve the user's selection across refetches; matching by id
        // (not index) survives new snapshots being prepended.
        setSelected((prev) => (prev ? data.find((v: DocVersion) => v.id === prev.id) ?? data[0] : data[0] ?? null))
      }
    } catch {
      // network hiccup; next snapshot signal will retry
    } finally {
      setLoading(false)
    }
  }, [docId])

  // Fetch on open, and refetch live while open as snapshots are created
  // (snapshotSignal comes from the doc:snapshot-created socket event, so
  // autosaves and other users' manual saves both land here).
  useEffect(() => {
    if (open) fetchVersions()
  }, [open, snapshotSignal, fetchVersions])

  // Resolved by id so the confirm dialog text stays correct if the list is
  // refetched while the dialog is open.
  const pendingRestore = versions.find((v) => v.id === confirmId) ?? null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b px-4 py-4">
          <SheetTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4" />
            Version timeline
          </SheetTitle>
          <SheetDescription className="text-xs">
            Snapshots are cut automatically as you edit — or with the Save version button.
            Restoring a version broadcasts it to every editor instantly.
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col">
          <ScrollArea className="max-h-64 shrink-0 border-b">
            <div className="flex flex-col gap-1 p-2">
              {loading && versions.length === 0 && (
                <p className="px-2 py-6 text-center text-sm text-muted-foreground">Loading…</p>
              )}
              {!loading && versions.length === 0 && (
                <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                  No versions yet — start typing, snapshots appear automatically.
                </p>
              )}
              {versions.map((v) => (
                <button
                  key={v.id}
                  onClick={() => setSelected(v)}
                  className={`flex flex-col items-start gap-1 rounded-md border px-3 py-2 text-left transition-colors ${
                    selected?.id === v.id
                      ? 'border-primary/60 bg-primary/10'
                      : 'border-transparent hover:bg-muted'
                  }`}
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{v.label}</span>
                    <Badge variant="secondary" className="shrink-0 text-[10px]">
                      rev {v.revision}
                    </Badge>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {new Date(v.createdAt).toLocaleString()} · {v.author} · {v.chars} chars
                  </span>
                </button>
              ))}
            </div>
          </ScrollArea>

          <div className="flex min-h-0 flex-1 flex-col">
            {selected ? (
              <>
                <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <FileText className="h-3.5 w-3.5" />
                    Preview — {selected.label}
                  </span>
                  {/* Two-phase restore: stage the id, AlertDialog confirms,
                      then hand off to onRestore (socket broadcast). */}
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 text-xs"
                    onClick={() => setConfirmId(selected.id)}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Restore
                  </Button>
                </div>
                <div className="min-h-0 flex-1 border-t-0">
                  <MarkdownPreview content={selected.content} />
                </div>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
                Select a version to preview it
              </div>
            )}
          </div>
        </div>
      </SheetContent>

      <AlertDialog open={confirmId !== null} onOpenChange={(o) => !o && setConfirmId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore this version?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRestore
                ? `"${pendingRestore.label}" (rev ${pendingRestore.revision}, ${new Date(
                    pendingRestore.createdAt
                  ).toLocaleString()}) will replace the current text for everyone in this document. A new snapshot of the current state is kept in the timeline.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                // Fire-and-forget hand-off: the server broadcasts doc:reset
                // and every client (including this one) applies it via the
                // OT reset path; a pre-restore snapshot is kept server-side
                // so this is undoable.
                if (confirmId) onRestore(confirmId)
                setConfirmId(null)
              }}
            >
              Restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  )
}
