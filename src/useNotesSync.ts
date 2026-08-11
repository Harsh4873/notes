import { useCallback, useEffect, useRef, useState } from 'react';
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth';
import {
  collection,
  deleteField,
  doc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  type DocumentData,
  type QuerySnapshot,
  type SnapshotMetadata,
  type Unsubscribe,
} from 'firebase/firestore';
import {
  authPersistenceReady,
  firebaseAuth,
  googleProvider,
  notesFirestore,
} from './firebase';
import {
  DEFAULT_NOTES_SETTINGS,
  INBOX_FOLDER_ID,
  MAX_FOLDER_ORDER,
  MAX_FOLDER_NAME_LENGTH,
  MAX_NOTE_CONTENT_LENGTH,
  MAX_NOTE_CONTENT_TEXT_LENGTH,
  MAX_NOTE_REVISION,
  MAX_NOTE_RICH_BACKUP_LENGTH,
  MAX_NOTE_TITLE_LENGTH,
  MAX_NOTE_TEXT_BYTES,
  STARTER_FOLDERS,
  isFolderColor,
  isFolderId,
  isFolderOrder,
  isNoteRevision,
  isRecordId,
  noteTextByteSize,
  normalizeLabels,
  parseFolderRecord,
  parseNoteRecord,
  parseNotesSettings,
  sortFolders,
  sortNotes,
} from './notesCore';
import { NoteConflictError } from './types';
import type {
  CreateNoteInput,
  FolderRecord,
  NoteRecord,
  NotesSettings,
  NotesSyncApi,
  NotesSyncStatus,
  UpdateFolderPatch,
  UpdateNotePatch,
  UpdateSettingsPatch,
} from './types';

type StreamName = 'notes' | 'folders' | 'settings';

interface StreamState {
  ready: boolean;
  fromCache: boolean;
  hasPendingWrites: boolean;
}

function initialStreamStates(): Record<StreamName, StreamState> {
  return {
    notes: { ready: false, fromCache: true, hasPendingWrites: false },
    folders: { ready: false, fromCache: true, hasPendingWrites: false },
    settings: { ready: false, fromCache: true, hasPendingWrites: false },
  };
}

function initialStreamErrors(): Record<StreamName, boolean> {
  return { notes: false, folders: false, settings: false };
}

function browserIsOnline() {
  return typeof navigator === 'undefined' || navigator.onLine;
}

function errorCode(error: unknown) {
  return typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
}

export function friendlyNotesError(error: unknown): string {
  const code = errorCode(error);
  if (code.includes('notes/revision-conflict')) {
    return 'This note changed on another device. Review the latest cloud version, then choose which edit to keep.';
  }
  if (code.includes('popup-closed-by-user')) return 'Sign-in was cancelled.';
  if (code.includes('popup-blocked')) return 'Allow the Google sign-in window, then try again.';
  if (code.includes('network-request-failed') || code.includes('unavailable') || !browserIsOnline()) {
    return 'You are offline. Notes will reconnect and sync automatically.';
  }
  if (code.includes('permission-denied')) return 'This account cannot access the private Notes collection.';
  if (code.includes('unauthenticated')) return 'Your Google session expired. Sign in again to resume syncing.';
  if (error instanceof Error && error.message) return error.message;
  return 'Notes could not finish syncing. Try again in a moment.';
}

function isVerifiedGoogleUser(user: User) {
  return user.emailVerified
    && user.providerData.some(({ providerId }) => providerId === 'google.com');
}

function notesCollection(uid: string) {
  return collection(notesFirestore, 'notes_users', uid, 'notes');
}

function foldersCollection(uid: string) {
  return collection(notesFirestore, 'notes_users', uid, 'folders');
}

function settingsDocument(uid: string) {
  return doc(notesFirestore, 'notes_users', uid, 'settings', 'current');
}

function metadataState(metadata: SnapshotMetadata): StreamState {
  return {
    ready: true,
    fromCache: metadata.fromCache,
    hasPendingWrites: metadata.hasPendingWrites,
  };
}

function parseCollection<T>(
  snapshot: QuerySnapshot<DocumentData>,
  parser: (value: unknown, documentId?: string) => T | null,
): T[] | null {
  const parsed: T[] = [];
  for (const item of snapshot.docs) {
    const value = parser(item.data({ serverTimestamps: 'estimate' }), item.id);
    if (!value) return null;
    parsed.push(value);
  }
  return parsed;
}

function assertText(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string') throw new Error(`${field} must be text.`);
}

function assertRecordId(value: unknown, label: string): asserts value is string {
  if (!isRecordId(value)) throw new Error(`${label} has an invalid id.`);
}

function verifiedGoogleMessage() {
  return 'Use a verified Google account to sync Notes.';
}

export function useNotesSync(): NotesSyncApi {
  const [authStatus, setAuthStatus] = useState<NotesSyncApi['authStatus']>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [settings, setSettings] = useState<NotesSettings>(DEFAULT_NOTES_SETTINGS);
  const [syncStatus, setSyncStatus] = useState<NotesSyncStatus>(() => (
    browserIsOnline() ? 'idle' : 'offline'
  ));
  const [lastSyncedAt, setLastSyncedAt] = useState<string>();
  const [error, setError] = useState<string>();

  const activeUidRef = useRef<string | null>(null);
  const foldersRef = useRef<FolderRecord[]>([]);
  const streamStatesRef = useRef(initialStreamStates());
  const streamErrorsRef = useRef(initialStreamErrors());
  const pendingWritesRef = useRef(0);
  const writeErrorRef = useRef<string | undefined>(undefined);
  const writeFailureCountRef = useRef(0);
  const restartListenersRef = useRef<() => void>(() => undefined);

  const updateSyncStatus = useCallback(() => {
    if (!browserIsOnline()) {
      setSyncStatus('offline');
      return;
    }
    if (!activeUidRef.current) {
      setSyncStatus('idle');
      return;
    }
    if (Object.values(streamErrorsRef.current).some(Boolean)) {
      setSyncStatus('error');
      return;
    }

    // A rejected write is not repaired by the next snapshot. Notes keeps no
    // local copy of an edit the server refused, so the change is already gone:
    // keep reporting the failure until a later write actually lands, or until
    // the owner asks to retry. Reporting "Synced" here would claim a save that
    // never happened.
    if (writeErrorRef.current) {
      setError(writeErrorRef.current);
      setSyncStatus('error');
      return;
    }

    const streams = Object.values(streamStatesRef.current);
    if (pendingWritesRef.current > 0
      || streams.some((stream) => !stream.ready || stream.fromCache || stream.hasPendingWrites)) {
      setSyncStatus('syncing');
      return;
    }

    setSyncStatus('synced');
    setLastSyncedAt(new Date().toISOString());
    setError(undefined);
  }, []);

  const trackWrite = useCallback(async <T,>(write: Promise<T>): Promise<T> => {
    const failuresAtStart = writeFailureCountRef.current;
    pendingWritesRef.current += 1;
    setSyncStatus(browserIsOnline() ? 'syncing' : 'offline');
    try {
      const result = await write;
      pendingWritesRef.current = Math.max(0, pendingWritesRef.current - 1);
      // Only a write that ran start to finish without any other write being
      // rejected may clear the error. A concurrent save that happens to
      // succeed must never paper over a sibling save the server refused.
      if (writeFailureCountRef.current === failuresAtStart) writeErrorRef.current = undefined;
      updateSyncStatus();
      return result;
    } catch (writeError) {
      pendingWritesRef.current = Math.max(0, pendingWritesRef.current - 1);
      writeFailureCountRef.current += 1;
      writeErrorRef.current = friendlyNotesError(writeError);
      setError(writeErrorRef.current);
      setSyncStatus(browserIsOnline() ? 'error' : 'offline');
      throw writeError;
    }
  }, [updateSyncStatus]);

  useEffect(() => {
    let disposed = false;
    let unsubscribeAuth: Unsubscribe | undefined;
    let streamUnsubscribes: Unsubscribe[] = [];
    let seedingFolders = false;
    let seedingSettings = false;
    let rejectedAccountMessage: string | undefined;

    function stopListeners() {
      streamUnsubscribes.forEach((unsubscribe) => unsubscribe());
      streamUnsubscribes = [];
      streamStatesRef.current = initialStreamStates();
      streamErrorsRef.current = initialStreamErrors();
      writeErrorRef.current = undefined;
    }

    function handleStreamError(stream: StreamName, streamError: unknown) {
      if (disposed) return;
      streamErrorsRef.current[stream] = true;
      setError(friendlyNotesError(streamError));
      const code = errorCode(streamError);
      setSyncStatus(!browserIsOnline() || code.includes('unavailable') ? 'offline' : 'error');
    }

    function acceptStreamMetadata(stream: StreamName, metadata: SnapshotMetadata) {
      streamStatesRef.current[stream] = metadataState(metadata);
      streamErrorsRef.current[stream] = false;
      updateSyncStatus();
    }

    function seedFolders(uid: string) {
      if (seedingFolders) return;
      seedingFolders = true;
      const references = STARTER_FOLDERS.map((folder) => (
        doc(foldersCollection(uid), folder.id)
      ));
      void trackWrite(runTransaction(notesFirestore, async (transaction) => {
        // Read every starter first so transaction retries can never overwrite a
        // folder another device created or edited after the empty snapshot.
        const snapshots = [];
        for (const reference of references) snapshots.push(await transaction.get(reference));
        snapshots.forEach((snapshot, index) => {
          if (snapshot.exists()) return;
          const folder = STARTER_FOLDERS[index];
          transaction.set(references[index], {
            id: folder.id,
            name: folder.name,
            color: folder.color,
            order: folder.order,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        });
      }))
        .catch(() => undefined)
        .finally(() => { seedingFolders = false; });
    }

    function seedSettings(uid: string) {
      if (seedingSettings) return;
      seedingSettings = true;
      const reference = settingsDocument(uid);
      void trackWrite(runTransaction(notesFirestore, async (transaction) => {
        const snapshot = await transaction.get(reference);
        if (snapshot.exists()) return;
        transaction.set(reference, {
          theme: DEFAULT_NOTES_SETTINGS.theme,
          smartFormatting: DEFAULT_NOTES_SETTINGS.smartFormatting,
          updatedAt: serverTimestamp(),
        });
      }))
        .catch(() => undefined)
        .finally(() => { seedingSettings = false; });
    }

    function startListeners(uid: string) {
      stopListeners();
      seedingFolders = false;
      seedingSettings = false;
      setSyncStatus(browserIsOnline() ? 'syncing' : 'offline');

      streamUnsubscribes.push(onSnapshot(
        notesCollection(uid),
        { includeMetadataChanges: true },
        (snapshot) => {
          const parsed = parseCollection(snapshot, parseNoteRecord);
          if (!parsed) {
            streamStatesRef.current.notes = metadataState(snapshot.metadata);
            handleStreamError('notes', new Error('A cloud note has an unsupported format.'));
            return;
          }
          const nextNotes = sortNotes(parsed);
          setNotes(nextNotes);
          acceptStreamMetadata('notes', snapshot.metadata);
        },
        (streamError) => handleStreamError('notes', streamError),
      ));

      streamUnsubscribes.push(onSnapshot(
        foldersCollection(uid),
        { includeMetadataChanges: true },
        (snapshot) => {
          const parsed = parseCollection(snapshot, parseFolderRecord);
          if (!parsed) {
            streamStatesRef.current.folders = metadataState(snapshot.metadata);
            handleStreamError('folders', new Error('A cloud folder has an unsupported format.'));
            return;
          }
          const nextFolders = sortFolders(parsed);
          foldersRef.current = nextFolders;
          setFolders(nextFolders);
          acceptStreamMetadata('folders', snapshot.metadata);
          if (snapshot.empty && !snapshot.metadata.fromCache) seedFolders(uid);
        },
        (streamError) => handleStreamError('folders', streamError),
      ));

      streamUnsubscribes.push(onSnapshot(
        settingsDocument(uid),
        { includeMetadataChanges: true },
        (snapshot) => {
          if (!snapshot.exists()) {
            setSettings(DEFAULT_NOTES_SETTINGS);
            acceptStreamMetadata('settings', snapshot.metadata);
            if (!snapshot.metadata.fromCache) seedSettings(uid);
            return;
          }

          const parsed = parseNotesSettings(snapshot.data({ serverTimestamps: 'estimate' }));
          if (!parsed) {
            streamStatesRef.current.settings = metadataState(snapshot.metadata);
            handleStreamError('settings', new Error('Cloud settings have an unsupported format.'));
            return;
          }
          setSettings(parsed);
          acceptStreamMetadata('settings', snapshot.metadata);
        },
        (streamError) => handleStreamError('settings', streamError),
      ));
    }
    restartListenersRef.current = () => {
      const uid = activeUidRef.current;
      if (uid) startListeners(uid);
    };

    function resetPrivateState() {
      foldersRef.current = [];
      setNotes([]);
      setFolders([]);
      setSettings(DEFAULT_NOTES_SETTINGS);
      setLastSyncedAt(undefined);
    }

    function registerAuthListener() {
      if (disposed) return;
      unsubscribeAuth = onAuthStateChanged(firebaseAuth, (authUser) => {
        if (disposed) return;
        stopListeners();
        activeUidRef.current = null;
        setUser(null);

        if (!authUser) {
          resetPrivateState();
          setAuthStatus('signed-out');
          if (rejectedAccountMessage) {
            setError(rejectedAccountMessage);
            setSyncStatus('error');
            rejectedAccountMessage = undefined;
          } else {
            setError(undefined);
            setSyncStatus(browserIsOnline() ? 'idle' : 'offline');
          }
          return;
        }

        if (!isVerifiedGoogleUser(authUser)) {
          rejectedAccountMessage = verifiedGoogleMessage();
          resetPrivateState();
          setAuthStatus('signed-out');
          setError(rejectedAccountMessage);
          setSyncStatus('error');
          void firebaseSignOut(firebaseAuth).catch((signOutError) => {
            if (!disposed) setError(friendlyNotesError(signOutError));
          });
          return;
        }

        activeUidRef.current = authUser.uid;
        setUser(authUser);
        setAuthStatus('signed-in');
        setError(undefined);
        startListeners(authUser.uid);
      }, (authError) => {
        if (disposed) return;
        activeUidRef.current = null;
        setUser(null);
        setAuthStatus('signed-out');
        setError(friendlyNotesError(authError));
        setSyncStatus(browserIsOnline() ? 'error' : 'offline');
      });
    }

    void authPersistenceReady.then(registerAuthListener).catch((persistenceError) => {
      if (disposed) return;
      setError(`Notes could not remember this browser yet. ${friendlyNotesError(persistenceError)}`);
      registerAuthListener();
    });

    function handleOffline() {
      setSyncStatus('offline');
    }

    function handleOnline() {
      if (activeUidRef.current && Object.values(streamErrorsRef.current).some(Boolean)) {
        restartListenersRef.current();
      } else {
        updateSyncStatus();
      }
    }

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);

    return () => {
      disposed = true;
      unsubscribeAuth?.();
      stopListeners();
      restartListenersRef.current = () => undefined;
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, [trackWrite, updateSyncStatus]);

  const signIn = useCallback(async () => {
    setError(undefined);
    if (!browserIsOnline()) {
      setSyncStatus('offline');
      setError('Connect to the internet for the one-time Google sign-in.');
      return;
    }
    setSyncStatus('syncing');
    try {
      await authPersistenceReady;
      const result = await signInWithPopup(firebaseAuth, googleProvider);
      if (!isVerifiedGoogleUser(result.user)) {
        await firebaseSignOut(firebaseAuth);
        setAuthStatus('signed-out');
        setUser(null);
        setSyncStatus('error');
        setError(verifiedGoogleMessage());
      }
    } catch (signInError) {
      setAuthStatus(firebaseAuth.currentUser ? 'signed-in' : 'signed-out');
      setError(friendlyNotesError(signInError));
      setSyncStatus(browserIsOnline() ? 'error' : 'offline');
    }
  }, []);

  const signOut = useCallback(async () => {
    setError(undefined);
    try {
      await firebaseSignOut(firebaseAuth);
    } catch (signOutError) {
      setError(friendlyNotesError(signOutError));
      setSyncStatus(browserIsOnline() ? 'error' : 'offline');
    }
  }, []);

  const createNote = useCallback(async (input: CreateNoteInput = {}) => {
    const uid = activeUidRef.current;
    if (!uid) throw new Error('Sign in before creating a note.');

    const format = input.format ?? 'rich';
    if (format !== 'rich' && format !== 'plain') throw new Error('Choose rich or plain text format.');
    if (input.title !== undefined) assertText(input.title, 'Note title');
    if (input.content !== undefined) assertText(input.content, 'Note content');
    if (input.contentText !== undefined) assertText(input.contentText, 'Searchable note text');
    if (input.richBackup !== undefined) assertText(input.richBackup, 'Rich text backup');
    if (input.folderId !== undefined) assertText(input.folderId, 'Folder');
    if (input.folderId !== undefined && !isFolderId(input.folderId)) throw new Error('Choose a valid folder.');
    if (input.pinned !== undefined && typeof input.pinned !== 'boolean') throw new Error('Pinned must be true or false.');
    if (input.labels !== undefined
      && (!Array.isArray(input.labels) || !input.labels.every((label) => typeof label === 'string'))) {
      throw new Error('Labels must be text.');
    }

    const content = input.content ?? '';
    const contentText = input.contentText ?? (format === 'plain' ? content : '');
    const richBackup = input.richBackup ?? '';
    if (content.length > MAX_NOTE_CONTENT_LENGTH) throw new Error('This note is too large to sync safely.');
    if (contentText.length > MAX_NOTE_CONTENT_TEXT_LENGTH) throw new Error('This note has too much searchable text to sync safely.');
    if (richBackup.length > MAX_NOTE_RICH_BACKUP_LENGTH) throw new Error('This note backup is too large to sync safely.');
    if (noteTextByteSize(content, contentText, richBackup) > MAX_NOTE_TEXT_BYTES) {
      throw new Error('This note and its rich-text backup are too large to sync safely together.');
    }
    const reference = doc(notesCollection(uid));
    await trackWrite(setDoc(reference, {
      id: reference.id,
      title: (input.title ?? '').slice(0, MAX_NOTE_TITLE_LENGTH),
      content,
      contentText,
      richBackup,
      format,
      folderId: input.folderId ?? INBOX_FOLDER_ID,
      labels: normalizeLabels(input.labels ?? []),
      pinned: input.pinned ?? false,
      revision: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
    return reference.id;
  }, [trackWrite]);

  const updateNote = useCallback(async (
    id: string,
    patch: UpdateNotePatch,
    expectedRevision: number,
  ) => {
    const uid = activeUidRef.current;
    if (!uid) throw new Error('Sign in before updating a note.');
    assertRecordId(id, 'Note');
    if (!isNoteRevision(expectedRevision)) {
      throw new Error(`Note revision must be a whole number from 0 to ${MAX_NOTE_REVISION}.`);
    }

    const data: Record<string, unknown> = {};
    if (patch.title !== undefined) {
      assertText(patch.title, 'Note title');
      data.title = patch.title.slice(0, MAX_NOTE_TITLE_LENGTH);
    }
    if (patch.content !== undefined) {
      assertText(patch.content, 'Note content');
      if (patch.content.length > MAX_NOTE_CONTENT_LENGTH) throw new Error('This note is too large to sync safely.');
      data.content = patch.content;
    }
    if (patch.contentText !== undefined) {
      assertText(patch.contentText, 'Searchable note text');
      if (patch.contentText.length > MAX_NOTE_CONTENT_TEXT_LENGTH) {
        throw new Error('This note has too much searchable text to sync safely.');
      }
      data.contentText = patch.contentText;
    }
    if (patch.richBackup !== undefined) {
      assertText(patch.richBackup, 'Rich text backup');
      if (patch.richBackup.length > MAX_NOTE_RICH_BACKUP_LENGTH) {
        throw new Error('This note backup is too large to sync safely.');
      }
      data.richBackup = patch.richBackup;
    }
    if (patch.format !== undefined) {
      if (patch.format !== 'rich' && patch.format !== 'plain') throw new Error('Choose rich or plain text format.');
      data.format = patch.format;
    }
    if (patch.folderId !== undefined) {
      assertText(patch.folderId, 'Folder');
      if (!isFolderId(patch.folderId)) throw new Error('Choose a valid folder.');
      data.folderId = patch.folderId;
    }
    if (patch.labels !== undefined) {
      if (!Array.isArray(patch.labels) || !patch.labels.every((label) => typeof label === 'string')) {
        throw new Error('Labels must be text.');
      }
      data.labels = normalizeLabels(patch.labels);
    }
    if (patch.pinned !== undefined) {
      if (typeof patch.pinned !== 'boolean') throw new Error('Pinned must be true or false.');
      data.pinned = patch.pinned;
    }
    if (Object.keys(data).length === 0) return;

    const reference = doc(notesCollection(uid), id);
    await trackWrite(runTransaction(notesFirestore, async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists()) throw new Error('This note no longer exists in the cloud.');

      const current = parseNoteRecord(snapshot.data(), id);
      if (!current) throw new Error('This cloud note has an unsupported format.');
      if (current.revision !== expectedRevision) {
        throw new NoteConflictError(id, expectedRevision, current.revision);
      }
      if (current.revision >= MAX_NOTE_REVISION) {
        throw new Error('This note has reached its safe revision limit.');
      }

      const nextContent = typeof data.content === 'string' ? data.content : current.content;
      const nextContentText = typeof data.contentText === 'string' ? data.contentText : current.contentText;
      const nextRichBackup = typeof data.richBackup === 'string' ? data.richBackup : current.richBackup;
      if (noteTextByteSize(nextContent, nextContentText, nextRichBackup) > MAX_NOTE_TEXT_BYTES) {
        throw new Error('This note and its rich-text backup are too large to sync safely together.');
      }

      transaction.update(reference, {
        ...data,
        revision: current.revision + 1,
        updatedAt: serverTimestamp(),
      });
    }));
  }, [trackWrite]);

  const setNoteTrashed = useCallback(async (
    id: string,
    trashed: boolean,
    expectedRevision: number,
  ) => {
    const uid = activeUidRef.current;
    if (!uid) throw new Error('Sign in before moving a note to Trash.');
    assertRecordId(id, 'Note');
    if (typeof trashed !== 'boolean') throw new Error('Trashed must be true or false.');
    if (!isNoteRevision(expectedRevision)) {
      throw new Error(`Note revision must be a whole number from 0 to ${MAX_NOTE_REVISION}.`);
    }

    const reference = doc(notesCollection(uid), id);
    return trackWrite(runTransaction(notesFirestore, async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists()) throw new Error('This note no longer exists in the cloud.');

      const current = parseNoteRecord(snapshot.data(), id);
      if (!current) throw new Error('This cloud note has an unsupported format.');
      if (current.revision !== expectedRevision) {
        throw new NoteConflictError(id, expectedRevision, current.revision);
      }
      if (current.revision >= MAX_NOTE_REVISION) {
        throw new Error('This note has reached its safe revision limit.');
      }
      if ((current.deleted === true) === trashed) return current.revision;

      transaction.update(reference, {
        // Restoring clears both fields so a restored note is indistinguishable
        // from one that was never trashed, which is what the ruleset expects.
        deleted: trashed ? true : deleteField(),
        deletedAt: trashed ? serverTimestamp() : deleteField(),
        revision: current.revision + 1,
        updatedAt: serverTimestamp(),
      });
      return current.revision + 1;
    }));
  }, [trackWrite]);

  const permanentlyDeleteNote = useCallback(async (
    id: string,
    expectedRevision: number,
  ) => {
    const uid = activeUidRef.current;
    if (!uid) throw new Error('Sign in before permanently deleting a note.');
    assertRecordId(id, 'Note');
    if (!isNoteRevision(expectedRevision)) {
      throw new Error(`Note revision must be a whole number from 0 to ${MAX_NOTE_REVISION}.`);
    }

    const reference = doc(notesCollection(uid), id);
    await trackWrite(runTransaction(notesFirestore, async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists()) throw new Error('This note no longer exists in the cloud.');

      const current = parseNoteRecord(snapshot.data(), id);
      if (!current) throw new Error('This cloud note has an unsupported format.');
      if (current.deleted !== true) {
        throw new Error('Move this note to Trash before permanently deleting it.');
      }
      if (current.revision !== expectedRevision) {
        throw new NoteConflictError(id, expectedRevision, current.revision);
      }

      transaction.delete(reference);
    }));
  }, [trackWrite]);

  const createFolder = useCallback(async (name: string) => {
    const uid = activeUidRef.current;
    if (!uid) throw new Error('Sign in before creating a folder.');
    assertText(name, 'Folder name');
    const cleanName = name.trim().slice(0, MAX_FOLDER_NAME_LENGTH).trim();
    if (!cleanName) throw new Error('Give the folder a name.');

    const colors = ['clay', 'moss', 'gold', 'blue', 'plum', 'stone'];
    const highestOrder = foldersRef.current.reduce((highest, folder) => Math.max(highest, folder.order), -1);
    const order = Math.min(MAX_FOLDER_ORDER, highestOrder + 1);
    const color = colors[foldersRef.current.length % colors.length];
    const reference = doc(foldersCollection(uid));
    await trackWrite(setDoc(reference, {
      id: reference.id,
      name: cleanName,
      color,
      order,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
    return reference.id;
  }, [trackWrite]);

  const updateFolder = useCallback(async (id: string, patch: UpdateFolderPatch) => {
    const uid = activeUidRef.current;
    if (!uid) throw new Error('Sign in before updating a folder.');
    assertRecordId(id, 'Folder');

    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) {
      assertText(patch.name, 'Folder name');
      const cleanName = patch.name.trim().slice(0, MAX_FOLDER_NAME_LENGTH).trim();
      if (!cleanName) throw new Error('Give the folder a name.');
      data.name = cleanName;
    }
    if (patch.color !== undefined) {
      if (!isFolderColor(patch.color)) throw new Error('Choose a valid folder color.');
      data.color = patch.color;
    }
    if (patch.order !== undefined) {
      if (!isFolderOrder(patch.order)) throw new Error('Folder order must be a whole number from 0 to 10000.');
      data.order = patch.order;
    }
    if (Object.keys(data).length === 0) return;

    data.updatedAt = serverTimestamp();
    await trackWrite(updateDoc(doc(foldersCollection(uid), id), data));
  }, [trackWrite]);

  const updateSettings = useCallback(async (patch: UpdateSettingsPatch) => {
    const uid = activeUidRef.current;
    if (!uid) throw new Error('Sign in before updating settings.');
    if (patch.theme !== undefined
      && patch.theme !== 'system'
      && patch.theme !== 'light'
      && patch.theme !== 'dark') throw new Error('Choose system, light, or dark theme.');
    if (patch.smartFormatting !== undefined && typeof patch.smartFormatting !== 'boolean') {
      throw new Error('Smart formatting must be true or false.');
    }
    if (patch.theme === undefined && patch.smartFormatting === undefined) return;

    const reference = settingsDocument(uid);
    const data: Record<string, unknown> = { updatedAt: serverTimestamp() };
    if (patch.theme !== undefined) data.theme = patch.theme;
    if (patch.smartFormatting !== undefined) data.smartFormatting = patch.smartFormatting;

    await trackWrite((async () => {
      try {
        // Updating only the provided keys prevents a stale device from
        // clobbering an unrelated setting changed elsewhere.
        await updateDoc(reference, data);
      } catch (settingsError) {
        if (!errorCode(settingsError).includes('not-found')) throw settingsError;

        // A first-use call can arrive before the seed transaction. Recover in
        // a transaction so a concurrently-created settings document is only
        // patched, never replaced by stale defaults.
        await runTransaction(notesFirestore, async (transaction) => {
          const snapshot = await transaction.get(reference);
          if (snapshot.exists()) {
            transaction.update(reference, data);
            return;
          }
          transaction.set(reference, {
            theme: patch.theme ?? DEFAULT_NOTES_SETTINGS.theme,
            smartFormatting: patch.smartFormatting ?? DEFAULT_NOTES_SETTINGS.smartFormatting,
            updatedAt: serverTimestamp(),
          });
        });
      }
    })());
  }, [trackWrite]);

  const retrySync = useCallback(() => {
    streamErrorsRef.current = initialStreamErrors();
    // Retrying is the owner explicitly asking to start over, so a past write
    // failure stops being reported. Nothing else clears it: only a write that
    // succeeds does.
    writeErrorRef.current = undefined;
    setError(undefined);
    if (activeUidRef.current) {
      setSyncStatus(browserIsOnline() ? 'syncing' : 'offline');
      restartListenersRef.current();
      return;
    }
    updateSyncStatus();
  }, [updateSyncStatus]);

  return {
    authStatus,
    user,
    notes,
    folders,
    settings,
    syncStatus,
    lastSyncedAt,
    error,
    authError: authStatus === 'signed-in' ? undefined : error,
    signIn,
    signOut,
    createNote,
    updateNote,
    setNoteTrashed,
    permanentlyDeleteNote,
    createFolder,
    updateFolder,
    updateSettings,
    retrySync,
  };
}
