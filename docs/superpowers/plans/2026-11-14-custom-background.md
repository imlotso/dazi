# Custom Background Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for implementation and one fresh review before integration.

**Goal:** Add complete day/night custom backgrounds and merge all approved work after passing local and CI checks.
**Architecture:** Bounded raster assets are separate account-scoped workspace items; a transactional editor saves only confirmed changes. A background rendering component preserves the original theme when no usable custom asset exists.
**Tech Stack:** Existing React/TypeScript, browser canvas, IndexedDB, Fastify/SQLite, Vitest and Playwright.
**Spec:** `docs/superpowers/specs/2026-11-14-custom-background-design.md`.

## Global Constraints
- Keep current feature branch, existing UI language, blank typing fields and protected Sites files.
- File input: JPEG/PNG/WebP, 10 MiB, 40 million pixels. Saved raster: at most 2560 px per edge and 768 KiB.
- Fit cover/contain; position 0–100; blur 0–12; shade 0–80. Day/night stored separately.
- User explicitly authorizes commit, push, CI and merge main; no additional approval checkpoint.

## Review Focus
- Out-of-order image decoding, reset/close during decode, and asynchronous persistence failure.
- Account switching and stale sync must never display or save another owner's image.
- Invalid raster URLs and oversized values must be rejected before cloud persistence.
- Default restoration must synchronize while allowing a later deliberate replacement.
- Arbitrary bright/dark images, narrow screens and fullscreen must retain readable, reachable controls.

### Task 1: Image processing and storage contract
**Files:** `src/lib/background.ts`, `src/lib/models.ts`, `src/lib/workspace.ts`, `src/hooks/useWorkspace.ts`, `server/workspace.ts`, `tests/background.test.ts`, `tests/extended-api.test.ts`.
**Interfaces:** `BackgroundConfig`, `prepareBackgroundImage(File): Promise<BackgroundImage>`, `isBackgroundConfig(unknown)`, `workspace.backgrounds[theme]`; persist via existing `put/remove('background', theme, value)`.
- [x] Add failing image-validation/encoding tests and workspace/API isolation/reset tests. Run targeted Vitest and observe expected failures.
- [x] Implement bounded decode/re-encode, safe data validation and per-theme workspace support; no database schema migration needed.
- [x] Run targeted tests and typecheck; include data layer with the integrated feature commit.

### Task 2: Editor and application integration
**Files:** `src/components/BackgroundDialog.tsx`, `src/components/RoomBackground.tsx`, `src/components/SettingsDialog.tsx`, `src/App.tsx`, `src/background.css`, `src/main.tsx`, `tests/background-ui.test.tsx`.
**Interfaces:** dialog gets theme/current value and async `onSave(value | undefined)`; room gets current theme/config and existing content children.
- [x] Add failing tests for cancel, save failure, invalid replacement, stale selection, reset during processing and restored default.
- [x] Implement upload/drop, accessible preview controls, Save/Cancel, reset and default fallback. Settings opens the editor after pausing practice; preserve input.
- [x] Verify targeted tests, full unit suite and typecheck; include UI with the integrated feature commit.

### Task 3: Browser acceptance and integration
**Files:** `e2e/background.e2e.ts`, `README.md`, `docs/qa/2026-11-14-custom-background.md`.
- [x] Add meaningful browser tests using real files, persistence, theme independence, cancellation/reset, sync and account isolation.
- [x] Build and run unit/type/Sites/browser tests; inspect actual desktop/mobile/day/night screens and save screenshots.
- [x] Run a fresh whole-change review and address material findings with regression tests.
- [ ] Commit/push, open PR, follow CI and fix failures. Merge the passing head into main and verify main CI; update local main without discarding changes.

## Progress
- Baseline: commit `372dccd` contains the previously completed work; 157 tests, typecheck, build and 4 Sites checks passed immediately before committing. Feature branch pushed.
- Current checkout is already the ongoing feature workspace; continuing in place preserves the live preview and avoids duplicating accumulated work.
- Final local evidence: 174 tests, typecheck/build, 4 Sites tests, 12 Chromium e2e tests and Docker persistence/backup smoke all passed. Review fixes cover synced-theme changes and real raster dimensions; unchanged image responses now use a content version. Evidence: `docs/qa/2026-11-14-custom-background.md`.
