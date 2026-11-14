'use client'

/**
 * useDocSync — the browser half of CoDoc's sync protocol.
 *
 * Owns one socket.io connection to the sync service and one OTClient
 * instance for the active document. Exposes:
 *   - the live document text (local echo applied instantly, remote ops
 *     transformed in as they are broadcast),
 *   - presence + remote cursor positions (kept in the local coordinate
 *     space by transforming them over every applied op),
 *   - connection status, revision, pending-ops flag,
 *   - snapshot / restore actions and a signal that the version list changed.
 *
 * Caret preservation: when a remote op shifts the text under the user's
 * caret, we capture the caret BEFORE applying (the DOM still holds the old
 * value at that moment), transform it over the applied ops, and hand it to
 * the editor to restore after re-render.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import { Op, OTClient, transformPosition } from '@/lib/ot-core'

export type SyncStatus = 'connecting' | 'live' | 'offline'

export interface PresenceUser {
  id: string
  name: string
  color: string
  pos?: number | null
}

export interface EditorApi {
  /** Current caret [start, end] of the focused textarea, or null. */
  getCaret: () => [number, number] | null
  /** Ask the editor to restore the caret after the next render. */
  queueCaretRestore: (start: number, end: number) => void
}

export function useDocSync(
  docId: string,
  name: string,
  color: string,
  editorApiRef: React.RefObject<EditorApi | null>
) {
  const [text, setText] = useState('')
  const [status, setStatus] = useState<SyncStatus>('connecting')
  const [users, setUsers] = useState<PresenceUser[]>([])
  const [cursors, setCursors] = useState<Record<string, number>>({})
  const [revision, setRevision] = useState(0)
  const [pending, setPending] = useState(false)
  const [snapshotSignal, setSnapshotSignal] = useState(0)
  const [docError, setDocError] = useState<string | null>(null)
  const [joined, setJoined] = useState(false)

  const socketRef = useRef<Socket | null>(null)
  const otRef = useRef<OTClient | null>(null)
  const cursorsRef = useRef<Record<string, number>>({})
  const initedDocRef = useRef<string | null>(null)
  const docIdRef = useRef(docId)
  const nameRef = useRef(name)
  const colorRef = useRef(color)

  useEffect(() => {
    nameRef.current = name
    colorRef.current = color
  }, [name, color])

  const bumpCursors = useCallback(() => {
    setCursors({ ...cursorsRef.current })
  }, [])

  /** Shift every remote cursor across a list of applied ops. */
  const moveCursorsPast = useCallback(
    (ops: Op[]) => {
      if (ops.length === 0) return
      let changed = false
      for (const k of Object.keys(cursorsRef.current)) {
        const np = transformPosition(cursorsRef.current[k], ops)
        if (np !== cursorsRef.current[k]) {
          cursorsRef.current[k] = np
          changed = true
        }
      }
      if (changed) bumpCursors()
    },
    [bumpCursors]
  )

  const syncMeta = useCallback(() => {
    const ot = otRef.current
    if (ot) {
      setRevision(ot.revision)
      setPending(ot.pending)
    }
  }, [])

  // One socket per mounted editor screen.
  useEffect(() => {
    // Where is the sync service? Two supported setups:
    //  - Local dev: set NEXT_PUBLIC_SYNC_URL (e.g. "http://localhost:3003")
    //    in .env and the browser connects there directly.
    //  - Sandbox/proxy (default): same origin + XTransformPort query, which
    //    the edge proxy routes to the sync service on port 3003.
    const envUrl = process.env.NEXT_PUBLIC_SYNC_URL
    const syncUrl = envUrl && envUrl.length > 0 ? envUrl : '/?XTransformPort=3003'
    const socket = io(syncUrl, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 800,
      timeout: 10000,
    })
    socketRef.current = socket

    socket.on('connect', () => {
      setStatus('live')
      socket.emit('doc:join', {
        docId: docIdRef.current,
        name: nameRef.current,
        color: colorRef.current,
      })
    })
    socket.on('disconnect', () => setStatus('offline'))
    socket.on('connect_error', () => setStatus((s) => (s === 'live' ? 'offline' : 'connecting')))

    socket.on('doc:init', (data: { docId: string; text: string; revision: number }) => {
      const makeHooks = () => ({
        onUpdate: (t: string) => setText(t),
        onSend: (ops: Op[], base: number) =>
          socketRef.current?.emit('doc:op', { ops, base }),
      })
      const existing = otRef.current
      const isRejoin = existing !== null && initedDocRef.current === data.docId

      if (!isRejoin) {
        otRef.current = new OTClient(data.text, data.revision, makeHooks())
        cursorsRef.current = {}
        bumpCursors()
      } else {
        // Reconnect after a network blip: keep our unsent edits by diffing
        // our (richer) local text against the latest server text.
        const myText = existing.text
        const hadPending = existing.pending
        otRef.current = new OTClient(data.text, data.revision, makeHooks())
        if (hadPending && myText !== data.text) {
          otRef.current.localChange(myText)
        }
      }
      initedDocRef.current = data.docId
      setJoined(true)
      setText(otRef.current.text)
      syncMeta()
    })

    socket.on('doc:op', (data: { ops: Op[]; version: number }) => {
      const caret = editorApiRef.current?.getCaret() ?? null
      const applied = otRef.current?.remoteOps(data.ops, data.version) ?? []
      if (caret && applied.length > 0) {
        editorApiRef.current?.queueCaretRestore(
          transformPosition(caret[0], applied),
          transformPosition(caret[1], applied)
        )
      }
      moveCursorsPast(applied)
      syncMeta()
    })

    socket.on('doc:ack', (data: { version: number }) => {
      otRef.current?.ack(data.version)
      syncMeta()
    })

    socket.on('doc:cursor', (data: { id: string; pos: number }) => {
      cursorsRef.current[data.id] = data.pos
      bumpCursors()
    })

    socket.on('doc:presence', (data: { users: PresenceUser[] }) => {
      setUsers(data.users ?? [])
      const ids = new Set((data.users ?? []).map((u) => u.id))
      let changed = false
      for (const k of Object.keys(cursorsRef.current)) {
        if (!ids.has(k)) {
          delete cursorsRef.current[k]
          changed = true
        }
      }
      if (changed) bumpCursors()
    })

    socket.on('doc:reset', (data: { text: string; revision: number }) => {
      const caret = editorApiRef.current?.getCaret() ?? null
      otRef.current?.reset(data.text, data.revision)
      cursorsRef.current = {}
      bumpCursors()
      if (caret) {
        editorApiRef.current?.queueCaretRestore(
          Math.min(caret[0], data.text.length),
          Math.min(caret[1], data.text.length)
        )
      }
      syncMeta()
    })

    socket.on('doc:snapshot-created', () => setSnapshotSignal((s) => s + 1))
    socket.on('doc:error', (data: { message?: string }) => {
      setDocError(data?.message ?? 'Something went wrong')
    })

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [])

  // Join / leave when the active document changes. The editor screen is
  // remounted per document via key={docId}, so this only has to sync refs —
  // no state resets needed (initial state is already correct on mount).
  useEffect(() => {
    docIdRef.current = docId
    initedDocRef.current = null
    otRef.current = null
    if (socketRef.current?.connected) {
      socketRef.current.emit('doc:join', {
        docId,
        name: nameRef.current,
        color: colorRef.current,
      })
    }
  }, [docId])

  /** The user typed in the textarea; newText is the full new content. */
  const localChange = useCallback(
    (newText: string) => {
      const ot = otRef.current
      if (!ot) return
      const ops = ot.localChange(newText)
      setText(ot.text)
      syncMeta()
      moveCursorsPast(ops)
    },
    [syncMeta, moveCursorsPast]
  )

  const sendCursor = useCallback((pos: number) => {
    socketRef.current?.emit('doc:cursor', { pos })
  }, [])

  const saveSnapshot = useCallback((label: string) => {
    socketRef.current?.emit('doc:snapshot', { label })
  }, [])

  const restoreVersion = useCallback((versionId: string) => {
    socketRef.current?.emit('doc:restore', { versionId })
  }, [])

  return {
    text,
    status,
    joined,
    users,
    cursors,
    revision,
    pending,
    snapshotSignal,
    docError,
    localChange,
    sendCursor,
    saveSnapshot,
    restoreVersion,
    clearError: () => setDocError(null),
  }
}
