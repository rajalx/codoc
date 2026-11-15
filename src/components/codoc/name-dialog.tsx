'use client'

/**
 * NameDialog — first-visit identity: display name + cursor color.
 *
 * How it fits in: shown by the App Router page before any editor screen is
 * reachable (persisted profile lives in localStorage under the parent's
 * key). The resulting Profile (name + color) is threaded into
 * `useDocSync`, which sends it with `doc:join`; the server then
 * broadcasts it to peers via `doc:presence`, and every client renders the
 * user's cursor/label in this color (see CollabEditor, PresenceBar).
 *
 * Gotcha: initial name/color come from `Math.random()` in lazy state
 * initializers — fine here because this component only renders
 * client-side after hydration, so SSR output can never mismatch.
 */
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Users } from 'lucide-react'

/**
 * Palette offered for cursor colors. Values are hex strings used directly
 * in inline styles (cursor bar, name label, avatar background) — they are
 * NOT Tailwind theme tokens, so they render identically in light and dark
 * mode. Order is stable so `colorIdx` saved by the parent round-trips.
 */
export const CURSOR_COLORS = [
  '#10b981', // emerald
  '#f43f5e', // rose
  '#f59e0b', // amber
  '#8b5cf6', // violet
  '#14b8a6', // teal
  '#ec4899', // pink
  '#f97316', // orange
  '#84cc16', // lime
]

/** Adjective + animal pools for generated display names ("Swift Panda"). */
const ADJECTIVES = ['Swift', 'Quiet', 'Clever', 'Bright', 'Cosy', 'Brave', 'Lucky', 'Sunny']
const ANIMALS = ['Panda', 'Falcon', 'Otter', 'Lynx', 'Heron', 'Ibex', 'Fox', 'Moth']

/** @returns A random display name from the adjective/animal pools. Used as
 * the dialog's initial value and as a fallback for blank submissions. */
export function randomName(): string {
  return `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]} ${
    ANIMALS[Math.floor(Math.random() * ANIMALS.length)]
  }`
}

/** Local identity handed to the sync hook and presence surfaces. */
export interface Profile {
  /** Display name shown on cursors, labels and presence tooltips. */
  name: string
  /** Hex color (from CURSOR_COLORS) for this user's cursor and avatar. */
  color: string
}

/**
 * Renders the un-dismissable first-run dialog: a name input with a live
 * cursor-color preview and the palette picker.
 *
 * Owns: draft name + selected color index. Persistence (localStorage) is
 * the parent's job — this component only reports the final Profile.
 *
 * @param props.onDone - Called once with the confirmed profile; the parent
 *   is expected to persist it and unmount this dialog.
 */
export function NameDialog({ onDone }: { onDone: (p: Profile) => void }) {
  // Client-only component (renders after hydration), so lazy random init is safe.
  const [name, setName] = useState(() => randomName())
  const [colorIdx, setColorIdx] = useState(() =>
    Math.floor(Math.random() * CURSOR_COLORS.length)
  )

  /** Trim, cap and submit the draft identity; fall back to a generated
   * name when the input is blank. The 40-char cap matches the input's
   * maxLength and keeps presence labels (cursor tag, avatar) readable. */
  const submit = () => {
    const finalName = name.trim().length > 0 ? name.trim().slice(0, 40) : randomName()
    onDone({ name: finalName, color: CURSOR_COLORS[colorIdx] })
  }

  return (
    <Dialog open>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-4 w-4 text-emerald-600" />
            Welcome to CoDoc
          </DialogTitle>
          <DialogDescription>
            Pick a name and a color — they label your live cursor for everyone else in the
            document.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="flex items-center gap-3">
            <div
              className="h-8 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: CURSOR_COLORS[colorIdx] }}
              aria-hidden
            />
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="Your display name"
              maxLength={40}
              aria-label="Display name"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Cursor color:</span>
            {CURSOR_COLORS.map((c, i) => (
              <button
                key={c}
                aria-label={`Choose color ${i + 1}`}
                onClick={() => setColorIdx(i)}
                className={`h-5 w-5 rounded-full transition-transform hover:scale-110 ${
                  i === colorIdx ? 'ring-2 ring-offset-2 ring-offset-background' : ''
                }`}
                style={{ backgroundColor: c, boxShadow: i === colorIdx ? `0 0 0 2px ${c}` : undefined }}
              />
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button onClick={submit} className="w-full bg-emerald-600 hover:bg-emerald-700">
            Start editing
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
