# Prototype Instructions

Product direction: preserve the selected soft blue and lavender cloud-room anime aesthetic. Keep practice passages comfortable to read instead of using oversized central text. Maintain separate Chinese and English article collections with at least 20 passages per language across beginner, intermediate, and advanced stages. Provide a switchable, readable night mode that preserves the same visual identity.

Practice must default to five minutes, accept whole-minute durations from 1 through 60, and finish immediately when the selected article is fully entered. Preserve unfinished progress locally, support pause and resume, handle Chinese IME composition correctly, calculate speed from active time, and display article length, entered characters, errors, and backspace count.

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
