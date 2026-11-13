# Line-by-line Practice Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the existing typing site work as paired source/input rows, with a complete practice and review flow.
**Architecture:** Keep the existing full-text practice state and server contract. A responsive row component projects that state into short lines; the hook accepts row prefixes without scoring IME candidates. Existing auth, article collections and Sites infrastructure remain intact.
**Tech Stack:** React, TypeScript, Vite, Vitest, existing Fastify API.
**Spec:** User screenshot and AGENTS.md; scoped visual target is the paired-line practice anatomy, retaining existing blue/lavender assets.

## Global Constraints
- Default 5 minutes; whole minutes 1–60; finish when all characters are entered.
- Preserve graphemes, spaces, punctuation, newlines, active time, local recovery and IME behavior.
- Keep protected Sites files intact. Open and verify the local preview.

## Review Focus
- A committed IME phrase spanning a row boundary must not lose or duplicate characters.
- Backspace at an empty row must correct the previous row and count once.
- Resize during composition must not move the active input.
- Finishing a partial attempt must stop time and save one result.
- Restart cancellation must preserve text and resume the previous running state.

### Task 1: Paired practice rows
- [x] Add failing wrapping and integration tests for text preservation, row advance, cross-row deletion, IME, and restoration.
- [x] Implement `src/lib/practice-lines.ts`, `src/components/PracticeLines.tsx`, and prefix-aware input handling in `src/hooks/usePractice.ts`.
- [x] Replace the paragraph/textarea in `src/App.tsx`; use responsive styles in `src/styles.css`.
- [x] Run focused tests and typecheck.

### Task 2: Complete practice controls and results
- [x] Add failing tests for partial finish, restart confirmation and revisiting results.
- [x] Add progress, visible top controls, safe restart/end, next article and error review.
- [x] Update feature documentation; run full unit tests, build and Sites compatibility tests.
- [x] Review the change independently and verify Chinese/English, day/night, mobile and recovery in the available browser. Save design QA evidence.

## Execution decisions
- Implement in the existing checkout on `codex/line-by-line-practice` so the user's running preview receives the changes.
- Use the current React/API stack; no additional dependency or deployment is needed.

## Completion evidence
- 81 unit/integration tests, typecheck, build and 4 Sites worker checks pass.
- Reviewer findings fixed with failing-then-passing regressions: beforeinput correction, IME selection preservation, confirmation during BFCache restore. Unchanged row components are memoized to avoid long-article input stalls.
- Existing declared Playwright test dependency was missing locally; `npm install --ignore-scripts` restored it without changing the package manifest or lockfile.
- Browser and design comparison evidence is recorded in `design-qa.md`. Native OS IME remains a manual verification limit; no external deployment was requested.
