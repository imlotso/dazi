# Prototype Instructions

Product direction: preserve the selected soft blue and lavender cloud-room anime aesthetic. Keep practice passages comfortable to read instead of using oversized central text. Maintain separate Chinese and English article collections with at least 20 passages per language across beginner, intermediate, and advanced stages. Provide a switchable, readable night mode that preserves the same visual identity.

Typing presentation: follow the user's 2026-11-13 Kukuw reference screenshot (`/home/bobo/Pictures/Screenshots/Screenshot From 2026-11-13 19-20-43.png`) for the practice interaction: pair each short source line with its own input field, highlight the active line, and advance/follow automatically. Do not return to a full paragraph above one large input box. Preserve the cloud-room visual identity rather than copying the reference site's branding. Make the complete practice flow usable, including correction, pause/resume, saved progress, and results.

UI copy (2026-11-13): keep the interface terse. Leave typing fields empty in every idle, active, pending, paused, and finished state; do not add placeholders such as “等待上一行完成” or “点击开始”. Remove duplicate instructions, coaching, motivational sentences, decorative empty-state prose, and explanations of obvious controls across all screens. Keep concise field labels, essential status/error messages, and warnings about actual data loss. Do not reintroduce these descriptions in later edits. Inspect the rendered screens yourself and provide screenshots of key interfaces when requested.

Typing start and spacing (2026-11-14): do not require a start-practice button; begin the clock when the user first enters text, including an IME composition, while keeping focus alone idle. Display spaces in English passages as actual blank spaces, without a dot or other visible substitute. Preserve punctuation and the underlying scored characters.

Approved feature scope (2026-11-13): all ten proposed additions are approved: article search/filter/favorites, long-form continuation and draft management, recurring mistakes and drills, history details, progress statistics, practice modes/settings, focus/reading controls, private article library/TXT import, cross-device personal-data synchronization, and expanded leaderboards. Compare completed UI to the existing design language and verify the actual user flows.

Article selection (2026-11-13): replace the short demo passages with real, sourced long-form writing. Prefer emotional themes such as affection, longing, loneliness, regret, and growth. Every Chinese passage must contain at least 1,000 Han characters (excluding punctuation/whitespace); English selections use at least 1,000 words. Keep at least 20 distinct selections per language across the three stages. Use public-domain or explicitly reusable texts, retain author/source attribution, and never repeat or pad text to meet the length minimum.

Article mood preference (confirmed 2026-11-14): include both warm/healing stories and sadness, regret, or longing; keep topics varied rather than giving the whole collection one uniform mood.

Custom backgrounds (2026-11-14): provide a complete user workflow, including image selection/drop, preview, display adjustments, replacement, restoring the original background, persistent local storage and account-scoped synchronization. Preserve readable controls and the established visual identity around user images. Verify the feature and CI before merging to main.

Admin console (2026-11-14): implement actual dashboard, user and administrator role management, public article management, score moderation, and audit logs. Keep account access changes transactional and revoke affected sessions. Preserve historical article snapshots and keep private practice content and background images out of admin endpoints.

Admin entry correction (2026-11-14): use the existing shared login entry and route by the authenticated account's role. Administrator login and session restoration open a separate management interface; normal accounts remain in the practice interface. Do not place a standalone “管理后台” navigation item in the public/practice header or embed management panels in the cloud-room practice layout. Keep the blue/lavender identity in the independent management shell. An explicit front-site preview is allowed; return to management through the account entry.

Practice must default to five minutes, accept whole-minute durations from 1 through 60, and finish immediately when the selected article is fully entered. Preserve unfinished progress locally, support pause and resume, handle Chinese IME composition correctly, calculate speed from active time, and display article length, entered characters, errors, and backspace count.

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
