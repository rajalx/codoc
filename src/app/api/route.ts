/**
 * Root API endpoint: `GET /api`.
 *
 * A placeholder scaffold route left over from project generation. It
 * touches no database, has no side effects, and is not a health check —
 * it always returns a constant payload. Trivially useful as a liveness
 * probe for the Next.js process itself, but it does not verify PostgreSQL
 * or the sync service on port 3003.
 *
 * Request shape: none.
 * Response: 200 — { message: "Hello, world!" } (no error paths).
 */

import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ message: "Hello, world!" });
}