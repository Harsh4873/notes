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
    content: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep this thought.' }] }] }),
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

function useMockSync(notes: NoteRecord[], notesReady = true) {
  const api = {
    authStatus: 'signed-in',
    user: {
      uid: 'owner-one',
      displayName: 'Test User',
      email: 'user.one@example.com',
      emailVerified: true,
    } as User,
    notes,
    notesReady,
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
    retrySync: vi.fn(),
    createFolder: vi.fn(async (_name: string, _color?: string) => 'new-folder'),
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
  window.localStorage.clear();
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
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe('Trash interactions', () => {
  it('moves a live note to Trash only after a committed left swipe', async () => {
    const api = useMockSync([makeNote()]);
    render(<App />);

    const foreground = screen.getByRole('listitem').querySelector('.note-row-foreground');
    expect(foreground).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Move Swipe me to Trash' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete Swipe me permanently/ })).not.toBeInTheDocument();

    dispatchPointer(foreground!, 'pointerdown', 104, 40);
    dispatchPointer(foreground!, 'pointermove', 70, 42);
    dispatchPointer(foreground!, 'pointerup', 70, 42);
    expect(api.setNoteTrashed).not.toHaveBeenCalled();

    dispatchPointer(foreground!, 'pointerdown', 104, 40);
    dispatchPointer(foreground!, 'pointermove', 12, 42);
    dispatchPointer(foreground!, 'pointerup', 12, 42);

    await waitFor(() => {
      expect(api.setNoteTrashed).toHaveBeenCalledWith('note-1', true, 0);
    });
  });

  it('keeps trashed notes recoverable without exposing permanent deletion', async () => {
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
    const restoreButton = await screen.findByRole('button', { name: 'Restore Trashed thought' });
    expect(screen.queryByRole('button', { name: /permanently/i })).not.toBeInTheDocument();
    fireEvent.click(restoreButton);

    await waitFor(() => {
      expect(api.setNoteTrashed).toHaveBeenCalledWith('trashed-note', false, 3);
    });
  });
});

describe('Editor', () => {
  it('selects the first desktop note and opens the editor without blanking the app', async () => {
    useMockSync([makeNote()]);
    const { container } = render(<App />);

    // A torn-down Tiptap editor (React StrictMode / Suspense reveal) used to
    // throw during mount and, with no error boundary, unmount the whole app to
    // a blank screen. The editor must mount instead.
    await waitFor(() => {
      expect(container.querySelector('.rich-text-editor')).not.toBeNull();
    });
    expect(screen.queryByLabelText('Note title')).not.toBeInTheDocument();
    expect(container.querySelector('.rich-text-editor__prose')).toHaveTextContent('Keep this thought.');
  });

  it('creates inside the current label as plain text and focuses the writing surface', async () => {
    const planningNote = makeNote({ labels: ['Planning'] });
    const api = useMockSync([planningNote]);
    const { container, rerender } = render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Planning 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create a new note' }));

    await waitFor(() => {
      expect(api.createNote).toHaveBeenCalledWith(expect.objectContaining({
        title: '',
        folderId: 'inbox',
        labels: ['Planning'],
        pinned: false,
        format: 'plain',
      }));
    });

    api.notes = [...api.notes, makeNote({
      id: 'new-note',
      title: '',
      content: '',
      contentText: '',
      format: 'plain',
      labels: ['Planning'],
    })];
    rerender(<App />);

    const writingSurface = await waitFor(() => {
      const surface = container.querySelector<HTMLElement>('.rich-text-editor__surface--plain textarea');
      expect(surface).not.toBeNull();
      return surface!;
    });
    await waitFor(() => expect(writingSurface).toHaveFocus());
  });
});

describe('Workspace usability', () => {
  it('distinguishes notes loading from a truly empty workspace', () => {
    useMockSync([], false);
    render(<App />);

    expect(screen.getByRole('status', { name: 'Loading notes' })).toBeInTheDocument();
    expect(screen.queryByText('A clear desk, for now')).not.toBeInTheDocument();
  });

  it('matches every search term across title and note body', async () => {
    useMockSync([
      makeNote({
        id: 'match',
        title: 'Trip checklist',
        content: 'Pack the charger',
        contentText: 'Pack the charger',
        format: 'plain',
      }),
      makeNote({
        id: 'miss',
        title: 'Trip ideas',
        content: 'Book a museum',
        contentText: 'Book a museum',
        format: 'plain',
      }),
    ]);
    const { container } = render(<App />);

    await waitFor(() => expect(container.querySelectorAll('.note-row')).toHaveLength(2));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search notes' }), {
      target: { value: 'trip charger' },
    });

    await waitFor(() => {
      const titles = Array.from(container.querySelectorAll('.note-row-top strong'))
        .map((title) => title.textContent);
      expect(titles).toEqual(['Trip checklist']);
    });
  });

  it('creates folders with the selected color', async () => {
    const api = useMockSync([]);
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
    fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'Ideas' } });
    fireEvent.click(screen.getByRole('button', { name: 'moss folder color' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create folder' }));

    await waitFor(() => {
      expect(api.createFolder).toHaveBeenCalledWith('Ideas', 'moss');
    });
  });

  it('hides the note list the same way as the folder sidebar', async () => {
    useMockSync([makeNote()]);
    const { container } = render(<App />);

    const shell = container.querySelector('.app-shell');
    expect(shell).not.toHaveClass('list-collapsed');
    fireEvent.click(screen.getByRole('button', { name: 'Hide note list' }));
    expect(shell).toHaveClass('list-collapsed');
    expect(screen.getByRole('button', { name: 'Show note list' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show note list' }));
    expect(shell).not.toHaveClass('list-collapsed');
  });
});


describe('Note names and writing tools', () => {
  it('renames from the sidebar without changing the body and preserves the name while writing', async () => {
    const api = useMockSync([makeNote({ format: 'plain', content: 'Keep this thought.' })]);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename Swipe me' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Note name' }), { target: { value: 'My notebook' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(api.updateNote).toHaveBeenCalledWith('note-1', { title: 'My notebook' }, 0));
    const body = await screen.findByRole('textbox', { name: 'Plain text note' });
    expect(body).toHaveValue('Keep this thought.');
    fireEvent.change(body, { target: { value: 'Updated writing' } });
    fireEvent.blur(body);
    await waitFor(() => expect(api.updateNote).toHaveBeenLastCalledWith('note-1', {
      content: 'Updated writing', contentText: 'Updated writing', format: 'plain',
    }, 1));
  });

  it('opens rename with F2 and cancels without saving', async () => {
    const api = useMockSync([makeNote()]);
    const { container } = render(<App />);
    fireEvent.keyDown(container.querySelector('.note-row-select')!, { key: 'F2' });
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Note name' })).toHaveFocus());
    fireEvent.change(screen.getByRole('textbox', { name: 'Note name' }), { target: { value: 'Discard this name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Rename note' })).not.toBeInTheDocument();
    expect(api.updateNote).not.toHaveBeenCalled();
  });

  it('duplicates the latest body, formatting backup, folder, and labels', async () => {
    const original = makeNote({ format: 'plain', content: 'Original body', richBackup: '<p><strong>Original body</strong></p>', labels: ['Planning'], pinned: true });
    const api = useMockSync([original]);
    render(<App />);
    const body = await screen.findByRole('textbox', { name: 'Plain text note' });
    fireEvent.change(body, { target: { value: 'Newest draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Note details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate note' }));
    await waitFor(() => expect(api.createNote).toHaveBeenCalledWith({
      title: 'Swipe me (copy)', content: 'Newest draft', contentText: 'Newest draft',
      richBackup: original.richBackup, format: 'plain', folderId: 'inbox', labels: ['Planning'], pinned: true,
    }));
    expect(api.setNoteTrashed).not.toHaveBeenCalled();
  });

  it('copies only the body, leaving the sidebar name out', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    useMockSync([makeNote()]);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy note' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Keep this thought.'));
  });

  it('restores the previous panel layout when leaving focus mode', () => {
    useMockSync([makeNote()]);
    const { container } = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide folders' }));
    fireEvent.click(screen.getByRole('button', { name: 'Focus mode' }));
    expect(container.querySelector('main')).toHaveClass('is-focused', 'sidebar-collapsed', 'list-collapsed');
    fireEvent.click(screen.getByRole('button', { name: 'Exit focus mode' }));
    expect(container.querySelector('main')).toHaveClass('sidebar-collapsed');
    expect(container.querySelector('main')).not.toHaveClass('is-focused', 'list-collapsed');
  });
});
