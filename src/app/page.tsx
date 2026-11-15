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
 * Rendering states, in order:
 *   1. `hydrated === false` — splash placeholder while the profile is
 *      read from localStorage (client-only, so SSR/CSR stay consistent).
 *   2. `profile === null`    — NameDialog; identity is display-name +
 *      color only, there is no authentication in this app.
 *   3. `docId === null`      — HomeScreen (document list).
 *   4. otherwise             — EditorScreen for the selected document;
 *      `key={docId}` forces a full remount on document switch so editor
 *      state never leaks between documents.
 */
'use client'

import { useEffect, useState } from 'react'
import { EditorScreen } from '@/components/codoc/editor-screen'
import { HomeScreen } from '@/components/codoc/home-screen'
import { NameDialog, type Profile } from '@/components/codoc/name-dialog'

/**
 * localStorage key for the persisted user profile (display name + cursor
 * color). Versioned ("v1") so a future schema change can migrate.
 */
const STORAGE_KEY = 'codoc-profile-v1'

/**
 * The `/` route. Client component; reads the persisted profile from
 * localStorage shortly after mount, then renders NameDialog, HomeScreen,
 * or EditorScreen depending on the state machine in the module header.
 */
export default function Page() {
  const [hydrated, setHydrated] = useState(false)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [docId, setDocId] = useState<string | null>(null)

  useEffect(() => {
    // Deferred read of localStorage keeps this off the synchronous effect
    // path (and off the hydration render).
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
      setHydrated(true)
    }, 0)
    return () => clearTimeout(t)
  }, [])

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

  if (!docId) {
    return <HomeScreen onOpen={setDocId} />
  }

  return <EditorScreen key={docId} docId={docId} profile={profile} onBack={() => setDocId(null)} />
}
