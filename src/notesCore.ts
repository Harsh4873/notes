import type {
  FolderRecord,
  NoteFormat,
  NoteRecord,
  NotesSettings,
} from './types';

export const OWNER_EMAIL = 'hdav4873@gmail.com';
export const INBOX_FOLDER_ID = 'inbox';
export const MAX_LABELS_PER_NOTE = 12;
export const MAX_LABEL_LENGTH = 48;
export const MAX_NOTE_TITLE_LENGTH = 240;
export const MAX_NOTE_CONTENT_LENGTH = 600_000;
export const MAX_NOTE_CONTENT_TEXT_LENGTH = 200_000;
export const MAX_NOTE_RICH_BACKUP_LENGTH = 600_000;
// Firestore documents have a 1 MiB limit. Keeping all note strings under this
// shared UTF-8 budget leaves room for field names, labels, and timestamps.
export const MAX_NOTE_TEXT_BYTES = 850_000;
export const MAX_NOTE_REVISION = 2_147_483_647;
export const MAX_FOLDER_NAME_LENGTH = 80;
export const MAX_FOLDER_ORDER = 10_000;

export const DEFAULT_NOTES_SETTINGS: NotesSettings = {
  theme: 'system',
  smartFormatting: true,
  updatedAt: new Date(0).toISOString(),
};

export const STARTER_FOLDERS = [
  { id: 'personal', name: 'Personal', color: 'clay', order: 0 },
  { id: 'projects', name: 'Projects', color: 'blue', order: 1 },
  { id: 'learning', name: 'Learning', color: 'moss', order: 2 },
  { id: 'ideas', name: 'Ideas', color: 'gold', order: 3 },
] as const;

const NOTE_KEYS = [
  'id',
  'title',
  'content',
  'contentText',
  'richBackup',
  'format',
  'folderId',
  'labels',
  'pinned',
  'revision',
  'createdAt',
  'updatedAt',
] as const;
// Trash fields are absent on every note that has never been trashed, including
// notes written before the trash existed, so they are optional rather than
// required. Restoring removes them again.
const OPTIONAL_NOTE_KEYS = ['deleted', 'deletedAt'] as const;
const FOLDER_KEYS = ['id', 'name', 'color', 'order', 'createdAt', 'updatedAt'] as const;
const SETTINGS_KEYS = ['theme', 'smartFormatting', 'updatedAt'] as const;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const folderColorPattern = /^(?:#[0-9A-Fa-f]{6}|[a-z][a-z0-9-]{0,31})$/;
const textCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  optionalKeys: readonly string[] = [],
) {
  const allowed = new Set([...keys, ...optionalKeys]);
  return Object.keys(value).every((key) => allowed.has(key))
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export function isRecordId(value: unknown): value is string {
  return typeof value === 'string' && idPattern.test(value);
}

export function isFolderId(value: unknown): value is string {
  return value === '' || isRecordId(value);
}

export function isFolderColor(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 32 && folderColorPattern.test(value);
}

export function isFolderOrder(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    && value <= MAX_FOLDER_ORDER;
}

export function timestampToIso(value: unknown): string | null {
  let date: Date | null = null;

  if (typeof value === 'string') {
    const milliseconds = Date.parse(value);
    if (Number.isFinite(milliseconds)) date = new Date(milliseconds);
  } else if (value instanceof Date) {
    date = value;
  } else if (isObject(value) && typeof value.toDate === 'function') {
    try {
      const converted = value.toDate();
      if (converted instanceof Date) date = converted;
    } catch {
      return null;
    }
  }

  if (!date || !Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

function parseFormat(value: unknown): NoteFormat | null {
  return value === 'rich' || value === 'plain' ? value : null;
}

export function noteTextByteSize(content: string, contentText: string, richBackup: string): number {
  return new TextEncoder().encode(content).byteLength
    + new TextEncoder().encode(contentText).byteLength
    + new TextEncoder().encode(richBackup).byteLength;
}

export function isNoteRevision(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    && value <= MAX_NOTE_REVISION;
}

export function parseNoteRecord(value: unknown, documentId?: string): NoteRecord | null {
  if (!isObject(value) || !hasOnlyKeys(value, NOTE_KEYS, OPTIONAL_NOTE_KEYS)) return null;
  if (!isRecordId(value.id) || (documentId !== undefined && value.id !== documentId)) return null;
  if (typeof value.title !== 'string'
    || typeof value.content !== 'string'
    || typeof value.contentText !== 'string'
    || typeof value.richBackup !== 'string'
    || typeof value.pinned !== 'boolean') return null;
  if (value.title.length > MAX_NOTE_TITLE_LENGTH
    || value.content.length > MAX_NOTE_CONTENT_LENGTH
    || value.contentText.length > MAX_NOTE_CONTENT_TEXT_LENGTH
    || value.richBackup.length > MAX_NOTE_RICH_BACKUP_LENGTH
    || noteTextByteSize(value.content, value.contentText, value.richBackup) > MAX_NOTE_TEXT_BYTES
    || !isNoteRevision(value.revision)
    || !isFolderId(value.folderId)) return null;

  const format = parseFormat(value.format);
  const createdAt = timestampToIso(value.createdAt);
  const updatedAt = timestampToIso(value.updatedAt);
  if (!format || !createdAt || !updatedAt) return null;
  if (!Array.isArray(value.labels)
    || value.labels.length > MAX_LABELS_PER_NOTE
    || !value.labels.every((label) => (
      typeof label === 'string'
      && label.trim().length > 0
      && label.length <= MAX_LABEL_LENGTH
    ))
    || new Set(value.labels).size !== value.labels.length) return null;

  // Mirror the ruleset: a note is either untrashed with neither field, or
  // trashed with both. Any other shape is a note we refuse to display.
  const hasDeleted = Object.prototype.hasOwnProperty.call(value, 'deleted');
  const hasDeletedAt = Object.prototype.hasOwnProperty.call(value, 'deletedAt');
  let deletedAt: string | undefined;
  if (hasDeleted || hasDeletedAt) {
    if (value.deleted !== true || !hasDeletedAt) return null;
    const parsedDeletedAt = timestampToIso(value.deletedAt);
    if (!parsedDeletedAt) return null;
    deletedAt = parsedDeletedAt;
  }

  return {
    id: value.id,
    title: value.title,
    content: value.content,
    contentText: value.contentText,
    richBackup: value.richBackup,
    format,
    folderId: value.folderId,
    labels: [...value.labels],
    pinned: value.pinned,
    revision: value.revision,
    createdAt,
    updatedAt,
    ...(deletedAt ? { deleted: true as const, deletedAt } : {}),
  };
}

export function parseFolderRecord(value: unknown, documentId?: string): FolderRecord | null {
  if (!isObject(value) || !hasOnlyKeys(value, FOLDER_KEYS)) return null;
  if (!isRecordId(value.id) || (documentId !== undefined && value.id !== documentId)) return null;
  if (typeof value.name !== 'string'
    || value.name.trim().length === 0
    || value.name.length > MAX_FOLDER_NAME_LENGTH) return null;
  if (!isFolderColor(value.color) || !isFolderOrder(value.order)) return null;

  const createdAt = timestampToIso(value.createdAt);
  const updatedAt = timestampToIso(value.updatedAt);
  if (!createdAt || !updatedAt) return null;

  return {
    id: value.id,
    name: value.name,
    color: value.color,
    order: value.order,
    createdAt,
    updatedAt,
  };
}

export function parseNotesSettings(value: unknown): NotesSettings | null {
  if (!isObject(value) || !hasOnlyKeys(value, SETTINGS_KEYS)) return null;
  if (value.theme !== 'system' && value.theme !== 'light' && value.theme !== 'dark') return null;
  if (typeof value.smartFormatting !== 'boolean') return null;
  const updatedAt = timestampToIso(value.updatedAt);
  if (!updatedAt) return null;

  return {
    theme: value.theme,
    smartFormatting: value.smartFormatting,
    updatedAt,
  };
}

export function normalizeLabels(labels: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const label of labels) {
    const clean = label.trim().replace(/\s+/g, ' ').slice(0, MAX_LABEL_LENGTH).trim();
    const comparisonKey = clean.toLocaleLowerCase();
    if (!clean || seen.has(comparisonKey)) continue;
    normalized.push(clean);
    seen.add(comparisonKey);
    if (normalized.length === MAX_LABELS_PER_NOTE) break;
  }

  return normalized;
}

function timestampValue(value: string) {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : 0;
}

export function sortNotes(notes: readonly NoteRecord[]): NoteRecord[] {
  return [...notes].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    const updatedDifference = timestampValue(right.updatedAt) - timestampValue(left.updatedAt);
    if (updatedDifference !== 0) return updatedDifference;
    const titleDifference = textCollator.compare(left.title, right.title);
    return titleDifference || textCollator.compare(left.id, right.id);
  });
}

export function sortFolders(folders: readonly FolderRecord[]): FolderRecord[] {
  return [...folders].sort((left, right) => {
    const orderDifference = left.order - right.order;
    if (orderDifference !== 0) return orderDifference;
    const nameDifference = textCollator.compare(left.name, right.name);
    return nameDifference || textCollator.compare(left.id, right.id);
  });
}

export interface NoteFilters {
  query?: string;
  folderId?: string | null;
  labels?: readonly string[];
  pinnedOnly?: boolean;
  format?: NoteFormat;
}

export function filterNotes(notes: readonly NoteRecord[], filters: NoteFilters = {}): NoteRecord[] {
  const queryTerms = (filters.query ?? '')
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const wantedLabels = normalizeLabels(filters.labels ?? []).map((label) => label.toLocaleLowerCase());

  return notes.filter((note) => {
    if (filters.folderId != null && note.folderId !== filters.folderId) return false;
    if (filters.pinnedOnly && !note.pinned) return false;
    if (filters.format && note.format !== filters.format) return false;

    const noteLabels = new Set(note.labels.map((label) => label.toLocaleLowerCase()));
    if (!wantedLabels.every((label) => noteLabels.has(label))) return false;

    if (queryTerms.length > 0) {
      const searchableText = [note.title, note.contentText, ...note.labels].join('\n').toLocaleLowerCase();
      if (!queryTerms.every((term) => searchableText.includes(term))) return false;
    }

    return true;
  });
}

export function filterAndSortNotes(notes: readonly NoteRecord[], filters: NoteFilters = {}): NoteRecord[] {
  return sortNotes(filterNotes(notes, filters));
}

export interface LabelCount {
  label: string;
  count: number;
}

export function collectLabelCounts(notes: readonly NoteRecord[]): LabelCount[] {
  const counts = new Map<string, LabelCount>();
  for (const note of notes) {
    const labelsInNote = new Set<string>();
    for (const label of normalizeLabels(note.labels)) {
      const key = label.toLocaleLowerCase();
      if (labelsInNote.has(key)) continue;
      labelsInNote.add(key);
      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else counts.set(key, { label, count: 1 });
    }
  }
  return [...counts.values()].sort((left, right) => textCollator.compare(left.label, right.label));
}
