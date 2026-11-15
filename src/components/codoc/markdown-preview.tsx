'use client'

/**
 * MarkdownPreview — renders the live document as GitHub-flavored Markdown.
 * Re-parses are debounced ~120ms so split-view typing stays smooth.
 *
 * How it fits in: a pure consumer of document text. It receives the
 * already-merged document string from `EditorScreen` (via `useDocSync`) or
 * from a snapshot in `VersionPanel`; it knows nothing about OTClient, the
 * socket.io sync service, or revisions. Used in split view, preview-only
 * view, and the version-history side sheet.
 *
 * Gotcha: `debounced` starts equal to the initial `content`, so the first
 * paint is never stale — the debounce only smooths *subsequent* edits.
 */
import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * Renders the given Markdown string through react-markdown + remark-gfm
 * inside a styled, scrollable container.
 *
 * @param props.content - Full document text to render (UTF-16 string, same
 *   coordinate space as the editor text, though positions are irrelevant
 *   here since we render the whole thing).
 */
export function MarkdownPreview({ content }: { content: string }) {
  const [debounced, setDebounced] = useState(content)

  // Debounce re-parses: Markdown AST building on every keystroke would
  // compete with the OT local-echo path for the main thread. The timer is
  // reset on each `content` change, and clearing it in the cleanup
  // guarantees no setState after unmount (e.g. on doc switch).
  useEffect(() => {
    const t = setTimeout(() => setDebounced(content), 120)
    return () => clearTimeout(t)
  }, [content])

  return (
    <div className="h-full overflow-y-auto px-6 py-4 md:px-10 md:py-6">
      <div className="prose prose-zinc dark:prose-invert mx-auto max-w-3xl prose-pre:bg-zinc-900 prose-pre:text-zinc-100 prose-code:before:content-none prose-code:after:content-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{debounced}</ReactMarkdown>
      </div>
    </div>
  )
}
