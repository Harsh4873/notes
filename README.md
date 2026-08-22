# Notes

Notes is a private writing workspace at [harsh.bet/notes/](https://harsh.bet/notes/). Every verified Google account gets its own. It combines a warm editorial interface with fast organization, rich or plain-text writing, and live phone-to-laptop sync.

## What it includes

- Folders, labels, pinning, search, and a focused three-pane workspace
- A recoverable, soft-only Trash: removed notes leave every other view and remain available to restore
- Rich-text headings, lists, tasks, editable tables, emphasis, links, alignment, highlights, and undo/redo
- Optional smart formatting for common writing patterns and pasted Markdown tables, with a plain-text mode whenever formatting is unwanted
- System, light, and dark themes
- Real-time Firestore updates, so text pasted on a phone becomes available to copy on a laptop after both devices sync
- Responsive layouts designed for desktop and mobile use

Notes intentionally has no JSON import/export, file upload, or archive feature. It also does not keep an app-owned IndexedDB or other browser database containing note bodies. Firestore is the note source of truth; the client keeps only temporary in-memory state needed by the open page.

Removing a note moves it to Trash rather than deleting it. A trashed note is flagged, not destroyed: it drops out of Inbox, folders, labels, and live-note search/counts while Trash keeps its own count. It stays recoverable until the owner restores it. The current Notes client has no hard-delete control, automatic emptying, or bulk purge.

## Owner access and sync

Any verified Google account can sign in. A valid request must come from the same authenticated UID used in its `notes_users/{uid}` path and must report Google's sign-in provider, so every account has a private workspace.

Firebase Auth remembers the session on that browser. Sign in once on each phone, laptop, or browser profile; later visits normally reconnect automatically until that device is explicitly signed out or its site data is cleared. There is no client-side PIN or reusable access code.

Notes, folders, and preferences are separate Firestore documents beneath `notes_users/{vaultId}`. A verified Google session must have an active `owner_vault_members/{uid}` record; both approved identities resolve to the same private vault, while unprovisioned accounts fail closed. Snapshot listeners deliver cross-device changes in real time. The strict schema accepts creates and updates with server timestamps and rejects unknown fields, malformed values, unverified email claims, non-Google providers, mismatched vaults, and undeclared collections. Trash is expressed inside that schema as an optional `deleted`/`deletedAt` pair, which a note either carries in full or not at all; restoring clears both fields so the document is shaped exactly like one that was never trashed. The Notes client exposes no permanent-delete or purge path. For compatibility with the shared canonical policy, the backend rules retain a legacy owner-only delete allowance for a valid note that is already in Trash; live or malformed notes still cannot be deleted.

Sync is not a backup. Firestore is durable and replicated by Google, but it is the only copy: this workspace has no export, no per-note version history, and no second store. Losing access to the Google account or the Firebase project would lose the notes with it.

## Firebase setup

This repository points the Firebase CLI at the existing `pickledgerpro` project. In Firebase Authentication:

1. Enable Google as a sign-in provider.
2. Add `harsh.bet` to **Authentication → Settings → Authorized domains**. Add any separate preview hostname only when it is intentionally used for sign-in.
3. Confirm Google sign-in is enabled and the Pages domains are authorized.

The Firebase web configuration is public client configuration, not an authorization boundary. UID isolation lives in `firestore.rules`. Because deploying Firestore rules replaces the project's entire ruleset, this file contains the complete shared private-app policy before the final deny-all.

Deploy the combined rules intentionally:

```sh
firebase deploy --only firestore:rules --project pickledgerpro
```

Run the security suite against the local emulator after any rules change:

```sh
npm run test:rules
```

Rule tests require Java 21+ and Firebase CLI `15.14.0`. The Pages workflow installs that pinned CLI version before running the emulator suite.

Before a shared Firebase rules release, run `npm run check:rules-parity` from this workspace. It verifies the reviewed rules hash even in a one-repository CI checkout and, when the sibling repositories are present, requires the Gym, Daymark, Fare, Slate, Research, Degree, Recipes, Radar, and Goals copies to be byte-identical.

## Development and Pages

```sh
npm ci
npm test
npm run typecheck
npm run build
```

Vite's public base is `/notes/`. The Pages workflow runs tests, typechecking, and the production build, validates `/notes/` asset and metadata paths, confirms no repository-level `CNAME` is present, and publishes only `dist`.
