import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNotesSync } from './useNotesSync';

const UID = 'test-uid';
const NOTES_PATH = `notes_users/${UID}/notes`;
const FOLDERS_PATH = `notes_users/${UID}/folders`;
const SETTINGS_PATH = `notes_users/${UID}/settings/current`;
const ISO = '2026-07-22T12:00:00.000Z';

interface PathRef { __path: string }

const harness = vi.hoisted(() => ({
  authListeners: [] as Array<(user: unknown) => void>,
  snapshots: new Map<string, (snapshot: unknown) => void>(),
  updateDoc: vi.fn(async () => undefined),
  setDoc: vi.fn(async () => undefined),
  runTransaction: vi.fn(async () => undefined),
}));

vi.mock('./firebase', () => ({
  APP_NAME: 'notes',
  authPersistenceReady: Promise.resolve(undefined),
  firebaseAuth: { currentUser: null },
  googleProvider: {},
  notesFirestore: { __firestore: true },
}));

vi.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth: unknown, next: (user: unknown) => void) => {
    harness.authListeners.push(next);
    return () => undefined;
  },
  signInWithPopup: vi.fn(async () => ({ user: null })),
  signOut: vi.fn(async () => undefined),
}));

vi.mock('firebase/firestore', () => ({
  collection: (_firestore: unknown, ...segments: string[]) => ({ __path: segments.join('/') }),
  doc: (parent: Partial<PathRef>, ...segments: string[]) => ({
    __path: [parent?.__path, ...segments].filter(Boolean).join('/'),
  }),
  onSnapshot: (
    reference: PathRef,
    _options: unknown,
    next: (snapshot: unknown) => void,
  ) => {
    harness.snapshots.set(reference.__path, next);
    return () => harness.snapshots.delete(reference.__path);
  },
  runTransaction: harness.runTransaction,
  serverTimestamp: () => ISO,
  setDoc: harness.setDoc,
  updateDoc: harness.updateDoc,
  deleteField: () => '__delete__',
}));

function collectionSnapshot(docs: Array<{ id: string; data: unknown }>) {
  return {
    docs: docs.map(({ id, data }) => ({ id, data: () => data })),
    empty: docs.length === 0,
    metadata: { fromCache: false, hasPendingWrites: false },
  };
}

const folderDoc = {
  id: 'inbox',
  data: {
    id: 'inbox',
    name: 'Inbox',
    color: 'sand',
    order: 0,
    createdAt: ISO,
    updatedAt: ISO,
  },
};

function settingsSnapshot() {
  return {
    exists: () => true,
    data: () => ({ theme: 'system', smartFormatting: true, updatedAt: ISO }),
    metadata: { fromCache: false, hasPendingWrites: false },
  };
}

function emit(path: string, snapshot: unknown) {
  const listener = harness.snapshots.get(path);
  if (!listener) throw new Error(`No listener registered for ${path}`);
  act(() => listener(snapshot));
}

/** Deliver one routine metadata event on the notes stream, as Firestore does
 *  constantly while the app is open. */
function emitRoutineNotesSnapshot() {
  emit(NOTES_PATH, collectionSnapshot([]));
}

async function renderSignedInSync() {
  const view = renderHook(() => useNotesSync());
  await waitFor(() => expect(harness.authListeners.length).toBeGreaterThan(0));

  act(() => {
    harness.authListeners.forEach((listener) => listener({
      uid: UID,
      emailVerified: true,
      providerData: [{ providerId: 'google.com' }],
    }));
  });

  await waitFor(() => expect(harness.snapshots.size).toBe(3));
  emit(NOTES_PATH, collectionSnapshot([]));
  emit(FOLDERS_PATH, collectionSnapshot([folderDoc]));
  emit(SETTINGS_PATH, settingsSnapshot());

  await waitFor(() => expect(view.result.current.syncStatus).toBe('synced'));
  return view;
}

beforeEach(() => {
  harness.authListeners.length = 0;
  harness.snapshots.clear();
  harness.updateDoc.mockClear();
  harness.setDoc.mockClear();
  harness.runTransaction.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('write failures', () => {
  it('keeps reporting a rejected write instead of letting the next snapshot claim "Synced"', async () => {
    const { result } = await renderSignedInSync();
    const syncedAt = result.current.lastSyncedAt;

    harness.updateDoc.mockRejectedValueOnce(
      Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }),
    );
    await act(async () => {
      await expect(result.current.updateSettings({ theme: 'dark' })).rejects.toBeTruthy();
    });

    expect(result.current.syncStatus).toBe('error');
    expect(result.current.error).toBe('This account cannot access the private Notes collection.');

    // The regression: a routine snapshot used to reset the stream error flag and
    // flip the UI to "Synced - just now" even though the edit was refused and
    // Notes keeps no local copy of it.
    emitRoutineNotesSnapshot();
    emitRoutineNotesSnapshot();

    expect(result.current.syncStatus).toBe('error');
    expect(result.current.error).toBe('This account cannot access the private Notes collection.');
    expect(result.current.lastSyncedAt).toBe(syncedAt);
  });

  it('clears the failure only once a later write actually lands', async () => {
    const { result } = await renderSignedInSync();

    harness.updateDoc.mockRejectedValueOnce(
      Object.assign(new Error('offline'), { code: 'unavailable' }),
    );
    await act(async () => {
      await expect(result.current.updateSettings({ theme: 'dark' })).rejects.toBeTruthy();
    });
    expect(result.current.syncStatus).toBe('error');

    await act(async () => {
      await result.current.updateSettings({ theme: 'light' });
    });

    expect(result.current.syncStatus).toBe('synced');
    expect(result.current.error).toBeUndefined();
  });

  it('does not let a concurrent write that succeeds hide another write that was refused', async () => {
    const { result } = await renderSignedInSync();

    let rejectSlowWrite: (reason: unknown) => void = () => undefined;
    harness.updateDoc
      .mockReturnValueOnce(new Promise((_resolve, reject) => { rejectSlowWrite = reject; }))
      .mockResolvedValueOnce(undefined);

    let refused: Promise<unknown> = Promise.resolve();
    await act(async () => {
      refused = result.current.updateSettings({ theme: 'dark' });
      refused.catch(() => undefined);
      // A second, unrelated save starts while the first is still in flight.
      const succeeds = result.current.updateSettings({ smartFormatting: false });
      rejectSlowWrite(Object.assign(new Error('refused'), { code: 'permission-denied' }));
      await succeeds;
      await refused.catch(() => undefined);
    });

    expect(result.current.syncStatus).toBe('error');
    expect(result.current.error).toBe('This account cannot access the private Notes collection.');

    emitRoutineNotesSnapshot();
    expect(result.current.syncStatus).toBe('error');
  });

  it('stops reporting a rejected write once the owner retries', async () => {
    const { result } = await renderSignedInSync();

    harness.updateDoc.mockRejectedValueOnce(
      Object.assign(new Error('refused'), { code: 'permission-denied' }),
    );
    await act(async () => {
      await expect(result.current.updateSettings({ theme: 'dark' })).rejects.toBeTruthy();
    });
    expect(result.current.syncStatus).toBe('error');

    act(() => result.current.retrySync());
    await waitFor(() => expect(harness.snapshots.size).toBe(3));
    emit(NOTES_PATH, collectionSnapshot([]));
    emit(FOLDERS_PATH, collectionSnapshot([folderDoc]));
    emit(SETTINGS_PATH, settingsSnapshot());

    await waitFor(() => expect(result.current.syncStatus).toBe('synced'));
    expect(result.current.error).toBeUndefined();
  });
});
