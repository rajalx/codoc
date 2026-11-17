/**
 * CoDoc — a real-time collaborative Markdown editor.
 * App shell: Home (document list) <-> Editor (live multi-user editing),
 * gated by an onboarding name dialog.
 *
 * Data sources reached from this shell:
 *   - Next.js REST API (/api/documents...) for listing, creating,
 *     renaming and deleting documents (PostgreSQL via Prisma).
 *   - The socket.io sync service on port 3003 for live editing, presence
 *     and version snapshots (opened by EditorScreen, not here).
 *
 * Share-key flow: a document owner hands out a key (or a link of the form
 * `/?join=<key>`). When this page loads with a `join` parameter, the shell
 * POSTs it to /api/documents/join once a profile exists, records the
 * current display name as a collaborator, and lands directly in the
 * editor. A failed join (bad key) renders a retry screen instead of the
 * home list.
 *
 * Rendering states, in order:
 *   1. `hydrated === false` — splash placeholder while the profile is
 *      read from localStorage (client-only, so SSR/CSR stay consistent).
 *   2. `profile === null`    — NameDialog; identity is display-name +
 *      color only, there is no authentication in this app.
 *   3. `joinKey && joined`   — resolves the share key (see above).
 *   4. `docId === null`      — HomeScreen (scoped document list).
 *   5. otherwise             — EditorScreen for the selected document;
 *      `key={docId}` forces a full remount on document switch so editor
 *      state never leaks between documents.
 */
'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { EditorScreen } from '@/components/codoc/editor-screen'
import { HomeScreen } from '@/components/codoc/home-screen'
import { NameDialog, type Profile } from '@/components/codoc/name-dialog'
import { ShieldAlert } from 'lucide-react'

/**
 * localStorage key for the persisted user profile (display name + cursor
 * color). Versioned ("v1") so a future schema change can migrate.
 */
const STORAGE_KEY = 'codoc-profile-v1'

/**
 * The `/` route. Client component; reads the persisted profile from
 * localStorage shortly after mount, resolves an optional `?join=` share
 * key, then renders NameDialog, HomeScreen, or EditorScreen depending on
 * the state machine in the module header.
 */
export default function Page() {
  const [hydrated, setHydrated] = useState(false)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [docId, setDocId] = useState<string | null>(null)
  // Share-key invite: raw `?join=` value, plus join result state.
  const [joinKey, setJoinKey] = useState<string | null>(null)
  const [joinBusy, setJoinBusy] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)

  useEffect(() => {
    // Deferred read of localStorage keeps this off the synchronous effect
    // path (and off the hydration render). Also captures a `?join=` share
    // key so an invite link works even before a profile exists.
    const t = setTimeout(() => {
      let p: Profile | null = null
      try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (raw) {
          const parsed = JSON.parse(raw)
          if (typeof parsed?.name === 'string' && typeof parsed?.color === 'string') {
            p = { name: parsed.name.slice(0, 40), color: parsed.color }
          }
        }
      } catch {
        // corrupted storage -> ask again
      }
      setProfile(p)
      try {
        const key = new URLSearchParams(window.location.search).get('join')
        if (key) {
          setJoinKey(key.trim().slice(0, 40))
          // Clean the address bar so refreshes don't re-trigger the join.
          window.history.replaceState({}, '', window.location.pathname)
        }
      } catch {
        // no history API (shouldn't happen in a browser) -> ignore the key
      }
      setHydrated(true)
    }, 0)
    return () => clearTimeout(t)
  }, [])

  /**
   * Resolve a share key into a collaborator record and open the document.
   * Runs once a profile exists (after NameDialog if this was the first
   * visit). Success swaps this shell for the editor; failure shows the
   * retry screen via `joinError`.
   */
  const resolveJoin = useCallback(async (key: string, user: string) => {
    setJoinBusy(true)
    setJoinError(null)
    try {
      const res = await fetch('/api/documents/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shareKey: key, user }),
      })
      const body = await res.json().catch(() => ({}))
      if (res.ok) {
        setJoinKey(null)
        setDocId(body.id)
      } else {
        setJoinError(body?.error ?? 'Invalid share key')
      }
    } catch {
      setJoinError('Could not reach the server')
    } finally {
      setJoinBusy(false)
    }
  }, [])

  // Kick off the join once identity is known (also after NameDialog on a
  // first visit via an invite link). Deferred by a tick so the state
  // updates inside resolveJoin don't fire synchronously within the effect.
  useEffect(() => {
    if (joinKey && profile && !joinBusy && !joinError) {
      const t = setTimeout(() => resolveJoin(joinKey, profile.name), 0)
      return () => clearTimeout(t)
    }
  }, [joinKey, profile, joinBusy, joinError, resolveJoin])

  // Persist the profile, then apply it. Storage failures (private mode,
  // quota) degrade to a session-only identity rather than blocking entry.
  const handleProfile = (p: Profile) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
    } catch {
      // private mode: session-only identity
    }
    setProfile(p)
  }

  if (!hydrated) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex h-10 w-10 animate-pulse items-center justify-center rounded-lg bg-emerald-600 text-lg font-bold text-white">
          C
        </div>
      </div>
    )
  }

  if (!profile) {
    return <NameDialog onDone={handleProfile} />
  }

  // Share-key invite failed (bad key / unreachable server): explain and
  // let the user back out to their own documents.
  if (joinError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
        <ShieldAlert className="h-10 w-10 text-amber-500" />
        <div>
          <h1 className="text-lg font-semibold">Could not join with that key</h1>
          <p className="mt-1 text-sm text-muted-foreground">{joinError}</p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            setJoinKey(null)
            setJoinError(null)
          }}
        >
          Back to documents
        </Button>
      </div>
    )
  }

  // Resolving an invite link: brief inline spinner while POSTing.
  if (joinKey) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-3 text-sm text-muted-foreground">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-emerald-600 border-t-transparent" />
        Opening shared document…
      </div>
    )
  }

  if (!docId) {
    return <HomeScreen profile={profile} onOpen={setDocId} />
  }

  return <EditorScreen key={docId} docId={docId} profile={profile} onBack={() => setDocId(null)} />
}
