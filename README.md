# CoDoc — Real-Time Collaborative Markdown Editor

> A Google Docs–style collaborative Markdown editor with **Operational Transformation (OT)**,
> live cursors, presence awareness, and version history — built with Next.js, Socket.IO
> and PostgreSQL.

![Status](https://img.shields.io/badge/status-active--development-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Built with](https://img.shields.io/badge/built%20with-Next.js%2016%20%7C%20Socket.IO%20%7C%20PostgreSQL-black)
![Runtime](https://img.shields.io/badge/runtime-Bun%20%2F%20Node.js-orange)

---

## 📖 Table of Contents

- [About the Project](#about-the-project)
  - [Description](#description)
  - [Objectives](#objectives)
- [Key Features](#key-features)
- [Technologies Used](#technologies-used)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Database Setup](#database-setup)
  - [Running the Application](#running-the-application)
- [Testing](#testing)
- [API Reference](#api-reference)
- [Screenshots](#screenshots)
- [Team Members & Contributions](#team-members--contributions)
- [Roadmap](#roadmap)
- [Acknowledgments](#acknowledgments)

---

## About the Project

### Description

**CoDoc** is a real-time collaborative Markdown editor that lets multiple users edit the
same document simultaneously — with every keystroke synchronized across all browsers
**without refreshing the page**, just like Google Docs.

Under the hood, CoDoc implements an **Operational Transformation (OT)** engine: the
server is the single source of truth for every document, applies incoming edits in a
total server order, transforms concurrent operations so they converge, and broadcasts
the results to all connected editors. Document bodies, operation audit logs, and
version snapshots are persisted to PostgreSQL.

### Objectives

- ✅ Develop a collaborative Markdown editor supporting simultaneous multi-user editing.
- ✅ Implement real-time document synchronization using **Operational Transformation**.
- ✅ Provide live cursors and presence awareness so editors can see each other working.
- ✅ Persist documents, operation history, and version snapshots in **PostgreSQL**.
- ✅ Demonstrate collaborative software development using **Git / GitHub** (feature
  branches, pull requests, code review) across a two-member team.

---

## Key Features

| # | Feature | Description |
|---|---------|-------------|
| 1 | ⚡ Real-time collaborative editing | Edits propagate to every editor instantly over WebSocket (Socket.IO). |
| 2 | 🔀 Operational Transformation | Server-authoritative OT core guarantees **convergence** — all clients reach the same text regardless of edit order. |
| 3 | 👥 Live cursors & presence | See who is in the document, what color they are, and where their caret is. |
| 4 | 📝 Markdown editing + preview | Side-by-side Markdown editing with rendered preview (GFM support). |
| 5 | 🕘 Version history | Automatic snapshots every 40 operations, manual "save version", one-click **restore** from the timeline. |
| 6 | 🗂️ Document dashboard | Home screen listing all documents with previews, create/rename/delete. |
| 7 | 🌗 Dark / light theme | Full theme support via `next-themes`. |
| 8 | 🛡️ Operation audit log | Every applied operation batch is recorded in an append-only `OperationEntry` table. |

---

## Technologies Used

| Category | Technology | Purpose |
|----------|-----------|---------|
| Frontend | [React 19](https://react.dev), [Next.js 16](https://nextjs.org) | App Router, UI screens, REST API |
| UI Kit | [shadcn/ui](https://ui.shadcn.com), [Radix UI](https://www.radix-ui.com), [Tailwind CSS 4](https://tailwindcss.com) | Accessible components + styling |
| Markdown | [react-markdown](https://github.com/remarkjs/react-markdown), [remark-gfm](https://github.com/remarkjs/remark-gfm) | Live Markdown rendering |
| Real-time | [Socket.IO](https://socket.io) | WebSocket transport for ops, presence, cursors |
| Backend | [TypeScript](https://www.typescriptlang.org), [Bun](https://bun.sh) | OT sync service (mini-service on port 3003) |
| Database | [PostgreSQL](https://www.postgresql.org) | Documents, versions, operation audit log |
| ORM | [Prisma](https://www.prisma.io) | Schema, migrations, typed DB client |
| Tooling | ESLint, Prettier-style config, Bash scripts | Lint, DB bootstrap, e2e sync tests |

---

## Architecture

```
┌──────────────┐   HTTP (REST)    ┌─────────────────────┐
│   Browser    │ ───────────────► │  Next.js app :3000  │
│  (editors)   │                  │  - pages & screens  │
│              │                  │  - /api/documents   │
│              │                  └──────────┬──────────┘
│              │    WebSocket (ops)          │ Prisma
│              │ ───────────────► ┌──────────▼──────────┐      ┌──────────────┐
└──────────────┘                  │  Sync service :3003 │ ───► │  PostgreSQL  │
                                  │  - OT engine        │      │  - documents │
                                  │  - presence/cursors │      │  - versions  │
                                  │  - snapshots        │      │  - op log    │
                                  └─────────────────────┘      └──────────────┘
```

- The **Next.js app** owns document *metadata* (list, create, rename, delete) and the UI.
- The **sync service** (`mini-services/sync-service`) exclusively owns live *content* and
  the *revision counter*: it applies operations in server order, transforms late batches
  forward, relays cursors/presence, and writes content + snapshots to PostgreSQL.
- The **OT core** (`src/lib/ot-core.ts`) is one shared module used by both the browser and
  the server — verified for convergence by a fuzz test (`scripts/ot-fuzz.ts`).

---

## Project Structure

```
codoc/
├── mini-services/
│   └── sync-service/
│       └── index.ts              # Socket.IO OT engine, presence, persistence
├── prisma/
│   └── schema.prisma             # Document, DocumentVersion, OperationEntry
├── scripts/
│   ├── ot-fuzz.ts                # Randomized OT convergence fuzz test
│   ├── e2e-sync.ts               # End-to-end multi-client sync test
│   ├── second-editor.ts          # Simulated second editor client
│   ├── start-postgres.sh         # Local PostgreSQL bootstrap
│   └── db-push.sh                # prisma db push helper
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── route.ts                  # GET  /api (health check)
│   │   │   └── documents/
│   │   │       ├── route.ts              # GET/POST /api/documents
│   │   │       └── [id]/
│   │   │           ├── route.ts          # GET/PATCH/DELETE /api/documents/[id]
│   │   │           └── versions/route.ts # GET /api/documents/[id]/versions
│   │   ├── layout.tsx            # Root layout, theme provider
│   │   ├── page.tsx              # Home screen
│   │   └── globals.css           # Global styles
│   ├── components/
│   │   ├── codoc/                # Application components
│   │   │   ├── home-screen.tsx
│   │   │   ├── editor-screen.tsx
│   │   │   ├── collab-editor.tsx
│   │   │   ├── markdown-preview.tsx
│   │   │   ├── presence-bar.tsx
│   │   │   ├── version-panel.tsx
│   │   │   ├── name-dialog.tsx
│   │   │   ├── about-ot.tsx
│   │   │   ├── theme-toggle.tsx
│   │   │   └── use-doc-sync.ts   # Client-side OT sync hook
│   │   └── ui/                   # shadcn/ui primitives
│   ├── hooks/                    # Shared hooks (toast, mobile)
│   └── lib/
│       ├── ot-core.ts            # ★ Operational Transformation core (shared)
│       ├── db.ts                 # Prisma client
│       └── utils.ts              # cn() utility
├── env.example                   # Environment variable template
├── package.json
└── tailwind.config.ts
```

---

## Getting Started

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| [Bun](https://bun.sh) | ≥ 1.1 | `curl -fsSL https://bun.sh/install \| bash` |
| or Node.js | ≥ 20 | [nodejs.org](https://nodejs.org) |
| [PostgreSQL](https://www.postgresql.org) | ≥ 15 | [postgres.dev/download](https://www.postgresql.org/download/) |
| Git | any | [git-scm.com](https://git-scm.com) |

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/rajalx/codoc.git
cd codoc

# 2. Install dependencies
bun install        # or: npm install
```

### Database Setup

1. **Configure the connection** — copy the environment template and edit it:

   ```bash
   cp env.example .env
   ```

   ```dotenv
   DATABASE_URL="postgresql://postgres:postgres@localhost:5432/codoc"
   NEXT_PUBLIC_SYNC_URL="http://localhost:3003"
   ```

2. **Start PostgreSQL** (any method works):

   ```bash
   # Option A: Docker
   docker run -d --name codoc-db \
     -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=codoc \
     -p 5432:5432 postgres:17

   # Option B: local server (repo helper script)
   bash scripts/start-postgres.sh
   ```

3. **Push the Prisma schema** and generate the client:

   ```bash
   bun run db:push        # or: bun run db:generate && bun run db:migrate
   ```

### Running the Application

Open **two terminals** — the app and the sync service run as separate processes:

```bash
# Terminal 1 — Next.js app + REST API (http://localhost:3000)
bun run dev

# Terminal 2 — Socket.IO sync service (ws://localhost:3003)
bun run sync
```

Then visit **[http://localhost:3000](http://localhost:3000)**, enter your display name,
and open the same document in a second browser window (or use a private window) to see
real-time collaboration in action. 🎉

### Production Build

```bash
bun run build
bun run start
```

---

## Testing

```bash
# OT convergence fuzz test (shared OT core, thousands of random op interleavings)
bun run test:ot

# End-to-end sync test — requires dev server + sync service running
bun run test:e2e
```

The fuzz test proves the core OT property: for any interleaving of concurrent
insert/delete operations, all replicas transform and converge to the **same final text**.

---

## API Reference

### REST API (Next.js, port 3000)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api` | Health check |
| `GET` | `/api/documents` | List all documents (with previews; seeds the welcome doc) |
| `POST` | `/api/documents` | Create a document |
| `GET` | `/api/documents/[id]` | Fetch document metadata |
| `PATCH` | `/api/documents/[id]` | Rename a document |
| `DELETE` | `/api/documents/[id]` | Delete a document (cascades versions + ops) |
| `GET` | `/api/documents/[id]/versions` | List version snapshots (newest first, max 100) |

### WebSocket Events (sync service, port 3003)

| Event | Direction | Purpose |
|-------|-----------|---------|
| `join` | client → server | Join a document room with a display name |
| `ops` | client → server | Submit an operation batch at a base revision |
| `apply` | server → client | Broadcast of applied, transformed operations |
| `presence` | bidirectional | Editors in the room (name + color) and caret positions |
| `version` | server → client | New snapshot cut (auto or manual) |

---

## Screenshots

> 📸 *Add your screenshots to a `docs/screenshots/` folder and they will render here.*

| Screen | Screenshot |
|--------|-----------|
| Home dashboard — document list with previews | `![Home](docs/screenshots/home.png)` |
| Collaborative editor — two users editing live | `![Editor](docs/screenshots/editor.png)` |
| Presence bar — live cursors and user colors | `![Presence](docs/screenshots/presence.png)` |
| Version timeline — snapshots and restore | `![Versions](docs/screenshots/versions.png)` |
| Markdown preview pane | `![Preview](docs/screenshots/preview.png)` |

To capture them: run the app (`bun run dev && bun run sync`), open the home screen and
the editor in two side-by-side windows, and save screenshots into `docs/screenshots/`.

---

## Team Members & Contributions

This project was developed as a **two-member group assignment** (SEC101, MCA), following
a Git feature-branch workflow — each member worked on a dedicated feature branch merged
via pull requests ([#1](https://github.com/rajalx/codoc/pull/1), [#2](https://github.com/rajalx/codoc/pull/2)).

| Member | Role | Key Contributions |
|--------|------|-------------------|
| **Raja Lairencha** ([@rajalx](https://github.com/rajalx)) · `raja.lairencha@gmail.com` | **Backend Lead** | Project initialization & foundation; **Operational Transformation core algorithm** (`ot-core.ts`); **Socket.IO sync service** (op batching, transformation, presence, persistence); **Prisma schema** + database setup scripts; **REST API** (health, list/create, get/patch/delete, versions); OT convergence **fuzz test**; end-to-end sync tests |
| **Ganesh Kumar** · `ganesh-mca26@cs.du.ac.in` | **Frontend Lead** | Root layout, global styles & **theme support** (dark/light); **home screen** + name dialog; **collaborative editor screen**; **version panel** UI; **Markdown preview** & presence bar; **About OT** page; shadcn form/input components; `cn` utility & shared hooks; UI library integration |

**Contribution summary** (from `git log`):

| Member | Commits | Lines added | Focus area |
|--------|---------|-------------|-----------|
| Raja Lairencha | 12 | ~5,300+ | Backend — OT engine, sync service, REST API, database, tests |
| Ganesh Kumar | 8 | ~7,100+ | Frontend — UI library, theming, application screens |

---

## Roadmap

- [ ] User authentication & per-document permissions
- [ ] Rich-text (WYSIWYG) editing mode alongside raw Markdown
- [ ] Comments and suggestions
- [ ] Document sharing links with read-only access
- [ ] Replay of the operation log to reconstruct any historical revision
- [ ] Deployments: hosted PostgreSQL + containerized sync service

---

## Acknowledgments

- The OT approach is inspired by classic research on
  [Operational Transformation](https://en.wikipedia.org/wiki/Operational_transformation)
  and systems like Google Wave.
- UI components are built on [shadcn/ui](https://ui.shadcn.com) and
  [Radix UI](https://www.radix-ui.com) primitives.
- Developed as part of the **SEC101 MCA group assignment**,
  Department of Computer Science, University of Delhi.

---

<div align="center">

**CoDoc** — built with ❤️ by [@rajalx](https://github.com/rajalx) & Ganesh Kumar

⭐ Star this repo if you found it useful!

</div>
