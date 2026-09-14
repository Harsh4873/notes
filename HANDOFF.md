# HANDOFF: Notes in-note image embeds

## Context
TAMU Claude Opus 4.8 hit **Budget Exceeded** (~$10.22 / $10) mid-feature on 2026-09-14.
Branch: `opus/notes-image-sharing-wip` (from `main` @ `7872785`).

## Decision (keep this)
**In-note embeds only** (not a separate gallery).

Why: Notes has no IndexedDB, no file-upload backend, no Firebase Storage in this repo. Firestore notes are locked to a fixed shared schema across sibling apps — cannot add an `images` field/subcollection without shared-rules surgery. TipTap JSON in `content` already round-trips; an `image` node with a `data:` URL in `attrs.src` fits without schema change.

## Done by Opus
- `src/imageAttachments.ts` — accept/compress helpers (max source 25 MiB, longest edge 1600, ~90 KiB target, ~320 KiB hard cap; WebP/JPEG/PNG; GIF flattened)
- `src/imageAttachments.test.ts` — unit tests for mime acceptance, scaling, note budget fit

## Still needed
1. Add `@tiptap/extension-image` (or equivalent) to TipTap extensions in `src/RichTextEditor.tsx`.
2. Wire paste / drag-drop / file-picker → `processImageFile` (or whatever the export is named) → insert image node at cursor.
3. Toolbar control for “insert image” (mobile-friendly).
4. CSS so embedded images are responsive inside the editor column.
5. Respect existing note content size limits in `editorContent` / sync validators — refuse insert + toast if `imageFitsNoteBudget` fails.
6. Plain-text mode: either strip images or block inserts; match existing rich vs plain behavior.
7. Update README: Notes now supports in-note images (compressed data URLs); still no general file upload / export / gallery.
8. Tests: editor insert path + budget rejection; keep Opus unit tests green.
9. Open a PR against `main`. Do **not** merge. Do **not** push `AGENTS.md` / `agents.md` / `CLAUDE.md` / leave `HANDOFF.md` out of the final PR if preferred (or delete it in the finishing commit).

## Constraints
- Private-by-default; no new cloud credentials; no Firebase Storage unless already present (it is not).
- Do not change `firestore.rules` shared canonical policy unless absolutely required (prefer not).
- Commit author should be clean; Cursor manager will fingerprint-clean ship as Harsh4873 later.

## Success
Working paste/drop/picker image embed in rich notes on a PR, with compression + budget guards, tests green.
