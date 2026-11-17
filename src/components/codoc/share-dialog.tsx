'use client'

/**
 * ShareDialog — invite flow via share key.
 *
 * How it fits in: opened from the home screen's per-card "Share" action
 * and the editor header's share button (owner only — the API enforces
 * this; the UI hides the entry points for non-owners). Fetches the
 * document's share key from GET /api/documents/[id]/share?user=..., then
 * presents it with two copy actions: copy the raw key (to paste into the
 * "Join with key" dialog) and copy the full join link
 * (`{origin}/?join={key}`), which lands the invitee on the join flow
 * handled by the App Router page.
 *
 * Gotcha: the key is fetched lazily when the dialog opens (not on page
 * load) so opening the home screen never triggers share requests.
 */

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useToast } from '@/hooks/use-toast'
import { Check, Copy, Loader2, Share2 } from 'lucide-react'

/**
 * Renders the share dialog for one document.
 *
 * @param props.docId - Document whose key is shown; null closes the dialog.
 * @param props.user - Requester's display name (sent for the owner check).
 * @param props.onOpenChange - Open/close callback from the Dialog.
 */
export function ShareDialog({
  docId,
  user,
  open,
  onOpenChange,
}: {
  docId: string | null
  user: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [shareKey, setShareKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<'key' | 'link' | null>(null)
  const { toast } = useToast()

  /**
   * Close handler doubles as the state reset: closing the dialog clears
   * the fetched key/error/copied flags synchronously here (outside any
   * effect) so reopening always starts fresh.
   */
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setShareKey(null)
      setError(null)
      setCopied(null)
    }
    onOpenChange(next)
  }

  // Fetch the key when the dialog opens; async setStates only (after
  // await), so no synchronous setState runs inside the effect body.
  useEffect(() => {
    if (!open || !docId) return
    let cancelled = false
    fetch(`/api/documents/${docId}/share?user=${encodeURIComponent(user)}`, {
      cache: 'no-store',
    })
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}))
          throw new Error(body?.error ?? 'Could not load the share key')
        }
        return r.json()
      })
      .then((d) => {
        if (!cancelled) setShareKey(d.shareKey)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [open, docId, user])

  /** Clipboard write with a transient "copied" affordance on the button. */
  const copy = async (text: string, what: 'key' | 'link') => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      toast({
        title: 'Copy failed',
        description: 'Select and copy the value manually.',
        variant: 'destructive',
      })
    }
  }

  const joinLink = shareKey ? `${window.location.origin}/?join=${shareKey}` : ''

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="h-4 w-4 text-emerald-600" />
            Invite collaborators
          </DialogTitle>
          <DialogDescription>
            Anyone with this key (or link) can join and edit this document.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="py-4 text-sm text-destructive">{error}</p>
        ) : shareKey === null ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading share key…
          </div>
        ) : (
          <div className="space-y-3 py-1">
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={shareKey}
                aria-label="Share key"
                className="font-mono text-lg tracking-widest uppercase"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                variant="outline"
                size="icon"
                aria-label="Copy share key"
                title="Copy key"
                onClick={() => copy(shareKey, 'key')}
              >
                {copied === 'key' ? (
                  <Check className="h-4 w-4 text-emerald-600" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={joinLink}
                aria-label="Share link"
                className="text-xs text-muted-foreground"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                variant="outline"
                size="icon"
                aria-label="Copy share link"
                title="Copy link"
                onClick={() => copy(joinLink, 'link')}
              >
                {copied === 'link' ? (
                  <Check className="h-4 w-4 text-emerald-600" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              They enter the key on their documents screen, or just open the link.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
