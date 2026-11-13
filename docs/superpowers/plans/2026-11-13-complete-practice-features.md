# Complete Practice Features Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for scoped implementation and independent review. Do not overwrite concurrent edits.

**Goal:** Implement all ten features approved by the user, followed by functional and visual verification.
**Architecture:** Keep the existing React/Fastify/SQLite application. Add typed personal workspace items with account-scoped local storage and per-item cloud merge. Extend practice attempts with explicit mode, strict correction, article snapshots and round offsets. Build focused views around existing visual tokens.
**Tech Stack:** React/TypeScript, Vite, Fastify, SQLite, Vitest; existing browser preview.
**Spec:** User approval of features 1–10 and AGENTS.md. User explicitly corrected scope to ALL ten items.

## Global Constraints
- Preserve the selected soft blue/lavender cloud-room anime aesthetic and readable night mode.
- Paired source/input lines; blank input fields; no coaching, placeholders or decorative descriptions.
- Default timed practice 5 minutes; integer 1–60 minutes. Whole-article mode uses elapsed active time without a countdown.
- Existing 21 Chinese and 21 English long texts remain unchanged.
- IME candidates are never scored until committed; strict correction must not interfere with composition.
- Keep protected Sites files intact; no deployment requested.
- Reuse current checkout/branch because it contains the user's accumulated uncommitted prototype work.

## Contracts
- Shared types: `src/lib/models.ts` (ArticleSnapshot, SavedPractice, PracticeRecord, ReaderSettings, WorkspaceItem).
- Authenticated `GET /api/workspace` and `POST /api/workspace/sync` return `{items, serverTime}`. POST accepts `{items}`; merge by kind/id and updatedAt, retain deletion tombstones. Scores in this workspace never grant leaderboard eligibility.
- Existing start endpoint accepts optional `mode: timed|article`, `strict: boolean`; history returns article/typed/round details for new records, legacy summaries still work.
- Leaderboard query extends existing language/difficulty/duration with `period: all|week|month`, optional articleId, mode, strict. Return entries plus `self` and total, ranked by the same filtering. Official ranks use server-scored built-in attempts; personal continuation/custom drills remain personal records.
- Frontend `usePractice` accepts article snapshot and settings/callbacks, exposes save/load for drafts. Completed timed rounds keep a continuation with an offset; only new characters count toward each round's speed.

## Review Focus
- Cross-account state and stale sync responses cannot leak or overwrite another user's workspace.
- A resumed round must not count previous characters twice; full completion removes its draft.
- Strict input, IME boundaries, resize and automatic pause work together.
- Edited private articles cannot rewrite saved draft/history snapshots.
- Rankings and cloud records have separate trust boundaries; recent period rankings select best attempts in that period.

### 1. Backend services
- [x] Test workspace authentication/isolation/merge/tombstones/limits and implement endpoints.
- [x] Test and implement modes, saved history details and ranking periods/article/mode/self rank.
- [x] Preserve existing API tests and migration behavior.

### 2. Practice engine
- [x] Test and implement timed/article modes, strict correction, visibility pause.
- [x] Add full record snapshots, corrected-error samples and continuation drafts; loading/switching drafts preserves active time.
- [x] Adapt paired rows to strict cursor and configurable typography/visible rows.

### 3. Feature views
- [x] Article library: title/author/theme/length search, favorites, personal TXT import/edit/delete.
- [x] Draft box: list progress and resume individual article snapshots.
- [x] Mistake notebook: recurring words/characters/punctuation and selected-item drills.
- [x] History details with article/round completion, errors and same-article repeat.
- [x] 7/30-day language-separated statistics and meaningful empty states.
- [x] Settings dialog and responsive day/night styles matching current tokens.

### 4. Integration
- [x] Account-scoped workspace persistence, conflict merge and sync retries/status.
- [x] Wire all views, callbacks, settings, focus/fullscreen and expanded rankings in App.
- [x] Safely pause/save when navigating, with no text loss or disabled dead ends.
- [x] Run full tests, typecheck/build/Sites tests, fresh independent code review.
- [x] Browser flow verification, baseline/after screenshots, mobile and night comparisons; document final design QA.

## Progress
- Planning: full scope 1–10 confirmed; shared contracts established.
- Review fixes: immutable round draft IDs; terminal deletion markers; active progress forks after remote deletion; owner assertion on start/history/ranking/sync; pending local result recovery during sync failure; one rejected sync item cannot block other valid items.
- Browser evidence: two isolated storage origins synchronized favorites, private TXT content, reader/rule settings and drafts. Continuation advanced from32 to40 while scoring only8 new characters. Deleting the original32-character draft remotely kept it deleted while a fresh33-character draft preserved new input.
- Visual findings fixed: modal stacking/viewport scroll, oversized long lists, native dark slider tracks in day mode, uneven continuation metrics. Preserve blank inputs and concise labels.
- Final acceptance (2026-11-14): 157 tests, TypeScript, build and 4 Sites tests passed; protected handoff files unchanged. Desktop/mobile day/night screenshots compared with the baseline. Full evidence and verification limits: `docs/qa/2026-11-14-full-features.md`.
