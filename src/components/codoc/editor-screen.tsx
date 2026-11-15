'use client'

/**
 * EditorScreen — header + split editor/preview + status bar, wired to the
 * sync hook. One screen, everything live.
 *
 * How it fits in: this is the real-time half of the app. It mounts
 * `useDocSync(docId, ...)` for the active document, which owns the single
 * socket.io connection to the sync service (port 3003) and the OTClient
 * (src/lib/ot-core.ts). Everything below consumes the hook's returned API:
 * `text`, `cursors`, `users`, revision/pending/status, snapshot and restore
 * actions, and the error channel. Layout/persistence concerns (title
 * renames, view mode) live here; OT math never touches this file.
 *
 * Key invariants:
 *  - The screen is keyed by `docId` in the parent, so state (title, view
 *    mode, editor caret) resets naturally per document and `useDocSync`'s
 *    socket setup effect runs exactly once per document.
 *  - `editorApiRef` is the hand-off point to `CollabEditor`: the sync hook
 *    reads the caret from it when remote ops arrive, and CollabEditor
 *    populates it on mount.
 *  - `titleDirty` guards against the async title fetch clobbering a name
 *    the user has already started renaming.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/hooks/use-toast'
import {
  ArrowLeft,
  Check,
  CloudOff,
  Columns2,
  Eye,
  History,
  Info,
  Loader2,
  Pencil,
  Save,
  Wifi,
} from 'lucide-react'
import { AboutOTDialog } from './about-ot'
import { CollabEditor } from './collab-editor'
import { MarkdownPreview } from './markdown-preview'
import { PresenceBar } from './presence-bar'
import { ThemeToggle } from './theme-toggle'
import { VersionPanel } from './version-panel'
import { useDocSync, type EditorApi } from './use-doc-sync'
import type { Profile } from './name-dialog'

/** Which panes are visible: editor only, editor+preview side by side, or preview only. */
type ViewMode = 'edit' | 'split' | 'preview'

/**
 * Renders the full editor chrome — header (back button, inline-editable
 * title, presence bar, connection status, snapshot/history/view actions),
 * the body (CollabEditor and/or MarkdownPreview in a resizable split), a
 * status bar (revision, word/char counts, sync state), and the
 * VersionPanel sheet.
 *
 * Coordinates: does not own any sync state itself — it threads
 * `useDocSync`'s API down to CollabEditor and surfaces status to the user.
 *
 * @param props.docId - Active document id; the parent must key this screen
 *   on it so per-document state is discarded on navigation.
 * @param props.profile - Local identity (name + cursor color) established
 *   by NameDialog; forwarded to presence and the sync hook.
 * @param props.onBack - Callback to leave the editor (returns to
 *   HomeScreen, which unmounts this screen and drops the socket).
 */
export function EditorScreen({
  docId,
  profile,
  onBack,
}: {
  docId: string
  profile: Profile
  onBack: () => void
}) {
  const editorApiRef = useRef<EditorApi | null>(null)
  // One sync session per mounted screen; editorApiRef is populated by
  // CollabEditor and read by useDocSync when remote ops must transform the
  // user's caret.
  const sync = useDocSync(docId, profile.name, profile.color, editorApiRef)
  const { toast } = useToast()

  // null until the first successful fetch, which is also the "disable the
  // title input" signal (avoids a flash of "Untitled document").
  const [title, setTitle] = useState<string | null>(null)
  // True while the user is mid-rename; prevents the in-flight title fetch
  // from overwriting what they are typing (classic race between load and
  // local edit). Cleared on save/blur.
  const [titleDirty, setTitleDirty] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('split')
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)

  // Load the document title. The screen is remounted per doc (key={docId}),
  // so this effect runs once per document.
  useEffect(() => {
    let cancelled = false
    fetch(`/api/documents/${docId}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        if (!cancelled && !titleDirty) setTitle(d.title)
      })
      .catch(() => {
        if (!cancelled) setTitle('Untitled document')
      })
    return () => {
      cancelled = true
    }
  }, [docId])

  // Surface sync errors as toasts.
  useEffect(() => {
    if (sync.docError) {
      // clearError() resets the hook's error state so a repeat of the same
      // message (same string) still fires this effect again instead of
      // being deduplicated by reference equality.
      toast({ title: 'Sync problem', description: sync.docError, variant: 'destructive' })
      sync.clearError()
    }
  }, [sync.docError])

  /**
   * Persist the renamed title via PATCH. Runs on blur or Enter; nothing
   * happens for empty titles. Best-effort: a failed PATCH is swallowed and
   * the local title keeps the user's value until reload.
   */
  const saveTitle = useCallback(async () => {
    setTitleDirty(false)
    const t = (title ?? '').trim()
    if (!t || !docId) return
    await fetch(`/api/documents/${docId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: t }),
    }).catch(() => {})
  }, [title, docId])

  // Cheap derived stats for the status bar; recomputed per render on the
  // merged document text (trimming yields word count in the usual way).
  const words = sync.text.trim() ? sync.text.trim().split(/\s+/).length : 0

  // Connection state indicator, derived from the sync hook's status
  // machine ('connecting' | 'live' | 'offline'). "Offline — edits kept"
  // reflects the hook's behavior: offline edits accumulate in the OT
  // client's buffer and are replayed on reconnect.
  const statusDot =
    sync.status === 'live' ? (
      <span className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
        <Wifi className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Live</span>
      </span>
    ) : sync.status === 'connecting' ? (
      <span className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span className="hidden sm:inline">Connecting</span>
      </span>
    ) : (
      <span className="flex items-center gap-1.5 text-xs text-destructive">
        <CloudOff className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Offline — edits kept</span>
      </span>
    )

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {/* Header */}
      <header className="flex h-14 shrink-0 items-center gap-1.5 border-b px-2 sm:gap-2 sm:px-3">
        <Button variant="ghost" size="icon" aria-label="Back to documents" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-emerald-600 text-sm font-bold text-white">
          C
        </div>
        <input
          value={title ?? ''}
          onChange={(e) => {
            setTitle(e.target.value)
            setTitleDirty(true)
          }}
          onBlur={saveTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          disabled={title === null}
          aria-label="Document title"
          placeholder="Untitled document"
          className="min-w-0 max-w-48 flex-1 truncate rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-medium outline-none hover:border-border focus:border-border sm:max-w-xs"
        />
        <div className="ml-auto flex items-center gap-1.5 sm:gap-3">
          <PresenceBar users={sync.users} meName={profile.name} meColor={profile.color} />
          {statusDot}
        </div>
        <div className="flex items-center gap-0.5 sm:gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Save version"
            title="Save version"
            onClick={() => {
              sync.saveSnapshot('Manual save')
              toast({ title: 'Snapshot queued', description: 'It will appear in the version timeline.' })
            }}
          >
            <Save className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Version history"
            title="Version history"
            onClick={() => setVersionsOpen(true)}
          >
            <History className="h-4 w-4" />
          </Button>
          <div className="mx-0.5 hidden items-center rounded-md border sm:flex" role="group" aria-label="View mode">
            {(
              [
                ['edit', Pencil, 'Editor only'],
                ['split', Columns2, 'Split view'],
                ['preview', Eye, 'Preview only'],
              ] as const
            ).map(([mode, Icon, label]) => (
              <Button
                key={mode}
                variant="ghost"
                size="icon"
                aria-label={label}
                title={label}
                className={`h-8 w-8 rounded-none first:rounded-l-md last:rounded-r-md ${
                  viewMode === mode ? 'bg-muted' : ''
                }`}
                onClick={() => setViewMode(mode)}
              >
                <Icon className="h-4 w-4" />
              </Button>
            ))}
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="How sync works"
            title="How sync works"
            onClick={() => setAboutOpen(true)}
          >
            <Info className="h-4 w-4" />
          </Button>
          <ThemeToggle />
        </div>
      </header>

      {/* Body: skeleton until doc:init lands and the hook flips `joined`.
          CollabEditor is mounted identically in 'edit' and 'split' modes so
          its internal state (caret restore refs, throttle timers) survives
          view-mode switches. */}
      <main className="flex min-h-0 flex-1">
        {!sync.joined ? (
          <div className="flex flex-1 flex-col gap-3 p-6">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="mt-4 h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        ) : viewMode === 'split' ? (
          <ResizablePanelGroup direction="horizontal" className="flex-1">
            <ResizablePanel defaultSize={50} minSize={25}>
              <CollabEditor
                text={sync.text}
                cursors={sync.cursors}
                users={sync.users}
                onLocalChange={sync.localChange}
                onCursor={sync.sendCursor}
                editorApiRef={editorApiRef}
              />
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={50} minSize={20}>
              <MarkdownPreview content={sync.text} />
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : viewMode === 'edit' ? (
          <CollabEditor
            text={sync.text}
            cursors={sync.cursors}
            users={sync.users}
            onLocalChange={sync.localChange}
            onCursor={sync.sendCursor}
            editorApiRef={editorApiRef}
          />
        ) : (
          <div className="min-h-0 flex-1">
            <MarkdownPreview content={sync.text} />
          </div>
        )}
      </main>

      {/* Status bar */}
      <footer className="flex h-8 shrink-0 items-center gap-4 border-t px-3 text-[11px] text-muted-foreground">
        <span title="Server revision — every applied operation batch increments it">
          rev {sync.revision}
        </span>
        <span>{words} words</span>
        <span>{sync.text.length} chars</span>
        {sync.pending ? (
          <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
            <Loader2 className="h-3 w-3 animate-spin" />
            Syncing…
          </span>
        ) : (
          <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
            <Check className="h-3 w-3" />
            All changes synced
          </span>
        )}
        <span className="ml-auto hidden sm:inline">
          {sync.users.length} editor{sync.users.length === 1 ? '' : 's'} · CoDoc
        </span>
      </footer>

      <VersionPanel
        docId={docId}
        open={versionsOpen}
        onOpenChange={setVersionsOpen}
        // Monotonic counter from the hook; each increment means a new
        // snapshot was created server-side and the list should refetch.
        snapshotSignal={sync.snapshotSignal}
        onRestore={(vid) => {
          // Restores are broadcast by the server as doc:reset to all
          // clients (including us); no local text mutation here.
          sync.restoreVersion(vid)
          toast({ title: 'Restoring version…', description: 'Everyone will jump to it.' })
        }}
      />
      <AboutOTDialog open={aboutOpen} onOpenChange={setAboutOpen} />
    </div>
  )
}
