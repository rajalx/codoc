# Contributing to CoDoc

Thank you for your interest in contributing to **CoDoc**, a real-time collaborative
Markdown editor built as the SEC101 MCA group assignment. This document describes how
the project is organized, how work is divided between team members, and the exact
workflow (branches → pull requests → code review) used to land changes in `main`.

---

## 📖 Table of Contents

- [Team Roles & Individual Contributions](#team-roles--individual-contributions)
- [Branching Strategy](#branching-strategy)
- [Pull Request Workflow](#pull-request-workflow)
- [Code Review Guidelines](#code-review-guidelines)
- [Commit Message Conventions](#commit-message-conventions)
- [Development Setup](#development-setup)
- [Coding Standards](#coding-standards)
- [Testing Expectations](#testing-expectations)

---

## Team Roles & Individual Contributions

CoDoc is developed by a **two-member team**. Ownership is split along the stack so each
member owns an end-to-end area of the codebase:

| Member | Role | Owns | Key Contributions |
|--------|------|------|-------------------|
| **Raja Lairencha** ([@rajalx](https://github.com/rajalx)) | **Backend Lead** | `src/lib/ot-core.ts`, `mini-services/`, `src/app/api/`, `prisma/`, `scripts/` | Operational Transformation core algorithm; Socket.IO sync service (op batching, transformation, presence, persistence); Prisma schema & database scripts; REST API (health, documents CRUD, versions); OT fuzz test & e2e sync tests |
| **Ganesh Kumar** | **Frontend Lead** | `src/components/codoc/`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/components/ui/` | Root layout, global styles & theme support (dark/light); home screen & name dialog; collaborative editor screen; version panel; Markdown preview & presence bar; About OT page; shadcn component library integration; `cn` utility & shared hooks |

**Rules of thumb for new changes:**

- Backend changes (OT, sync, API, database) → **@rajalx** reviews and merges.
- Frontend changes (UI screens, components, theming) → **Ganesh** reviews and merges.
- Cross-cutting changes need **both** members involved: the owner authors the change,
  the other member reviews it.
- Shared code (`src/lib/ot-core.ts`, `src/components/ui/`, `prisma/schema.prisma`)
  is treated as a **no-surprise zone**: changes there are always reviewed by the
  non-owner before merging.

---

## Branching Strategy

The repository follows a **feature-branch workflow** with a single protected branch:

```
main            ← always stable; every change arrives via a reviewed pull request
├── feature-member1   ← backend workstream  (OT engine, sync service, REST API, DB, tests)
├── feature-member2   ← frontend workstream (UI library, theming, application screens)
└── docs/…, feat/…, fix/…, chore/…   ← short-lived topic branches, merged and deleted
```

### Branch naming convention

Use one of these prefixes on every new branch, then a short kebab-case description:

| Prefix | Purpose | Example |
|--------|---------|---------|
| `feature-` | New functionality | `feature-member1`, `feature-member2` |
| `feat/` | A single scoped feature | `feat/version-panel` |
| `fix/` | Bug fix | `fix/ot-transform-delete` |
| `docs/` | Documentation only | `docs/readme-title-backend` |
| `chore/` | Tooling, deps, config | `chore/bun-upgrade` |

**Rules:**

1. `main` is never committed to directly - only merge commits from reviewed PRs.
2. Each member does the bulk of their work on their long-lived `feature-memberN`
   branch and merges it to `main` **once** when the workstream is complete (this is how
   PR #1 and PR #2 were landed).
3. Smaller incremental changes go on short-lived topic branches off `main`.
4. Branches are **deleted after merging** to keep the branch list clean.
5. Keep branches short-lived; long-running branches drift from `main` and make
   reviews painful.

### Keeping branches up to date

```bash
git checkout feature-member1
git fetch origin
git merge origin/main        # or: git rebase origin/main (if the branch is unshared)
```

Resolve conflicts locally before opening the PR - PRs with conflicts will be sent back.

---

## Pull Request Workflow

Every change to `main` goes through a pull request, even for the repository owners.
This is how the project's two main PRs were landed:

| PR | Branch | Title | Reviewer |
|----|--------|-------|----------|
| [#1](https://github.com/rajalx/codoc/pull/1) | `feature-member1` → `main` | `feat: backend - OT engine, REST API and WebSocket sync service` | Ganesh Kumar |
| [#2](https://github.com/rajalx/codoc/pull/2) | `feature-member2` → `main` | `feat: frontend - UI library, theme and application screens` | Raja Lairencha |

### Creating a pull request

1. **Push your branch** to the remote:

   ```bash
   git push -u origin feature-member1
   ```

2. **Open the PR** on GitHub (`main` ← your branch). Give it:

   - A **title** following the commit conventions below (e.g. `feat: backend - OT engine, REST API and WebSocket sync service`).
   - A **description** covering:
     - *What* changed and *why*;
     - *How to test it* - exact commands and expected output;
     - *Scope note* - which files/areas the PR touches (so the right reviewer is assigned);
     - Screenshots or screen recordings for any UI change.

3. **Request review** from the other team member (see ownership table above).

4. **CI / checks**: run locally before pushing:

   ```bash
   bun run lint      # ESLint must pass with no errors
   bun run test:ot   # OT fuzz test must pass (if OT core was touched)
   bun run build     # must compile cleanly for backend/API changes
   ```

5. **Merge** - squash-merge or merge-commit (as used for PR #1 and PR #2), with the
   default merge message `Merge pull request #N from <branch>` preserved so the PR
   number stays traceable in `git log`.

6. **Clean up** - delete the topic branch after merging:

   ```bash
   git branch -d feature-member1
   git push origin --delete feature-member1
   ```

### PR size guidelines

- Aim for **focused PRs** - one feature or one fix each.
- Large workstreams (like the two `feature-memberN` branches) are acceptable for a
  semester assignment, but split them into well-scoped commits so the reviewer can
  follow along one feature at a time.
- Docs-only PRs may be merged quickly after a skim review.

---

## Code Review Guidelines

Reviews are a **required gate** - no self-merges. With a two-member team, the reviewer
is always the other member.

### Reviewer responsibilities

- [ ] **Understand the change** - read the PR description before the diff.
- [ ] **Check correctness**, especially in high-risk areas:
  - OT/sync changes must preserve **convergence** (`bun run test:ot` must pass);
  - API changes must not violate the ownership split (the REST API never writes
    `content` or `revision`; only the sync service does);
  - Prisma schema changes must be reflected in `scripts/db-push.sh` / migrations.
- [ ] **Run it** - pull the branch, start both processes, and actually use the feature
  (open two browser windows for any collaboration-related change).
- [ ] **Review style, not just logic** - naming, dead code, missing comments on
  non-obvious logic (this codebase documents tricky areas heavily, e.g. the OT core
  and Prisma schema - keep that standard).
- [ ] **Leave actionable comments** - point to specific lines, suggest concrete
  alternatives (`nit:` for minor, `must:` for blocking).

### Author responsibilities

- [ ] Respond to every review comment (fix it, or explain why not).
- [ ] Push follow-up commits to the same branch - the PR updates automatically.
- [ ] Re-request review after significant changes.
- [ ] Never merge with unresolved `must:` comments.

### What reviewers look for, by area

| Area | Review checklist |
|------|------------------|
| **OT core** (`ot-core.ts`) | Transform functions total & commutative; fuzz test updated if op shape changed; no new op type without server support |
| **Sync service** | Batch limits respected; DB writes stay on the existing flush path; no direct writes outside the ownership contract |
| **REST API** | Correct status codes (404 vs 500); no content/revision writes; cascade behavior documented if delete paths change |
| **Frontend** | Works in dark & light themes; responsive down to mobile; uses existing shadcn/ui primitives instead of ad-hoc styling |
| **Database** | Schema changes justified; indexes match real queries; comments updated alongside fields |

---

## Commit Message Conventions

The project uses **[Conventional Commits](https://www.conventionalcommits.org)** with
optional scopes. Actual history for reference:

```
feat(ot): implement operational transform core algorithm
feat(sync): add WebSocket sync service for real-time collaboration
feat(api): add health check and document list/create endpoints
feat(versions): add document version history API
feat(editor): add collaborative editor component
test(sync): add end-to-end sync and second-editor simulation scripts
test(ot): add fuzz test to verify OT convergence
feat(db): add Prisma schema, database client and DB setup scripts
chore: initialize CoDoc project foundation
```

Format:

```
<type>(<scope>): <short imperative summary>

[optional body: motivation + key design decisions]
```

| Type | Use for |
|------|---------|
| `feat` | New feature (backend or frontend) |
| `fix` | Bug fix |
| `test` | Tests only (fuzz, e2e, simulations) |
| `docs` | Documentation only |
| `chore` | Tooling, config, dependencies, scaffolding |
| `refactor` | Code change that neither fixes nor adds behavior |

Common scopes: `ot`, `sync`, `api`, `db`, `editor`, `versions`, `ui`.

**Rules:**

- Imperative mood ("add", not "added" or "adds").
- One logical change per commit - don't mix a feature with an unrelated fix.
- One commit per feature/step: the history is meant to *read like a tutorial*, which
  is exactly how the two feature branches were authored.

---

## Development Setup

Follow the full instructions in the
[README Getting Started section](README.md#getting-started). Quick version:

```bash
git clone https://github.com/rajalx/codoc.git
cd codoc
bun install
cp env.example .env                 # point DATABASE_URL at your PostgreSQL
bun run db:push                     # apply the Prisma schema

# two terminals
bun run dev                         # Next.js app on :3000
bun run sync                        # Socket.IO sync service on :3003
```

---

## Coding Standards

- **Language:** TypeScript everywhere (strict). No `any` in new code unless justified
  in a comment.
- **Linting:** `bun run lint` must pass with **zero errors** before a PR is opened.
- **Formatting:** match the surrounding style; don't reformat unrelated lines.
- **Comments:** this codebase documents *why*, not just *what* - tricky logic (OT
  transforms, revision ownership, DB write paths) carries thorough doc comments. If
  you touch those areas, keep the comments accurate.
- **Styling:** use existing [shadcn/ui](https://ui.shadcn.com) primitives and Tailwind
  utility classes; never introduce a second styling system.

## Testing Expectations

- Any change to `src/lib/ot-core.ts` **must** be accompanied by a passing
  `bun run test:ot` fuzz run (and extend the fuzzer if you add/change op types).
- Any change to the sync service or REST API should be verified with
  `bun run test:e2e` (dev server + sync service must be running).
- UI changes should be manually verified in **two browser windows simultaneously**
  - single-window testing defeats the entire point of a collaboration editor.

---

<div align="center">

Questions? Open an issue or reach out to the team on the project thread.

**CoDoc**  [@rajalx](https://github.com/rajalx) & Ganesh Kumar

</div>
