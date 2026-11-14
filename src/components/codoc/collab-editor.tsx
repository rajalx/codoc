'use client'

/**
 * CollabEditor — a textarea with live remote cursors.
 *
 * Remote caret positions are measured with the classic "mirror div"
 * technique: a hidden div with the exact same font metrics, padding and
 * width as the textarea. For each remote cursor we render the text prefix
 * plus a zero-width marker into the mirror and read the marker's
 * offsetLeft/offsetTop — those are the caret's (x, y) in content
 * coordinates. The overlay is then translated by the textarea's scroll
 * offsets so cursors ride along while scrolling.
 *
 * How it fits in: the only place the document text is actually edited.
 * `EditorScreen` passes down the merged document string, remote cursors
 * and presence list from `useDocSync` (which owns the socket.io connection
 * to the sync service and the OTClient from src/lib/ot-core.ts); every
 * local edit is handed back through `onLocalChange` where the OT client
 * diffs it into ops and applies local echo.
 *
 * Key invariants / gotchas:
 *  - Cursor positions are caret indices into the UTF-16 string, always in
 *    the CURRENT local coordinate space (useDocSync keeps them transformed
 *    across every applied op before they reach us).
 *  - `SHARED_TEXT_CLASSES` must match exactly between textarea, mirror and
 *    overlay; a metric mismatch (font, line-height, padding, width) makes
 *    remote cursors drift out of alignment.
 *  - Caret position is not owned by React: when remote ops replace `text`,
 *    the textarea DOM value changes and the browser clamps the caret to
 *    the end. We restore it via restoreCaretRef after each text commit.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { PresenceUser } from './use-doc-sync'
import type { EditorApi } from './use-doc-sync'

/**
 * Props for CollabEditor.
 *
 * Coordinate space note: `text`, `cursors` values, `onCursor` and the
 * EditorApi caret indices are all caret offsets in UTF-16 code units
 * (matching String.prototype.slice and textarea.selectionStart semantics).
 */
interface CollabEditorProps {
  /** Full merged document text (controlled value for the textarea). */
  text: string
  /**
   * Remote caret index per participant id, already transformed into the
   * local coordinate space by the sync hook.
   */
  cursors: Record<string, number>
  /** Presence list; provides the name/color rendered for each cursor id. */
  users: PresenceUser[]
  /**
   * Called with the full new textarea content on any local edit (including
   * synthetic edits like Tab). The sync hook diffs it into OT ops.
   */
  onLocalChange: (newText: string) => void
  /** Called (throttled) with the local caret index to broadcast presence. */
  onCursor: (pos: number) => void
  /**
   * Shared ref filled with the EditorApi (getCaret / queueCaretRestore).
   * The sync hook reads it when remote ops arrive so it can transform and
   * restore the user's caret across out-of-band text changes.
   */
  editorApiRef: React.RefObject<EditorApi | null>
  /** Optional typing-activity hook (unused by the current screens). */
  onActivity?: () => void
}

/**
 * Must be byte-identical between textarea, mirror and overlay; otherwise
 * measured caret offsets drift from the real caret. Override it in one
 * place only.
 */
const SHARED_TEXT_CLASSES =
  'font-mono text-[13px] leading-6 p-4 whitespace-pre-wrap break-words'

/** Measured caret position in content (pre-scroll) pixel coordinates. */
interface CursorPos {
  left: number
  top: number
}

/**
 * Renders a controlled textarea layered under a remote-cursor overlay and
 * an invisible measurement mirror.
 *
 * Owns:
 *  - caret preservation across remote text updates (restoreCaretRef),
 *  - the mirror-div measurement pipeline and per-cursor pixel positions,
 *  - scroll-offset translation of the overlay,
 *  - throttled caret broadcasting.
 *
 * Does NOT own the document text: `text` is controlled from the sync hook,
 * so a remote op landing mid-keystroke re-renders the textarea with the
 * merged string.
 */
export function CollabEditor({
  text,
  cursors,
  users,
  onLocalChange,
  onCursor,
  editorApiRef,
  onActivity,
}: CollabEditorProps) {
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const mirrorRef = useRef<HTMLDivElement | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  // [start, end] to restore after the next text commit; queued by the sync
  // hook via EditorApi when remote ops shift the text under the caret.
  const restoreCaretRef = useRef<[number, number] | null>(null)
  // Timestamp of the last broadcast; naive throttle for doc:cursor events.
  const cursorThrottleRef = useRef(0)
  const [positions, setPositions] = useState<Record<string, CursorPos>>({})
  // Mirror/overlay width; defaults to a plausible value so first paint has
  // non-zero layout before the real clientWidth is measured.
  const [mirrorWidth, setMirrorWidth] = useState<number>(600)

  // id -> PresenceUser lookup for rendering cursor labels; recomputed only
  // when the presence array identity changes.
  const userById = useMemo(() => {
    const m: Record<string, PresenceUser> = {}
    for (const u of users) m[u.id] = u
    return m
  }, [users])

  /* ---- caret restore + editor API ---- */

  // After every text commit, re-apply any queued caret range. React
  // replaces the textarea's value when `text` changes (remote ops or local
  // echo round-trips), which makes the browser clamp the caret — so we
  // re-pin it one effect after the DOM update.
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    const rc = restoreCaretRef.current
    if (rc) {
      restoreCaretRef.current = null
      ta.setSelectionRange(rc[0], rc[1])
    }
  }, [text])

  // Publish the imperative EditorApi on the shared ref. The sync hook calls
  // getCaret() from socket handlers (outside React) and queues a restore
  // range for the effect above. Cleanup nulls the ref so a stale editor
  // instance can't answer for an unmounted screen.
  useEffect(() => {
    editorApiRef.current = {
      getCaret: () => {
        const ta = taRef.current
        // Only report a caret while this textarea is focused; otherwise the
        // sync hook would transform and later restore a caret position the
        // user is not actively holding.
        if (!ta || document.activeElement !== ta) return null
        return [ta.selectionStart, ta.selectionEnd]
      },
      queueCaretRestore: (start, end) => {
        restoreCaretRef.current = [start, end]
      },
    }
    return () => {
      editorApiRef.current = null
    }
  }, [editorApiRef])

  /* ---- cursor measurement (mirror div) ---- */

  // Re-measure on text, cursor, or presence change. useLayoutEffect (not
  // useEffect) so the overlay is positioned before the browser paints —
  // with a plain effect, remote cursors would visibly flicker at (0, 0)
  // for one frame whenever the text changed.
  useLayoutEffect(() => {
    const ta = taRef.current
    const mirror = mirrorRef.current
    if (!ta || !mirror) return

    // Keep the mirror exactly as wide as the textarea: wrapping positions
    // depend on the width, so a stale width shifts every cursor below the
    // first soft-wrap point.
    const width = ta.clientWidth
    if (width > 0) {
      mirror.style.width = `${width}px`
      setMirrorWidth(width)
    }

    // Per cursor: render `text.slice(0, pos)` + a zero-width marker into
    // the mirror, then read the marker's offsetLeft/offsetTop. The marker
    // span is reused and moved to keep this O(n) DOM churn per cursor.
    const marker = document.createElement('span')
    marker.textContent = '\u200b'
    const next: Record<string, CursorPos> = {}
    for (const [id, pos] of Object.entries(cursors)) {
      // Clamp guards against a remote cursor index from a coordinate space
      // we haven't transformed yet (or a stale event racing the op that
      // made the index valid) — out-of-range slice would throw no error
      // but would silently park the cursor at the string end.
      const clamped = Math.max(0, Math.min(pos, text.length))
      mirror.textContent = text.slice(0, clamped)
      mirror.appendChild(marker)
      next[id] = { left: marker.offsetLeft, top: marker.offsetTop }
      mirror.removeChild(marker)
    }
    setPositions(next)
    // `users` is a dependency so a rename/color change re-renders labels at
    // the existing positions even when text/cursors are unchanged.
  }, [text, cursors, users])

  /* ---- overlay scroll sync (no re-render) ---- */

  /**
   * Translate the cursor overlay by the negative textarea scroll offsets.
   * Positions are stored in content coordinates, so this single transform
   * keeps cursors aligned while scrolling. Direct DOM write on purpose:
   * putting scroll offsets in state would re-render (and re-measure) on
   * every scroll frame.
   */
  const syncScroll = useCallback(() => {
    const ta = taRef.current
    const overlay = overlayRef.current
    if (!ta || !overlay) return
    overlay.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`
  }, [])

  /* ---- caret broadcast (throttled) ---- */

  /**
   * Broadcast the local caret index to the sync service. Throttled to
   * 40ms (not debounced): position updates are cheap and we want them to
   * stream while typing, we just don't want one event per keystroke.
   * `force` bypasses the window — used when the event itself is the
   * signal (click, selection change).
   */
  const broadcastCursor = useCallback(
    (force = false) => {
      const ta = taRef.current
      if (!ta) return
      const now = Date.now()
      if (!force && now - cursorThrottleRef.current < 40) return
      cursorThrottleRef.current = now
      onCursor(ta.selectionStart)
    },
    [onCursor]
  )

  /* ---- local edit handlers ---- */

  /**
   * Tab inserts two spaces (soft indentation) instead of moving focus.
   * Performed as a full-text edit routed through onLocalChange so the
   * change becomes real OT ops like any other typing; the caret is queued
   * for restore because the controlled-value commit would otherwise park
   * it at the end of the text.
   */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault()
      const ta = e.currentTarget
      const start = ta.selectionStart
      const end = ta.selectionEnd
      const newValue = text.slice(0, start) + '  ' + text.slice(end)
      restoreCaretRef.current = [start + 2, start + 2]
      onLocalChange(newValue)
    }
  }

  // Every typing event funnels through onLocalChange (full new text); the
  // sync hook diffs it against the previous value to derive OT ops. The
  // caret broadcast rides along so others see the cursor follow the typing.
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onLocalChange(e.target.value)
    broadcastCursor()
  }

  // Build the overlay DOM. Positions come from the mirror measurement;
  // cursors whose presence entry hasn't arrived yet (or has already left)
  // are skipped rather than rendered with default styling.
  const caretElements: ReactNode[] = []
  for (const [id, pos] of Object.entries(positions)) {
    const user = userById[id]
    if (!user) continue
    // Clamp the name label horizontally so it doesn't overflow the right
    // edge of the document (76px ≈ the widest label we allow); the label
    // is positioned relative to the caret via (labelLeft - pos.left).
    const labelLeft = Math.max(0, Math.min(pos.left, mirrorWidth - 76))
    caretElements.push(
      <div key={id} className="pointer-events-none absolute" style={{ left: pos.left, top: pos.top }}>
        <div
          className="absolute -top-[2px] left-0 h-6 w-[2px] rounded-full"
          style={{ backgroundColor: user.color }}
        />
        <div
          className="absolute -top-[18px] rounded px-1 text-[10px] font-medium leading-4 text-white shadow-sm"
          style={{ left: labelLeft - pos.left, backgroundColor: user.color, whiteSpace: 'nowrap' }}
        >
          {user.name}
        </div>
      </div>
    )
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <textarea
        ref={taRef}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        // Broadcast on every caret-affecting interaction; throttling lives
        // inside broadcastCursor so these can stay naive handlers.
        onKeyUp={() => broadcastCursor()}
        onClick={() => broadcastCursor()}
        onSelect={() => broadcastCursor()}
        onScroll={syncScroll}
        spellCheck={false}
        aria-label="Document text editor"
        // Empty-state hint: the raw textarea would otherwise be a blank
        // void in an untouched document. Native placeholder only — it is
        // not part of the value, so it never reaches the OT pipeline.
        placeholder="Start writing Markdown — try '# Heading', '**bold**', '- list' or '- [ ] task'…"
        className={`absolute inset-0 h-full w-full resize-none bg-transparent outline-none ${SHARED_TEXT_CLASSES}`}
        style={{ tabSize: 2 }}
      />

      {/* Remote cursor overlay. Children are positioned in content
          coordinates (same space as the mirror); syncScroll translates the
          whole container so cursors stay glued to the text on scroll. */}
      <div
        ref={overlayRef}
        aria-hidden
        className="pointer-events-none absolute left-0 top-0"
        style={{ width: mirrorWidth }}
      >
        {caretElements}
      </div>

      {/* Invisible mirror used to measure caret positions. Width is kept
          in sync with the textarea in the layout effect; text and styles
          must match SHARED_TEXT_CLASSES exactly. */}
      <div
        ref={mirrorRef}
        aria-hidden
        className={`invisible absolute left-0 top-0 ${SHARED_TEXT_CLASSES}`}
        style={{ width: mirrorWidth }}
      >
        {'\u00a0'}
      </div>
    </div>
  )
}
