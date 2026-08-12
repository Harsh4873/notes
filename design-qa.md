# Design QA

- Source visual truth: the selected warm editorial three-pane mock generated during the design session (the local source image is intentionally not committed)
- Implementation screenshot: unavailable by explicit user instruction
- Intended viewport: desktop 1440 × 1024; responsive source rules also target compact laptops, ≤820px mobile layouts, and ≤560px phones
- Intended state: signed-in owner, light theme, Inbox selected, one rich-text note open
- Trash boundary: soft-only removal with restore; no permanent-delete control or purge path

## Full-view comparison evidence

Unavailable by repository instruction: browser previews, rendered Pages output, and live URLs cannot be opened for verification. Source-level review confirms the selected three-pane hierarchy, quiet ivory/clay/moss palette, editorial Newsreader headings, DM Sans UI text, compact note rows with a grouped Pinned section, a reduced sticky formatting toolbar, contextual table controls, direct New note entry points, secondary Quick Capture, folders, labels, copy, pin, search, sync state, theme control, and responsive mobile navigation. The phone editor hides global chrome to leave the writing surface in focus. This is not a substitute for rendered comparison evidence.

## Focused-region comparison evidence

Blocked for the same reason. The editor-toolbar, title/prose, sidebar, note-list, empty/auth, modal, dark-theme, and mobile CSS were reviewed from source only. No implementation screenshot was captured or combined with the source visual.

## Findings

- Browser-rendered typography, wrapping, toolbar overflow, pane proportions, control alignment, and mobile safe-area behavior remain visually unverified.
- Primary interactions and console state remain browser-unverified. Unit tests, strict TypeScript checking, production build, and Firestore emulator tests are allowed and recorded separately.

## Comparison history

- No visual comparison iteration was performed because opening rendered output is explicitly disallowed. The implementation was revised through source review only.

## Implementation checklist

- The owner visually checks `/notes/` on desktop and phone after deployment.
- If anything feels visually off, the owner can report the specific screen/state for a source-level refinement pass.

final result: source QA complete; owner visual confirmation pending
