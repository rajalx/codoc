/**
 * Shared Prisma client singleton for the Next.js REST API.
 *
 * Talks to PostgreSQL. Every REST route handler imports `db` from here so
 * the whole process shares one connection pool. The sync service
 * (mini-services/sync-service, port 3003) deliberately does NOT use this
 * module — it runs as a separate process with its own raw `pg` pool,
 * because it owns live document state (content, revision, OperationEntry
 * rows, DocumentVersion snapshots) while this client serves the
 * metadata/listing/create/delete traffic.
 *
 * Invariant: `DATABASE_URL` must be a postgres:// URL. The sandbox exports
 * a stale sqlite:// value that must be ignored (see below).
 */

import { PrismaClient } from '@prisma/client'

// Datasource URL resolution:
//   1. DATABASE_URL when it is a postgres:// URL (local dev via .env)
//   2. Sandbox default (local trust auth, no password)
// The guard exists because the sandbox exports a stale sqlite DATABASE_URL
// into the process environment, which would otherwise override the .env
// value.
const FALLBACK_URL = 'postgresql://postgres@127.0.0.1:5432/codoc'

/**
 * Resolves the PostgreSQL connection string.
 *
 * Accepts `DATABASE_URL` from the environment only when it is a
 * postgres:// or postgresql:// URL. Any other scheme (notably the stale
 * sqlite:// URL the sandbox exports) is treated as unset and ignored, so
 * it cannot override the .env value.
 *
 * Exported for diagnostics: callers can log the resolved URL without
 * re-deriving it.
 */
function resolveDatabaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (url && /^postgres(ql)?:\/\//.test(url)) return url
  // Missing or non-postgres DATABASE_URL. On a machine whose PostgreSQL
  // requires a password (e.g. Docker with POSTGRES_PASSWORD) the fallback
  // below fails with Prisma P1000 ("Authentication failed"), so warn loudly
  // and tell the user exactly what to do.
  console.warn(
    `[db] DATABASE_URL is missing or not a postgres:// URL (${url ? `"${url}"` : 'unset'}).\n` +
      `[db] Falling back to ${FALLBACK_URL} with NO password.\n` +
      `[db] If your PostgreSQL needs a password, create a .env file in the project root with:\n` +
      `[db]   DATABASE_URL="postgresql://postgres:YOURPASSWORD@localhost:5432/codoc"\n` +
      `[db] and restart the dev server.`
  )
  return FALLBACK_URL
}

export const DATABASE_URL = resolveDatabaseUrl()

// Process-wide cache slot for the singleton. Next.js dev mode re-evaluates
// modules on hot reload, which would otherwise create a new PrismaClient
// (and a new connection pool) on every edit.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

/**
 * The shared Prisma client for this process.
 *
 * Created eagerly at module load (not lazily inside a getter) so all
 * routes share one instance; on hot reload in development the cached
 * `globalThis.prisma` wins over a fresh construction. In production the
 * module is evaluated once, so the singleton holds for the process
 * lifetime.
 */
export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: { db: { url: DATABASE_URL } },
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
