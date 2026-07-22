import type { User } from 'firebase/auth';

export type NoteFormat = 'rich' | 'plain';
export type ThemePreference = 'system' | 'light' | 'dark';

export interface NoteRecord {
  id: string;
  title: string;
  content: string;
  contentText: string;
  richBackup: string;
  format: NoteFormat;
  folderId: string;
  labels: string[];
  pinned: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** Present only while the note sits in Trash. Restoring clears both fields. */
  deleted?: true;
  deletedAt?: string;
}

export interface FolderRecord {
  id: string;
  name: string;
  color: string;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface NotesSettings {
  theme: ThemePreference;
  smartFormatting: boolean;
  updatedAt: string;
}

export type AuthStatus = 'loading' | 'signed-out' | 'signed-in';
export type NotesSyncStatus = 'idle' | 'syncing' | 'synced' | 'offline' | 'error';

export interface CreateNoteInput {
  title?: string;
  content?: string;
  contentText?: string;
  richBackup?: string;
  format?: NoteFormat;
  folderId?: string;
  labels?: string[];
  pinned?: boolean;
}

export type UpdateNotePatch = Partial<Pick<
  NoteRecord,
  'title' | 'content' | 'contentText' | 'richBackup' | 'format' | 'folderId' | 'labels' | 'pinned'
>>;

export const NOTE_CONFLICT_CODE = 'notes/revision-conflict' as const;

export class NoteConflictError extends Error {
  readonly code = NOTE_CONFLICT_CODE;

  constructor(
    readonly noteId: string,
    readonly expectedRevision: number,
    readonly currentRevision: number,
  ) {
    super(`Note ${noteId} changed from revision ${expectedRevision} to ${currentRevision}.`);
    this.name = 'NoteConflictError';
  }
}

export type UpdateFolderPatch = Partial<Pick<FolderRecord, 'name' | 'color' | 'order'>>;
export type UpdateSettingsPatch = Partial<Pick<NotesSettings, 'theme' | 'smartFormatting'>>;

export interface NotesSyncApi {
  authStatus: AuthStatus;
  user: User | null;
  notes: NoteRecord[];
  folders: FolderRecord[];
  settings: NotesSettings;
  syncStatus: NotesSyncStatus;
  lastSyncedAt?: string;
  error?: string;
  authError?: string;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  createNote: (input?: CreateNoteInput) => Promise<string>;
  updateNote: (id: string, patch: UpdateNotePatch, expectedRevision: number) => Promise<void>;
  setNoteTrashed: (id: string, trashed: boolean, expectedRevision: number) => Promise<number>;
  permanentlyDeleteNote: (id: string, expectedRevision: number) => Promise<void>;
  retrySync: () => void;
  createFolder: (name: string) => Promise<string>;
  updateFolder: (id: string, patch: UpdateFolderPatch) => Promise<void>;
  updateSettings: (patch: UpdateSettingsPatch) => Promise<void>;
}
