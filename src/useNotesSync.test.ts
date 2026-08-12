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
  snapshotErrors: new Map<string, (error: unknown) => void>(),
  signOut: vi.fn(async () => undefined),
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
  signOut: harness.signOut,
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
    error: (streamError: unknown) => void,
  ) => {
    harness.snapshots.set(reference.__path, next);
    harness.snapshotErrors.set(reference.__path, error);
    return () => {
      harness.snapshots.delete(reference.__path);
      harness.snapshotErrors.delete(reference.__path);
    };
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

function tokenResult(
  signInProvider: string | null = 'google.com',
  claims: Record<string, unknown> = { email: 'owner@example.test', email_verified: true },
) {
  return { signInProvider, claims };
}

function authUser(
  uid = UID,
  token: Promise<unknown> = Promise.resolve(tokenResult()),
) {
  return {
    uid,
    emailVerified: true,
    providerData: [{ providerId: 'google.com' }],
    getIdTokenResult: vi.fn(() => token),
  };
}

function emitAuth(user: unknown) {
  act(() => harness.authListeners.forEach((listener) => listener(user)));
}

function emit(path: string, snapshot: unknown) {
  const listener = harness.snapshots.get(path);
  if (!listener) throw new Error(`No listener registered for ${path}`);
  act(() => listener(snapshot));
}

function emitError(path: string, error: unknown) {
  const listener = harness.snapshotErrors.get(path);
  if (!listener) throw new Error(`No error listener registered for ${path}`);
  act(() => listener(error));
}

/** Deliver one routine metadata event on the notes stream, as Firestore does
 *  constantly while the app is open. */
function emitRoutineNotesSnapshot() {
  emit(NOTES_PATH, collectionSnapshot([]));
}

async function renderSignedInSync() {
  const view = renderHook(() => useNotesSync());
  await waitFor(() => expect(harness.authListeners.length).toBeGreaterThan(0));

  emitAuth(authUser());

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
  harness.snapshotErrors.clear();
  harness.signOut.mockClear();
  harness.updateDoc.mockClear();
  harness.setDoc.mockClear();
  harness.runTransaction.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('current token authorization', () => {
  it('does not expose the user or attach private listeners before token validation finishes', async () => {
    let resolveToken: (result: unknown) => void = () => undefined;
    const pendingToken = new Promise<unknown>((resolve) => { resolveToken = resolve; });
    const view = renderHook(() => useNotesSync());
    await waitFor(() => expect(harness.authListeners.length).toBeGreaterThan(0));

    emitAuth(authUser(UID, pendingToken));

    expect(view.result.current.authStatus).toBe('loading');
    expect(view.result.current.user).toBeNull();
    expect(harness.snapshots.size).toBe(0);

    await act(async () => resolveToken(tokenResult()));
    await waitFor(() => expect(harness.snapshots.size).toBe(3));
    expect(view.result.current.authStatus).toBe('signed-in');
    expect(view.result.current.user?.uid).toBe(UID);
  });

  it('uses the exact current-token provider instead of linked providerData', async () => {
    const view = renderHook(() => useNotesSync());
    await waitFor(() => expect(harness.authListeners.length).toBeGreaterThan(0));

    emitAuth(authUser(UID, Promise.resolve(tokenResult('password'))));

    await waitFor(() => expect(view.result.current.authStatus).toBe('signed-out'));
    expect(view.result.current.user).toBeNull();
    expect(view.result.current.error).toBe('Use a verified Google account to sync Notes.');
    expect(harness.snapshots.size).toBe(0);
    expect(harness.signOut).toHaveBeenCalledOnce();
  });

  it.each([
    ['a string email claim', { email_verified: true }],
    ['a verified email claim', { email: 'owner@example.test', email_verified: false }],
  ])('rejects a Google token without %s', async (_label, claims) => {
    const view = renderHook(() => useNotesSync());
    await waitFor(() => expect(harness.authListeners.length).toBeGreaterThan(0));

    emitAuth(authUser(UID, Promise.resolve(tokenResult('google.com', claims))));

    await waitFor(() => expect(view.result.current.authStatus).toBe('signed-out'));
    expect(view.result.current.user).toBeNull();
    expect(harness.snapshots.size).toBe(0);
    expect(harness.signOut).toHaveBeenCalledOnce();
  });

  it('fails closed when the current token cannot be inspected', async () => {
    const view = renderHook(() => useNotesSync());
    await waitFor(() => expect(harness.authListeners.length).toBeGreaterThan(0));

    emitAuth(authUser(UID, Promise.reject(new Error('token inspection failed'))));

    await waitFor(() => expect(view.result.current.authStatus).toBe('signed-out'));
    expect(view.result.current.user).toBeNull();
    expect(view.result.current.error).toBe(
      'Notes could not verify this Google session. Sign in again to continue.',
    );
    expect(harness.snapshots.size).toBe(0);
    expect(harness.signOut).toHaveBeenCalledOnce();
  });

  it('ignores stale token validation after a newer auth revision wins', async () => {
    let resolveFirstToken: (result: unknown) => void = () => undefined;
    const firstToken = new Promise<unknown>((resolve) => { resolveFirstToken = resolve; });
    const view = renderHook(() => useNotesSync());
    await waitFor(() => expect(harness.authListeners.length).toBeGreaterThan(0));

    emitAuth(authUser('first-uid', firstToken));
    emitAuth(authUser('second-uid'));

    await waitFor(() => expect(view.result.current.user?.uid).toBe('second-uid'));
    expect(Array.from(harness.snapshots.keys())).toEqual(expect.arrayContaining([
      'notes_users/second-uid/notes',
      'notes_users/second-uid/folders',
      'notes_users/second-uid/settings/current',
    ]));

    await act(async () => resolveFirstToken(tokenResult()));

    expect(view.result.current.user?.uid).toBe('second-uid');
    expect(Array.from(harness.snapshots.keys()).some((path) => path.includes('first-uid'))).toBe(false);
    expect(harness.signOut).not.toHaveBeenCalled();
  });
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

  it('preserves a rejected write across automatic listener recovery', async () => {
    const { result } = await renderSignedInSync();
    const syncedAt = result.current.lastSyncedAt;

    harness.updateDoc.mockRejectedValueOnce(
      Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }),
    );
    await act(async () => {
      await expect(result.current.updateSettings({ theme: 'dark' })).rejects.toBeTruthy();
    });

    emitError(NOTES_PATH, Object.assign(new Error('stream unavailable'), { code: 'unavailable' }));
    act(() => window.dispatchEvent(new Event('online')));

    emit(NOTES_PATH, collectionSnapshot([]));
    emit(FOLDERS_PATH, collectionSnapshot([folderDoc]));
    emit(SETTINGS_PATH, settingsSnapshot());

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
