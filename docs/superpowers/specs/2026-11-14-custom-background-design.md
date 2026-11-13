# Custom background design

The user requested complete custom-background support, with all previous work committed, CI passing and the result merged into main. Continue on the existing feature branch. Existing visual identity and terse copy remain binding; the original room/cat is the default and can be restored.

## Product behavior

- Settings has a Background entry for the current day/night theme. Each theme keeps its own background; the dialog identifies the edited theme.
- Select or drop one JPEG, PNG or WebP file, at most 10 MiB. Decode before accepting, reject damaged/unsupported files and dimensions above 40 million pixels. Re-encode at a maximum 2560 px edge and 768 KiB; original metadata is not retained.
- Show a real image preview with fit (cover/contain), horizontal/vertical position (0–100), blur (0–12 px), and theme-colored shade (0–80%). Use keyboard-accessible controls with concise labels. Defaults: cover, centered, no blur, 20% shade in day and 40% at night.
- Changes stay in a dialog draft until Save. Cancel, Escape, failed upload and failed persistence preserve the previously saved background. New image selection replaces the pending image; stale decoding must never overwrite a later selection or a reset. Close during processing cancels its effect.
- Restore Default is previewed and applied with Save. Reset propagates to other devices; a later deliberate upload can replace the reset. Restoring one theme does not alter the other.
- Custom imagery replaces the room art and sleeping cat, while content surfaces, colors, type and controls retain the existing identity and readability. Corrupt saved images fall back to the original room.
- Guests persist locally. Accounts use the existing isolated local workspace and cloud sync; images never enter article/attempt/leaderboard data. Logout/account changes discard an open editor with no cross-account image flash or save.

## Implementation decisions

Use one `background` workspace item per theme (`light`/`dark`). Its value holds a bounded raster data URL, sanitized name, actual processed dimensions and display controls. Reuse IndexedDB, existing request limits, owner assertions and timestamped deletion records. This keeps images separate from reader settings and avoids uploading them on every timer/font update.

The edited theme is captured when opening the dialog so remote theme changes cannot redirect a pending save/reset. Cloud validation parses actual PNG/JPEG/WebP dimensions and matches the metadata; animated stored WebP is rejected. A server-generated SHA-256 background version lets subsequent workspace responses omit unchanged background items; the client hydrates them only from its owner-scoped verified response cache. Old clients without this header retain the full-response contract.

Considered URL-only backgrounds: rejected because they add remote tracking/broken-link problems and do not satisfy local upload. Considered a separate binary upload service: unnecessary for two small images and would add storage/cleanup/deployment dependencies. The bounded workspace representation fits the existing 4 MiB request and 32 MiB account limits.

No new external image host, dynamic image format or global palette change. No public deployment is requested. Original Sites packaging files remain intact.

## Acceptance

Meaningful unit/API tests cover unsafe file rejection, resizing/encoding, persistence failure, upload races, owner/theme isolation, sync and reset. Real Chromium tests upload a fixture, adjust it, reload, switch themes, reset and preserve typing. Inspect desktop/mobile screenshots and default restoration. Run the repository's full checks, PR CI and main CI; merge only the tested PR head.
