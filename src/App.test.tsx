import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { User } from 'firebase/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { NoteRecord, NotesSyncApi } from './types';
import { useNotesSync } from './useNotesSync';

vi.mock('./useNotesSync', () => ({ useNotesSync: vi.fn() }));

const mockedUseNotesSync = vi.mocked(useNotesSync);

function makeNote(overrides: Partial<NoteRecord> = {}): NoteRecord {
  return {
    id: 'note-1',
    title: 'Swipe me',
    content: '<p>Keep this thought.</p>',
    contentText: 'Keep this thought.',
    richBackup: '',
    format: 'rich',
    folderId: 'inbox',
    labels: [],
    pinned: false,
    revision: 0,
    createdAt: '2026-07-22T12:00:00.000Z',
    updatedAt: '2026-07-22T12:00:00.000Z',
    ...overrides,
  };
}

function useMockSync(notes: NoteRecord[]) {
  const api = {
    authStatus: 'signed-in',
    user: {
      displayName: 'Harsh Dave',
      email: 'hdav4873@gmail.com',
      emailVerified: true,
    } as User,
    notes,
    folders: [],
    settings: {
      theme: 'system',
      smartFormatting: true,
      updatedAt: '2026-07-22T12:00:00.000Z',
    },
    syncStatus: 'synced',
    lastSyncedAt: '2026-07-22T12:00:00.000Z',
    error: undefined,
    authError: undefined,
    signIn: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    createNote: vi.fn(async () => 'new-note'),
    updateNote: vi.fn(async () => undefined),
    setNoteTrashed: vi.fn(async (
      _id: string,
      _trashed: boolean,
      expectedRevision: number,
    ) => expectedRevision + 1),
    permanentlyDeleteNote: vi.fn(async () => undefined),
    retrySync: vi.fn(),
    createFolder: vi.fn(async () => 'new-folder'),
    updateFolder: vi.fn(async () => undefined),
    updateSettings: vi.fn(async () => undefined),
  } satisfies NotesSyncApi;

  mockedUseNotesSync.mockReturnValue(api);
  return api;
}

function dispatchPointer(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  clientX: number,
  clientY: number,
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: 0,
    cancelable: true,
    clientX,
    clientY,
  });
  Object.defineProperties(event, {
    pointerId: { value: 7 },
    pointerType: { value: 'touch' },
  });
  fireEvent(target, event);
}

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Trash interactions', () => {
  it('moves a live note to Trash only after a committed right swipe', async () => {
    const api = useMockSync([makeNote()]);
    render(<App />);

    const foreground = screen.getByRole('listitem').querySelector('.note-row-foreground');
    expect(foreground).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Move Swipe me to Trash' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete Swipe me permanently/ })).not.toBeInTheDocument();

    dispatchPointer(foreground!, 'pointerdown', 12, 40);
    dispatchPointer(foreground!, 'pointermove', 52, 42);
    dispatchPointer(foreground!, 'pointerup', 52, 42);
    expect(api.setNoteTrashed).not.toHaveBeenCalled();

    dispatchPointer(foreground!, 'pointerdown', 12, 40);
    dispatchPointer(foreground!, 'pointermove', 104, 42);
    dispatchPointer(foreground!, 'pointerup', 104, 42);

    await waitFor(() => {
      expect(api.setNoteTrashed).toHaveBeenCalledWith('note-1', true, 0);
    });
  });

  it('requires confirmation before permanently deleting a trashed note', async () => {
    const trashedNote = makeNote({
      id: 'trashed-note',
      title: 'Trashed thought',
      revision: 3,
      deleted: true,
      deletedAt: '2026-07-22T13:00:00.000Z',
    });
    const api = useMockSync([trashedNote]);
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: /^Trash/ }));
    fireEvent.click(screen.getByRole('button', {
      name: 'Delete Trashed thought permanently',
    }));

    expect(screen.getByRole('dialog', { name: 'Permanently delete note' })).toBeInTheDocument();
    expect(screen.getByText(/This cannot be undone/)).toBeInTheDocument();
    expect(api.permanentlyDeleteNote).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));

    await waitFor(() => {
      expect(api.permanentlyDeleteNote).toHaveBeenCalledWith('trashed-note', 3);
    });
    expect(screen.queryByRole('dialog', { name: 'Permanently delete note' })).not.toBeInTheDocument();
    expect(screen.getByText('“Trashed thought” permanently deleted')).toBeInTheDocument();
  });
});
