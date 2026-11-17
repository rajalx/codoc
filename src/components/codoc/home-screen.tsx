'use client'

/**
 * HomeScreen — document list (mine + shared with me), create, delete,
 * share, and join-by-key.
 *
 * The landing screen of the app: lists the documents the current user can
 * see (fetched over `/api/documents?user=...`, which returns owned +
 * shared + public docs), split into "My documents" and "Shared with me"
 * sections. Offers a create dialog (document is owned by the current
 * profile), per-owner-card share (ShareDialog) and delete with
 * confirmation, a "Join with key" dialog for invitees, and an entry into
 * the `AboutOTDialog` explainer.
 *
 * How it fits in: rendered by the App Router page once a profile exists;
 * picking a document calls `onOpen(docId)` and the parent swaps in
 * `EditorScreen`, which owns the real-time half of the app (socket.io sync
 * service on port 3003 + OTClient from `src/lib/ot-core.ts`). This screen
 * is pure REST — nothing here talks to the sync service.
 *
 * Gotchas:
 *  - The document list is loaded once on mount and only updated by
 *    optimistic deletes; edits made in the editor are NOT reflected here
 *    until the next full mount. That is acceptable because navigation to
 *    the editor unmounts this screen.
 *  - A failed initial fetch silently leaves `docs` as null (skeletons
 *    forever). There is no retry UI; the next interaction re-triggers via
 *    `load` being stable, so a remount is the recovery path.
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
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/hooks/use-toast'
import {
  FileText,
  History,
  KeyRound,
  MoreVertical,
  Plus,
  Share2,
  Trash2,
  Users,
  Zap,
} from 'lucide-react'
import { AboutOTDialog } from './about-ot'
import { ThemeToggle } from './theme-toggle'
import { ShareDialog } from './share-dialog'
import type { Profile } from './name-dialog'

/** One row in the document grid, as returned by GET /api/documents. */
interface DocSummary {
  id: string
  title: string
  /** Server-side OT revision at the time of the summary. */
  revision: number
  /** ISO 8601 timestamp of the last update. */
  updatedAt: string
  /** Short plain-text prefix of the document body (may be empty). */
  preview: string
  /** Body length in characters. */
  chars: number
  /** Owner's display name ("" = public document). */
  owner: string
  /** This user's relationship to the document. */
  role: 'owner' | 'collaborator' | 'public'
}

/** Render a relative "N min ago" style label from an ISO timestamp. */
function timeAgo(iso: string): string {
  // Deliberately minute/hour/day granularity; seconds always read "just now"
  // so the label does not flicker while the list is on screen.
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

/** Document card grid shared by the "my" and "shared" sections. */
function DocCard({
  d,
  onOpen,
  onShare,
  onDelete,
}: {
  d: DocSummary
  onOpen: (id: string) => void
  onShare: (id: string) => void
  onDelete: (id: string) => void
}) {
  const canManage = d.role === 'owner' || d.role === 'public'
  return (
    <div
      role="button"
      aria-label={`Open ${d.title}`}
      tabIndex={0}
      onClick={() => onOpen(d.id)}
      onKeyDown={(e) => e.key === 'Enter' && onOpen(d.id)}
      className="group flex cursor-pointer flex-col justify-between gap-3 rounded-xl border bg-card p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate font-medium">{d.title}</h2>
          <p className="mt-1 line-clamp-2 min-h-8 text-xs text-muted-foreground">
            {d.preview || 'Empty document'}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              aria-label={`Options for ${d.title}`}
              onClick={(e) => e.stopPropagation()}
            >
              {/* stopPropagation: the kebab lives inside the card's
                  click-to-open surface; without it the menu toggle
                  would also navigate into the editor. */}
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            {/* Share/delete are management actions: only meaningful for the
                owner (or public docs). The API enforces this too. */}
            {canManage && (
              <DropdownMenuItem onClick={() => onShare(d.id)}>
                <Share2 className="mr-2 h-4 w-4" />
                Share
              </DropdownMenuItem>
            )}
            {canManage && (
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => onDelete(d.id)}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </DropdownMenuItem>
            )}
            {!canManage && (
              <DropdownMenuItem disabled className="text-muted-foreground">
                <Users className="mr-2 h-4 w-4" />
                Shared by {d.owner}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <History className="h-3 w-3" />
          rev {d.revision}
        </span>
        <span>{d.chars} chars</span>
        {d.role === 'collaborator' && (
          <span className="flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5">
            <Users className="h-3 w-3" />
            shared
          </span>
        )}
        <span className="ml-auto">{timeAgo(d.updatedAt)}</span>
      </div>
    </div>
  )
}

/**
 * Renders the document dashboard: sticky header (branding, theme toggle,
 * "How sync works"), a "Join with key" entry, responsive card grids for
 * owned and shared documents, footer, and the create/delete/share/join
 * dialogs.
 *
 * Owns: the `docs` list state (null = still loading, rendered as
 * skeletons), and the create/delete/share/join dialog lifecycles.
 *
 * @param props.profile - Local identity (name + color); the name drives
 *   the visibility query (?user=) and document ownership.
 * @param props.onOpen - Callback invoked with the chosen document id. The
 *   parent uses it to swap this screen for `EditorScreen`.
 */
export function HomeScreen({
  profile,
  onOpen,
}: {
  profile: Profile
  onOpen: (docId: string) => void
}) {
  // `docs === null` means "never loaded"; an empty array means the server
  // genuinely has no visible documents, which renders the empty state.
  const [docs, setDocs] = useState<DocSummary[] | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [shareId, setShareId] = useState<string | null>(null)
  const [shareOpen, setShareOpen] = useState(false)
  const [joinOpen, setJoinOpen] = useState(false)
  const [joinKey, setJoinKey] = useState('')
  const [joining, setJoining] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const { toast } = useToast()

  const load = useCallback(async () => {
    try {
      // no-store: the list must reflect recent edits/creates, never a
      // cached route-handler response. The user param scopes the list to
      // this profile (owned + shared + public).
      const res = await fetch(
        `/api/documents?user=${encodeURIComponent(profile.name)}`,
        { cache: 'no-store' }
      )
      if (res.ok) setDocs(await res.json())
    } catch {
      // Non-HTTP failure (network down): keep the skeleton state rather
      // than showing an empty list that would read as "no documents".
    }
  }, [profile.name])

  useEffect(() => {
    load()
  }, [load])

  /** POST a new document (owned by this profile) and open its editor. */
  const createDoc = async () => {
    setCreating(true)
    try {
      const res = await fetch('/api/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle, owner: profile.name }),
      })
      if (res.ok) {
        const doc = await res.json()
        onOpen(doc.id)
      } else {
        toast({ title: 'Could not create document', variant: 'destructive' })
      }
    } finally {
      // Reset unconditionally (success or failure) so the dialog never
      // reopens with a stale half-submitted title or a stuck spinner.
      setCreating(false)
      setCreateOpen(false)
      setNewTitle('')
    }
  }

  /**
   * DELETE a document (owner-only, enforced server-side too), then
   * optimistically remove it from local state. The request is
   * fire-and-forget: if it fails the card vanishes anyway and the list
   * self-corrects on the next remount. Clearing `deleteId` first closes
   * the confirmation dialog without waiting on the network.
   */
  const deleteDoc = async (id: string) => {
    setDeleteId(null)
    await fetch(
      `/api/documents/${id}?user=${encodeURIComponent(profile.name)}`,
      { method: 'DELETE' }
    ).catch(() => {})
    setDocs((d) => (d ? d.filter((x) => x.id !== id) : d))
  }

  /** Open the ShareDialog for a document. */
  const shareDoc = (id: string) => {
    setShareId(id)
    setShareOpen(true)
  }

  /**
   * POST the pasted share key to the join endpoint; on success navigate
   * straight into the document. 404 ("Invalid share key") surfaces as a
   * toast so the user can retry without the dialog closing.
   */
  const joinByKey = async () => {
    const key = joinKey.trim()
    if (!key) return
    setJoining(true)
    try {
      const res = await fetch('/api/documents/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shareKey: key, user: profile.name }),
      })
      const body = await res.json().catch(() => ({}))
      if (res.ok) {
        setJoinOpen(false)
        setJoinKey('')
        onOpen(body.id)
      } else {
        toast({
          title: 'Could not join',
          description: body?.error ?? 'Check the key and try again.',
          variant: 'destructive',
        })
      }
    } catch {
      toast({ title: 'Could not join', variant: 'destructive' })
    } finally {
      setJoining(false)
    }
  }

  // Looked up by id (not stored as the object) so the confirm dialog shows
  // the right title even if `docs` is re-fetched while the dialog is open.
  const pendingDelete = docs?.find((d) => d.id === deleteId) ?? null
  const mine = docs?.filter((d) => d.role !== 'collaborator') ?? []
  const shared = docs?.filter((d) => d.role === 'collaborator') ?? []

  const renderGrid = (list: DocSummary[]) => (
    <div className="grid gap-3 sm:grid-cols-2">
      {list.map((d) => (
        <DocCard key={d.id} d={d} onOpen={onOpen} onShare={shareDoc} onDelete={deleteDoc} />
      ))}
    </div>
  )

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-4xl items-center justify-between gap-2 px-4">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-emerald-600 text-sm font-bold text-white">
              C
            </div>
            <span className="text-lg font-semibold tracking-tight">CoDoc</span>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setAboutOpen(true)}>
              <Zap className="h-4 w-4" />
              <span className="hidden sm:inline">How sync works</span>
            </Button>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Collaborative workspace</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Signed in as <span className="font-medium text-foreground">{profile.name}</span> —
              you only see documents you own or were invited to.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" className="gap-1.5" onClick={() => setJoinOpen(true)}>
              <KeyRound className="h-4 w-4" />
              Join with key
            </Button>
            <Button
              onClick={() => setCreateOpen(true)}
              className="gap-1.5 bg-emerald-600 hover:bg-emerald-700"
            >
              <Plus className="h-4 w-4" />
              New document
            </Button>
          </div>
        </div>

        {docs === null ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Skeleton className="h-28 rounded-xl" />
            <Skeleton className="h-28 rounded-xl" />
            <Skeleton className="h-28 rounded-xl" />
            <Skeleton className="h-28 rounded-xl" />
          </div>
        ) : docs.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-20 text-center">
            <FileText className="mb-3 h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No documents yet — create your first one, or join with a share key.
            </p>
          </div>
        ) : (
          <div className="space-y-8">
            {mine.length > 0 && (
              <section>
                <h2 className="mb-3 text-sm font-medium text-muted-foreground">
                  My documents ({mine.length})
                </h2>
                {renderGrid(mine)}
              </section>
            )}
            {shared.length > 0 && (
              <section>
                <h2 className="mb-3 text-sm font-medium text-muted-foreground">
                  Shared with me ({shared.length})
                </h2>
                {renderGrid(shared)}
              </section>
            )}
          </div>
        )}
      </main>

      <footer className="mt-auto border-t">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5" />
            CoDoc - real-time collaborative Markdown editor
          </span>
        </div>
      </footer>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New document</DialogTitle>
            <DialogDescription>
              Give it a title — you can rename it any time. You will be the owner and can
              invite others with a share key.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createDoc()}
            placeholder="Untitled document"
            maxLength={120}
            aria-label="Document title"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={createDoc} disabled={creating} className="bg-emerald-600 hover:bg-emerald-700">
              {creating ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Join with key dialog */}
      <Dialog open={joinOpen} onOpenChange={setJoinOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-emerald-600" />
              Join with a share key
            </DialogTitle>
            <DialogDescription>
              Paste the key a document owner shared with you — you will get edit access.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={joinKey}
            onChange={(e) => setJoinKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && joinByKey()}
            placeholder="e.g. k4f2mq9x"
            aria-label="Share key"
            className="font-mono tracking-widest uppercase"
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setJoinOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={joinByKey}
              disabled={joining || joinKey.trim().length === 0}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              {joining ? 'Joining…' : 'Join document'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Share dialog (owner only; opens per selected document) */}
      <ShareDialog
        docId={shareId}
        user={profile.name}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />

      {/* Delete confirm */}
      <AlertDialog open={deleteId !== null} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this document?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? `"${pendingDelete.title}" and its entire version history will be permanently removed.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteId && deleteDoc(deleteId)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AboutOTDialog open={aboutOpen} onOpenChange={setAboutOpen} />
    </div>
  )
}
