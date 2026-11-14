# Role-based login and separate administration

User chose a shared login button with role-based destination. Remove management from the public navigation and practice layout; administrators arrive in an independent management shell after login/session restore. Retain the current blue/lavender controls and all management features. Keep `/admin` as a compatible destination/bookmark, not a separate public navigation item.

- [x] Add failing tests for shared login, restored admin session, normal-user destination, logout, role changes and explicit front-site preview/return with saved practice.
- [x] Split at the authenticated App boundary. A separate AdminWorkspace owns its header/theme/logout, and renders existing AdminConsole without cloud-room imagery or practice navigation. Capture preview owner so account changes cannot retain an old role's mode.
- [x] Keep regular practice/auth flows intact; use its existing account entry to return from admin preview, parking any active practice before switching.
- [x] Update real browser tests for automatic role routing and preview. Run full tests, typecheck/build/Sites/browser checks and inspect desktop/mobile day/night pages against the captured baseline.
- [ ] Independent focused review, push PR, verify CI, merge main and refresh the running local service. Preserve all user data and protected Sites files.

Implementation stays on the existing task checkout using a new feature branch. User has already authorized implementation, testing, commits and CI-gated main integration. No new design choice is needed: the user selected the shared-login approach.

Local verification: 209 tests, typecheck/build, 4 Sites tests, 13 Chromium E2E tests and Docker smoke passed. Independent review fixes and visual evidence are recorded in `docs/qa/2026-11-14-admin-login-flow.md`.
