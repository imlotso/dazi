# Vercel and PostgreSQL Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for task-by-task implementation. Tests below cover observable behaviour and failure cases.

**Goal:** Add a safe Vercel Node.js + PostgreSQL deployment path without losing existing functionality, data or local deployments.

**Architecture:** The shared Fastify application uses an asynchronous, transactional SQLite/PostgreSQL data layer. A versioned operator-run schema/import path is separate from runtime, and bounded workspace sync prevents platform payload failures. See `docs/superpowers/specs/2026-11-14-vercel-postgres-design.md`.

**Tech Stack:** Node.js, TypeScript, Fastify, Vite, SQLite, PostgreSQL, Vitest, Vercel Node functions.

## Global Constraints

Keep UI, all features and 32 MiB workspace quota; no production changes, billing, DNS, deployments, secrets in output or Git; isolate databases and keys; keep Sites files intact. Existing local tests and deployment remain operational.

## Review Focus

- Cross-instance transactions racing on verification, permissions, settings, quota, recovery and ranking must remain atomic.
- An interrupted or inconsistent paginated sync must never delete local data or silently overwrite a newer draft/tombstone.
- Cold start, transient disconnect and missing database/secret must fail explicitly without modifying schema or creating empty data.
- Imports and restores must preserve timestamps, ciphertext, IDs, histories and sequence counters, and never target production implicitly.
- Auth, proxy/IP limits, cookies, SMTP and all admin APIs must retain privacy and account isolation.

### Task 1: Bounded workspace synchronization

**Files:** `server/workspace.ts`, `server/app.ts`, `src/hooks/useWorkspace.ts`, relevant workspace/API tests.
**Interfaces:** Paginated reads return bounded pages and cursor; batch writes return bounded acknowledgements. The client merges only a completely retrieved page sequence and rereads authoritative data after uploads.
- [x] Add failing tests for >4.5 MB aggregate, byte limits, background/tombstone handling, concurrent changes and interrupted/retried pagination.
- [x] Implement keyset pagination and bounded client synchronization without changing conflict ordering.
- [x] Run targeted workspace/API tests and baseline regressions.

### Task 2: Shared transactional data layer

**Files:** `server/app.ts`, `server/admin.ts`, `server/catalog.ts`, `server/workspace.ts`, `server/site-settings.ts`, `server/smtp.ts`, new database modules and tests.
**Interfaces:** Parameterized async queries and transactions supporting SQLite and PostgreSQL. SQLite existing behaviour remains a regression oracle.
- [x] Add failing real-database behaviour tests for concurrent code consumption, registration, score deduplication, site/SMTP revision conflicts, session revocation and workspace quota.
- [x] Implement explicit transaction scope, backend-specific SQL and isolation/locking; migrate all product paths.
- [x] Run SQLite and isolated PostgreSQL suites.

### Task 3: Controlled schema, import and recovery

**Files:** new migration and operator scripts, tests, README/deployment guide.
- [x] Add failing tests for migrations, SQLite-to-PostgreSQL import including audit and encrypted SMTP, verification and restoration.
- [x] Implement explicit versioned migrations, guarded import and documented offline backup/restore/rollback.
- [x] Test against disposable databases without any production credentials.

### Task 4: Serverless entry and shared rate limiting

**Files:** `server/index.ts`, new runtime/function modules, `vercel.json`, package/build configuration, tests.
- [x] Add failing tests for runtime config, Argon2/cookie/proxy behaviour, shared limits across instances, cold start and reconnect.
- [x] Implement function adapter, same-origin routing, database-backed rate limit and explicit secret validation; preserve local Node/Docker and Sites.
- [x] Run targeted tests and locally built entry smoke checks.

### Task 5: End-to-end validation and handoff

**Files:** deployment and operations documentation.
- [x] Run full tests, typecheck, build, Sites and isolated PostgreSQL integration checks.
- [x] Review security, concurrency and data-loss failure paths and resolve material findings.
- [x] Document separate Preview/production configuration, migration/backup/rollback, SMTP and unverified real services; report branch and commits without claiming deployment.

Real Neon, Vercel Preview, regional latency, external SMTP delivery and physical IME testing remain pending because the isolated remote environment is not yet prepared. No deployment, production migration or GitHub Actions run was performed.
