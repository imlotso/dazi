# Vercel and PostgreSQL migration design

## Goal and constraints

Keep all current product behaviour, data, SQLite Node/Docker operation and Sites integration while adding a Vercel Node.js Function backed by PostgreSQL. No production data migration, deployment, billing changes, DNS changes, or secrets in source, logs, or chat. Preview and production use independently configured databases and keys. The user supplied the target architecture; implementation choices below are engineering decisions, not claims of additional user approval.

## Approaches

1. Rewrite the existing database access through an asynchronous storage interface with SQLite and PostgreSQL implementations. This preserves the product's shared routes while allowing network I/O and transaction isolation to work on serverless instances. It has a larger initial refactor, but permits testing both backends against the same behaviours.
2. Emulate synchronous SQLite calls over a blocking PostgreSQL worker. This reduces initial code changes but blocks the Node.js event loop and obscures concurrency and failure semantics, so it is unsuitable for a multi-instance service.
3. Operate a second independent API implementation. This avoids a shared refactor but duplicates security, scoring and admin logic, making behavioural drift likely.

Use approach 1. Changes must preserve data invariants, not merely translate syntax.

## Components and interfaces

- Separate application assembly from local listener and Vercel handler. Explicit production configuration must require an existing PostgreSQL database and the original stable `CODE_SECRET`; never create an empty local database as a serverless fallback.
- Use an async database abstraction with transaction-scoped clients, parameterized queries, backend-specific SQL where necessary, bounded PostgreSQL connections, and explicit error propagation. SQLite remains local and uses serialized transaction access. PostgreSQL transactions must protect verification-code consumption, account access changes, site/SMTP revisions, challenge recovery, score publication, and per-account workspace capacity across instances. Real concurrent tests must exercise these conditions.
- SQLite `BEGIN IMMEDIATE` invariants require explicit PostgreSQL coordination: serialize admin authorization and role changes, lock per-owner workspace and recovery operations including absent rows, guard absent settings revisions with a lock or compare-and-swap, and coordinate session creation with account revocation. Lock challenge rows before recovery/publication; use an atomic conditional write for code issuance. Preserve SQLite ASCII-only case-insensitive identity semantics, exact text and safely parsed bigint timestamps.
- Ship versioned, explicitly invoked PostgreSQL schema migrations, and verified SQLite import, backup and restore procedures. Do not mutate schema on function startup. Preserve all tables including public article snapshots, access/session state, private workspace tombstones, SMTP ciphertext, and audit entries. Refuse destructive or ambiguous imports by default.
- Use database-backed, atomic rate limits shared by function instances. Preserve effective existing route limits and fail closed if the shared limiter is unavailable.
- Add a bounded page-based workspace read protocol and bounded batch writes; preserve existing per-item merge and deletion rules. Aggregate all pages before applying a remote snapshot locally. Pagination or network interruption must never imply deletion. The old local route remains compatible where feasible; the new client must keep every request and response below the platform limit. Version the full workspace per owner so concurrent edits invalidate a page sequence, and return a small write acknowledgement before one bounded follow-up read. Also bound public catalog and history responses, whose aggregate texts can exceed the same limit.
- Use Vercel routes to serve Vite assets and same-origin `/api`; set the function region near Singapore's Neon endpoint, use secure cookies and correct proxy handling, and keep Argon2 compatible. SMTP supports existing 465, 587 and 2525 configurations; actual connection and delivery are separate checks.

## Verification

Run the existing suite, typecheck, builds and Sites checks locally. Use an isolated real PostgreSQL instance for the same API tests and targeted concurrency, >4.5 MB sync, startup, reconnect, import and restore tests. Verify a real Vercel Preview, Neon latency and actual SMTP only when isolated credentials and access are available; otherwise report them as unverified. Never imply a preview is production or an SMTP connection proves delivery.
