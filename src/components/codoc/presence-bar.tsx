'use client'

/**
 * PresenceBar — overlapping colored avatars of everyone in the document.
 *
 * How it fits in: rendered in `EditorScreen`'s header with the presence
 * list from `useDocSync` (the `doc:presence` socket event, minus the local
 * user, as maintained by the sync service). Pure presentation — no
 * network, no state, no connection to the OT path.
 *
 * Gotcha: `users` may legitimately be empty while the local user is still
 * listed server-side; in that case we render the local user's own avatar
 * so the bar never shows an empty group.
 */
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { PresenceUser } from './use-doc-sync'

/**
 * Derive up to two uppercase initials from a display name. Falls back to
 * the first two characters when the name has no word boundary, and
 * tolerates single-character words via optional indexing.
 */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

/**
 * Renders the avatar cluster: up to five overlapping, color-coded avatars
 * with name tooltips, a "+N" overflow counter, an "N online" caption, and
 * a self-avatar fallback when the presence list is still empty.
 *
 * @param props.users - Remote presence entries from the sync hook; each
 *   carries the id/name/color assigned at doc:join. The local user is
 *   already excluded server-side.
 * @param props.meName - Local user's display name (used for the fallback
 *   avatar and its "you" tooltip only).
 * @param props.meColor - Local user's cursor color (fallback avatar only).
 */
export function PresenceBar({
  users,
  meName,
  meColor,
}: {
  users: PresenceUser[]
  meName: string
  meColor: string
}) {
  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex items-center" role="group" aria-label="Editors in this document">
        <div className="flex -space-x-2">
          {/* Hard cap at 5 avatars; overflow is summarized by "+N" below.
              Keeps the header cluster bounded for crowded documents. */}
          {users.slice(0, 5).map((u) => (
            <Tooltip key={u.id}>
              <TooltipTrigger asChild>
                <div
                  className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-background text-[10px] font-semibold text-white"
                  style={{ backgroundColor: u.color }}
                >
                  {initials(u.name)}
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p className="text-xs">{u.name}</p>
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
        {users.length > 5 && (
          <span className="ml-1.5 text-xs text-muted-foreground">+{users.length - 5}</span>
        )}
        {/* Self-avatar fallback: until the server's next doc:presence
            broadcast arrives (which includes us filtered out), the bar
            would otherwise render nothing at all. */}
        {users.length === 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-background text-[10px] font-semibold text-white"
                style={{ backgroundColor: meColor }}
              >
                {initials(meName)}
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">{meName} (you)</p>
            </TooltipContent>
          </Tooltip>
        )}
        {users.length > 0 && (
          <span className="ml-2 hidden text-xs text-muted-foreground sm:inline">
            {users.length} online
          </span>
        )}
      </div>
    </TooltipProvider>
  )
}
