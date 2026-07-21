import { describe, expect, it } from 'vitest';
import {
  collectLabelCounts,
  filterAndSortNotes,
  filterNotes,
  noteTextByteSize,
  normalizeLabels,
  parseFolderRecord,
  parseNoteRecord,
  parseNotesSettings,
  sortFolders,
  sortNotes,
  timestampToIso,
} from './notesCore';
import { NOTE_CONFLICT_CODE, NoteConflictError } from './types';
import type { FolderRecord, NoteRecord } from './types';

const older = '2026-07-20T10:00:00.000Z';
const newer = '2026-07-21T10:00:00.000Z';

function makeNote(overrides: Partial<NoteRecord> = {}): NoteRecord {
  return {
    id: 'note-1',
    title: 'Trip checklist',
    content: '<p>Pack a charger</p>',
    contentText: 'Pack a charger',
    richBackup: '',
    format: 'rich',
    folderId: 'personal',
    labels: ['Travel'],
    pinned: false,
    revision: 0,
    createdAt: older,
    updatedAt: older,
    ...overrides,
  };
}

function makeFolder(overrides: Partial<FolderRecord> = {}): FolderRecord {
  return {
    id: 'personal',
    name: 'Personal',
    color: 'clay',
    order: 0,
    createdAt: older,
    updatedAt: older,
    ...overrides,
  };
}

describe('strict Firestore parsing', () => {
  it('parses exact note documents and converts Firestore-like timestamps', () => {
    const note = makeNote({ createdAt: newer, updatedAt: newer });
    const cloudValue = {
      ...note,
      createdAt: { toDate: () => new Date(newer) },
      updatedAt: { toDate: () => new Date(newer) },
    };
    expect(parseNoteRecord(cloudValue, note.id)).toEqual(note);
  });

  it('rejects missing, extra, mismatched, and invalid note fields', () => {
    const note = makeNote();
    const { title: _missing, ...withoutTitle } = note;
    expect(parseNoteRecord(withoutTitle, note.id)).toBeNull();
    expect(parseNoteRecord({ ...note, archived: false }, note.id)).toBeNull();
    expect(parseNoteRecord(note, 'different-id')).toBeNull();
    expect(parseNoteRecord({ ...note, labels: new Array(13).fill('label') }, note.id)).toBeNull();
    expect(parseNoteRecord({ ...note, title: 'x'.repeat(241) }, note.id)).toBeNull();
    expect(parseNoteRecord({ ...note, folderId: 'not a valid id' }, note.id)).toBeNull();
    expect(parseNoteRecord({ ...note, labels: ['Travel', 'Travel'] }, note.id)).toBeNull();
    expect(parseNoteRecord({ ...note, labels: ['   '] }, note.id)).toBeNull();
    expect(parseNoteRecord({ ...note, revision: -1 }, note.id)).toBeNull();
    expect(parseNoteRecord({ ...note, revision: 0.5 }, note.id)).toBeNull();
    expect(parseNoteRecord({ ...note, richBackup: 'x'.repeat(600_001) }, note.id)).toBeNull();
    expect(parseNoteRecord({
      ...note,
      content: '🙂'.repeat(220_000),
      contentText: '',
      richBackup: '',
    }, note.id)).toBeNull();
  });

  it('parses folders and settings only when every exact field is valid', () => {
    const folder = makeFolder();
    expect(parseFolderRecord(folder, folder.id)).toEqual(folder);
    expect(parseFolderRecord({ ...folder, order: 0.5 }, folder.id)).toBeNull();
    expect(parseFolderRecord({ ...folder, color: 'not a color!' }, folder.id)).toBeNull();
    expect(parseFolderRecord({ ...folder, color: 'not_allowed' }, folder.id)).toBeNull();
    expect(parseFolderRecord({ ...folder, name: 'x'.repeat(81) }, folder.id)).toBeNull();
    expect(parseFolderRecord({ ...folder, name: ' \t\n ' }, folder.id)).toBeNull();

    expect(parseNotesSettings({ theme: 'dark', smartFormatting: true, updatedAt: newer }))
      .toEqual({ theme: 'dark', smartFormatting: true, updatedAt: newer });
    expect(parseNotesSettings({ theme: 'sepia', smartFormatting: true, updatedAt: newer })).toBeNull();
    expect(parseNotesSettings({ theme: 'dark', smartFormatting: true, updatedAt: newer, extra: true })).toBeNull();
  });

  it('rejects invalid timestamps instead of silently inventing dates', () => {
    expect(timestampToIso('not-a-date')).toBeNull();
    expect(timestampToIso({ toDate: () => new Date('invalid') })).toBeNull();
  });
});

describe('note document size budget', () => {
  it('counts UTF-8 bytes across current content, search text, and rich backup', () => {
    expect(noteTextByteSize('a', 'é', '🙂')).toBe(7);
  });
});

describe('optimistic concurrency contract', () => {
  it('exposes typed revision conflict details for recovery UI', () => {
    const conflict = new NoteConflictError('note-1', 3, 4);
    expect(conflict).toBeInstanceOf(Error);
    expect(conflict.code).toBe(NOTE_CONFLICT_CODE);
    expect(conflict.noteId).toBe('note-1');
    expect(conflict.expectedRevision).toBe(3);
    expect(conflict.currentRevision).toBe(4);
  });
});

describe('labels', () => {
  it('trims, collapses spaces, removes case-insensitive duplicates, and caps labels at twelve', () => {
    const labels = ['  School  Work ', 'school work', ...Array.from({ length: 20 }, (_, index) => `Tag ${index}`)];
    const normalized = normalizeLabels(labels);
    expect(normalized[0]).toBe('School Work');
    expect(normalized).toHaveLength(12);
    expect(normalized.filter((label) => label.toLowerCase() === 'school work')).toHaveLength(1);
    expect(normalizeLabels(['x'.repeat(60)])[0]).toHaveLength(48);
  });

  it('collects case-insensitive label counts for filter menus', () => {
    const notes = [
      makeNote({ id: 'one', labels: ['Travel', 'Ideas'] }),
      makeNote({ id: 'two', labels: ['travel'] }),
    ];
    expect(collectLabelCounts(notes)).toEqual([
      { label: 'Ideas', count: 1 },
      { label: 'Travel', count: 2 },
    ]);
  });
});

describe('client-side organization', () => {
  it('sorts pinned notes first, then by most recently updated', () => {
    const notes = [
      makeNote({ id: 'old', title: 'Old', updatedAt: older }),
      makeNote({ id: 'new', title: 'New', updatedAt: newer }),
      makeNote({ id: 'pin', title: 'Pinned', pinned: true, updatedAt: older }),
    ];
    expect(sortNotes(notes).map((note) => note.id)).toEqual(['pin', 'new', 'old']);
    expect(notes.map((note) => note.id)).toEqual(['old', 'new', 'pin']);
  });

  it('sorts folders by integer order and then name', () => {
    const folders = [
      makeFolder({ id: 'z', name: 'Zebra', order: 2 }),
      makeFolder({ id: 'b', name: 'Beta', order: 1 }),
      makeFolder({ id: 'a', name: 'Alpha', order: 1 }),
    ];
    expect(sortFolders(folders).map((folder) => folder.id)).toEqual(['a', 'b', 'z']);
  });

  it('filters by folder, every selected label, format, pinned state, and all search terms', () => {
    const notes = [
      makeNote({ id: 'match', labels: ['Travel', 'Urgent'], pinned: true }),
      makeNote({ id: 'wrong-folder', folderId: 'projects', labels: ['Travel', 'Urgent'], pinned: true }),
      makeNote({ id: 'missing-label', labels: ['Travel'], pinned: true }),
      makeNote({ id: 'plain', labels: ['Travel', 'Urgent'], pinned: true, format: 'plain' }),
    ];
    expect(filterNotes(notes, {
      query: 'trip charger',
      folderId: 'personal',
      labels: ['travel', 'urgent'],
      pinnedOnly: true,
      format: 'rich',
    }).map((note) => note.id)).toEqual(['match']);
  });

  it('offers a combined filter-and-sort helper for the note list', () => {
    const notes = [
      makeNote({ id: 'older', updatedAt: older, labels: ['Travel'] }),
      makeNote({ id: 'newer', updatedAt: newer, labels: ['Travel'] }),
      makeNote({ id: 'other', updatedAt: newer, labels: ['Work'] }),
    ];
    expect(filterAndSortNotes(notes, { labels: ['travel'] }).map((note) => note.id))
      .toEqual(['newer', 'older']);
  });
});
