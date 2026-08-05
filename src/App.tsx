import { ArrowCounterClockwise } from '@phosphor-icons/react/ArrowCounterClockwise';
import { ArrowLeft } from '@phosphor-icons/react/ArrowLeft';
import { CaretDown } from '@phosphor-icons/react/CaretDown';
import { Check } from '@phosphor-icons/react/Check';
import { CloudArrowUp } from '@phosphor-icons/react/CloudArrowUp';
import { CloudCheck } from '@phosphor-icons/react/CloudCheck';
import { CloudSlash } from '@phosphor-icons/react/CloudSlash';
import { Copy } from '@phosphor-icons/react/Copy';
import { DotsThree } from '@phosphor-icons/react/DotsThree';
import { Folder } from '@phosphor-icons/react/Folder';
import { FunnelSimple } from '@phosphor-icons/react/FunnelSimple';
import { GoogleLogo } from '@phosphor-icons/react/GoogleLogo';
import { Lightning } from '@phosphor-icons/react/Lightning';
import { ListBullets } from '@phosphor-icons/react/ListBullets';
import { MagnifyingGlass } from '@phosphor-icons/react/MagnifyingGlass';
import { Monitor } from '@phosphor-icons/react/Monitor';
import { Moon } from '@phosphor-icons/react/Moon';
import { NotePencil } from '@phosphor-icons/react/NotePencil';
import { Notepad } from '@phosphor-icons/react/Notepad';
import { Plus } from '@phosphor-icons/react/Plus';
import { PushPin } from '@phosphor-icons/react/PushPin';
import { SidebarSimple } from '@phosphor-icons/react/SidebarSimple';
import { SignOut } from '@phosphor-icons/react/SignOut';
import { Sun } from '@phosphor-icons/react/Sun';
import { Tag } from '@phosphor-icons/react/Tag';
import { Trash } from '@phosphor-icons/react/Trash';
import { Tray } from '@phosphor-icons/react/Tray';
import { WarningCircle } from '@phosphor-icons/react/WarningCircle';
import { X } from '@phosphor-icons/react/X';
import type { User } from 'firebase/auth';
import {
  type ChangeEvent,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { plainTextToRichContent, richContentToPlainText } from './editorContent';
import { ErrorBoundary } from './ErrorBoundary';
import type { EditorChange } from './RichTextEditor';
import type { FolderRecord, NoteRecord, NotesSettings, ThemePreference } from './types';
import { useNotesSync } from './useNotesSync';

const RichTextEditor = lazy(async () => {
  const module = await import('./RichTextEditor');
  return { default: module.RichTextEditor };
});

type ViewKey = 'inbox' | 'all' | 'pinned' | 'trash' | `folder:${string}` | `label:${string}`;
type MobilePane = 'notes' | 'editor';
type NoteSort = 'recent' | 'oldest' | 'title';
type FormatFilter = 'all' | 'rich' | 'plain';

interface PendingSave {
  expectedRevision: number;
  patch: Partial<NoteRecord>;
}

interface SaveConflict {
  currentRevision?: number;
  message: string;
  noteId: string;
}

interface ToastState {
  actionLabel?: string;
  message: string;
  onAction?: () => void;
}

const DEFAULT_SETTINGS: NotesSettings = {
  theme: 'system',
  smartFormatting: true,
  updatedAt: '',
};

const FOLDER_COLORS = ['clay', 'moss', 'gold', 'blue', 'plum', 'stone'];

function displayDate(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'Just now';

  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  const sameDate = (left: Date, right: Date) => (
    left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
  );

  if (sameDate(date, today)) {
    return `Today, ${new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    }).format(date)}`;
  }

  if (sameDate(date, yesterday)) {
    return `Yesterday, ${new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    }).format(date)}`;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  }).format(date);
}

function cleanPreview(value: string) {
  const text = value.replace(/\s+/g, ' ').trim();
  return text || 'Start writing…';
}

function noteTitleFromText(value: string) {
  const firstMeaningfulLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^```/.test(line) && !/^(?:---+|___+|\*\*\*+)$/.test(line))
    .map((line) => line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s*/, '')
      .replace(/^[-*+]\s+\[[ xX]\]\s*/, '')
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .trim())
    .find(Boolean);
  if (!firstMeaningfulLine) return 'Untitled note';
  return firstMeaningfulLine.length > 72
    ? `${firstMeaningfulLine.slice(0, 69).trim()}…`
    : firstMeaningfulLine;
}

function labelColor(label: string) {
  const palette = ['clay', 'moss', 'sand', 'blue', 'plum', 'stone'];
  const hash = Array.from(label).reduce((total, character) => total + character.charCodeAt(0), 0);
  return palette[hash % palette.length];
}

function initials(user: User | null) {
  const source = user?.displayName?.trim() || user?.email?.split('@')[0] || 'HD';
  const parts = source.split(/\s+/).filter(Boolean);
  return parts.length > 1
    ? `${parts[0][0]}${parts.at(-1)?.[0]}`.toUpperCase()
    : source.slice(0, 2).toUpperCase();
}

function viewTitle(view: ViewKey, folders: FolderRecord[]) {
  if (view === 'inbox') return 'Inbox';
  if (view === 'all') return 'All notes';
  if (view === 'pinned') return 'Pinned';
  if (view === 'trash') return 'Trash';
  if (view.startsWith('folder:')) {
    return folders.find((folder) => folder.id === view.slice(7))?.name || 'Folder';
  }
  return view.slice(6);
}

function syncLabel(status: string, lastSyncedAt?: string) {
  if (status === 'syncing') return 'Saving…';
  if (status === 'offline') return 'Offline';
  if (status === 'error') return 'Sync needs attention';
  if (!lastSyncedAt) return 'Synced';
  const elapsed = Date.now() - Date.parse(lastSyncedAt);
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return 'Synced just now';
  const minutes = Math.max(1, Math.round(elapsed / 60_000));
  return minutes < 60 ? `Synced ${minutes}m ago` : 'Synced';
}

function errorCode(error: unknown) {
  return typeof error === 'object' && error && 'code' in error
    ? String(error.code).toLowerCase()
    : '';
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message
    ? error.message
    : 'This edit could not be saved.';
}

function isConflictError(error: unknown) {
  return errorCode(error).includes('conflict') || errorMessage(error).toLowerCase().includes('another device');
}

function isTransientSaveError(error: unknown) {
  if (!navigator.onLine) return true;
  const code = errorCode(error);
  return [
    'aborted',
    'deadline-exceeded',
    'internal',
    'network-request-failed',
    'resource-exhausted',
    'unavailable',
  ].some((candidate) => code.includes(candidate));
}

// The software keyboard shrinks the visual viewport but not the layout
// viewport, so a `position: fixed` bottom bar ends up sitting on top of the
// line you are writing. Track how much the keyboard covers so the chrome can
// get out of the way while typing.
function useKeyboardCovered() {
  const [covered, setCovered] = useState(false);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const hidden = window.innerHeight - viewport.height - viewport.offsetTop;
      setCovered(hidden > 90);
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, []);

  return covered;
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}

function patchMatches(note: NoteRecord, patch: Partial<NoteRecord>) {
  return Object.entries(patch).every(([key, value]) => {
    const cloudValue = note[key as keyof NoteRecord];
    if (Array.isArray(value) && Array.isArray(cloudValue)) {
      return value.length === cloudValue.length
        && value.every((item, index) => item === cloudValue[index]);
    }
    return cloudValue === value;
  });
}

function SyncIcon({ status }: { status: string }) {
  if (status === 'syncing') return <CloudArrowUp aria-hidden="true" />;
  if (status === 'offline') return <CloudSlash aria-hidden="true" />;
  if (status === 'error') return <WarningCircle aria-hidden="true" />;
  return <CloudCheck aria-hidden="true" />;
}

function ThemeIcon({ theme }: { theme: ThemePreference }) {
  if (theme === 'dark') return <Moon aria-hidden="true" />;
  if (theme === 'light') return <Sun aria-hidden="true" />;
  return <Monitor aria-hidden="true" />;
}

interface NavButtonProps {
  active: boolean;
  count?: number;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}

function NavButton({ active, count, icon, label, onClick }: NavButtonProps) {
  return (
    <button className={`nav-button ${active ? 'is-active' : ''}`} type="button" onClick={onClick}>
      <span className="nav-button-icon">{icon}</span>
      <span className="nav-button-label">{label}</span>
      {typeof count === 'number' && <span className="nav-button-count">{count}</span>}
    </button>
  );
}

const SWIPE_START_DISTANCE = 8;
const SWIPE_COMMIT_DISTANCE = 72;
const SWIPE_MAX_DISTANCE = 104;

interface SwipeGesture {
  axis: 'pending' | 'horizontal' | 'vertical';
  pointerId: number;
  startX: number;
  startY: number;
}

interface SwipeableNoteRowProps {
  canSwipeToTrash: boolean;
  folderName: string;
  note: NoteRecord;
  onCopy: () => void;
  onDeleteRequest: () => void;
  onRestore: () => Promise<void>;
  onSelect: () => void;
  onTrash: () => Promise<void>;
  permanentlyDeleting: boolean;
  selected: boolean;
}

function SwipeableNoteRow({
  canSwipeToTrash,
  folderName,
  note,
  onCopy,
  onDeleteRequest,
  onRestore,
  onSelect,
  onTrash,
  permanentlyDeleting,
  selected,
}: SwipeableNoteRowProps) {
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [gestureActive, setGestureActive] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const gestureRef = useRef<SwipeGesture | undefined>(undefined);
  const swipeOffsetRef = useRef(0);
  const suppressNextClickRef = useRef(false);

  const updateSwipeOffset = (nextOffset: number) => {
    swipeOffsetRef.current = nextOffset;
    setSwipeOffset(nextOffset);
  };

  const suppressSyntheticClick = () => {
    suppressNextClickRef.current = true;
    window.setTimeout(() => {
      suppressNextClickRef.current = false;
    }, 0);
  };

  const moveToTrash = async () => {
    if (!canSwipeToTrash || actionPending) return;
    setActionPending(true);
    try {
      await onTrash();
    } finally {
      updateSwipeOffset(0);
      setActionPending(false);
    }
  };

  const restore = async () => {
    if (actionPending) return;
    setActionPending(true);
    try {
      await onRestore();
    } finally {
      setActionPending(false);
    }
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!canSwipeToTrash
      || actionPending
      || event.pointerType === 'mouse'
      || event.button !== 0) return;
    gestureRef.current = {
      axis: 'pending',
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
    swipeOffsetRef.current = 0;
    suppressNextClickRef.current = false;
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    const horizontalDistance = Math.abs(deltaX);
    const verticalDistance = Math.abs(deltaY);

    if (gesture.axis === 'pending') {
      if (Math.max(horizontalDistance, verticalDistance) < SWIPE_START_DISTANCE) return;
      if (deltaX <= 0 || verticalDistance >= horizontalDistance) {
        gesture.axis = 'vertical';
        return;
      }
      if (deltaX <= verticalDistance * 1.25) return;
      gesture.axis = 'horizontal';
      setGestureActive(true);
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // The pointer may already have been cancelled by the browser's scroll gesture.
      }
    }

    if (gesture.axis !== 'horizontal') return;
    event.preventDefault();
    updateSwipeOffset(Math.min(SWIPE_MAX_DISTANCE, Math.max(0, deltaX)));
  };

  const finishPointerGesture = (
    event: ReactPointerEvent<HTMLDivElement>,
    cancelled = false,
  ) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = undefined;

    if (typeof event.currentTarget.hasPointerCapture === 'function'
      && event.currentTarget.hasPointerCapture(event.pointerId)) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Pointer capture can disappear between pointerup and lostpointercapture.
      }
    }

    const wasHorizontal = gesture.axis === 'horizontal';
    const shouldTrash = !cancelled
      && wasHorizontal
      && swipeOffsetRef.current >= SWIPE_COMMIT_DISTANCE;
    setGestureActive(false);

    if (wasHorizontal) suppressSyntheticClick();
    if (shouldTrash) {
      updateSwipeOffset(SWIPE_MAX_DISTANCE);
      void moveToTrash();
    } else {
      updateSwipeOffset(0);
    }
  };

  const title = note.title || 'Untitled note';
  const busy = actionPending || permanentlyDeleting;

  return (
    <article
      role="listitem"
      className={`note-row ${selected ? 'is-selected' : ''} ${gestureActive ? 'is-gesture-active' : ''}`}
      aria-busy={busy || undefined}
    >
      {canSwipeToTrash && (
        <div className="note-row-swipe-action" aria-hidden="true">
          <Trash />
          <span>Trash</span>
        </div>
      )}
      <div
        className="note-row-foreground"
        style={{ transform: `translate3d(${swipeOffset}px, 0, 0)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishPointerGesture}
        onPointerCancel={(event) => finishPointerGesture(event, true)}
        onLostPointerCapture={(event) => finishPointerGesture(event, true)}
      >
        <button
          className="note-row-select"
          type="button"
          onClick={(event) => {
            if (suppressNextClickRef.current) {
              event.preventDefault();
              event.stopPropagation();
              suppressNextClickRef.current = false;
              return;
            }
            onSelect();
          }}
          aria-current={selected ? 'true' : undefined}
        >
          <span className="note-row-top">
            <strong>{title}</strong>
            {note.pinned && <PushPin weight="fill" aria-label="Pinned" />}
          </span>
          <time>{displayDate(note.updatedAt)}</time>
          <span className="note-preview">{cleanPreview(note.contentText)}</span>
          <span className="note-row-footer"><span>{folderName}</span></span>
        </button>

        <div className="note-row-actions">
          {note.deleted === true ? (
            <>
              <button
                className="note-row-action"
                type="button"
                title="Restore note"
                aria-label={`Restore ${title}`}
                disabled={busy}
                onClick={() => void restore()}
              ><ArrowCounterClockwise aria-hidden="true" /></button>
              <button
                className="note-row-action is-danger"
                type="button"
                title="Delete permanently"
                aria-label={`Delete ${title} permanently`}
                disabled={busy}
                onClick={onDeleteRequest}
              ><Trash aria-hidden="true" /></button>
            </>
          ) : (
            <>
              <button
                className="note-row-action"
                type="button"
                title="Copy note"
                aria-label={`Copy ${title}`}
                disabled={busy}
                onClick={onCopy}
              ><Copy aria-hidden="true" /></button>
              <button
                className="note-row-action is-danger"
                type="button"
                title="Move to Trash"
                aria-label={`Move ${title} to Trash`}
                disabled={busy}
                onClick={() => void moveToTrash()}
              ><Trash aria-hidden="true" /></button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

interface ModalShellProps {
  children: ReactNode;
  label: string;
  onClose: () => void;
}

function ModalShell({ children, label, onClose }: ModalShellProps) {
  const layerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const layer = layerRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const background = layer?.parentElement
      ? Array.from(layer.parentElement.children).filter((element) => element !== layer)
      : [];
    const previousInert = background.map((element) => ({
      element: element as HTMLElement,
      inert: (element as HTMLElement).inert,
      ariaHidden: element.getAttribute('aria-hidden'),
    }));
    previousInert.forEach(({ element }) => {
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    });

    window.setTimeout(() => {
      const preferred = layer?.querySelector<HTMLElement>('[autofocus]');
      const first = layer?.querySelector<HTMLElement>('button, input, textarea, select, [tabindex]:not([tabindex="-1"])');
      (preferred ?? first)?.focus();
    }, 0);

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab' || !layer) return;
      const focusable = Array.from(layer.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hidden && element.getClientRects().length > 0);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1) ?? first;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      previousInert.forEach(({ element, inert, ariaHidden }) => {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', ariaHidden);
      });
      previousFocus?.focus();
    };
  }, [onClose]);

  return (
    <div ref={layerRef} className="modal-layer" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <section className="modal-sheet" role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </section>
    </div>
  );
}

function AuthScreen({
  error,
  loading,
  onSignIn,
}: {
  error?: string;
  loading: boolean;
  onSignIn: () => Promise<void>;
}) {
  const [working, setWorking] = useState(false);

  const signIn = async () => {
    setWorking(true);
    try {
      await onSignIn();
    } catch {
      // The sync hook exposes a friendly error in the sign-in panel.
    } finally {
      setWorking(false);
    }
  };

  return (
    <main className="auth-page">
      <div className="auth-wordmark">Notes</div>
      <section className="auth-panel" aria-labelledby="auth-title">
        <span className="auth-icon"><NotePencil aria-hidden="true" /></span>
        <p className="eyebrow">Private workspace</p>
        <h1 id="auth-title">Your thoughts,<br />right where you left them.</h1>
        <p className="auth-copy">
          Sign in once on this device. Notes stays private to your verified Google account and syncs quietly everywhere.
        </p>
        <button className="google-button" type="button" onClick={signIn} disabled={loading || working}>
          <GoogleLogo weight="bold" aria-hidden="true" />
          <span>{loading ? 'Checking your session…' : working ? 'Opening Google…' : 'Continue with Google'}</span>
        </button>
        {error && <p className="auth-error" role="alert">{error}</p>}
        <p className="auth-note">Only hdav4873@gmail.com can open this workspace.</p>
      </section>
      <p className="auth-footnote">Capture on your phone. Copy on your laptop. No PIN to remember.</p>
    </main>
  );
}

export function App() {
  const sync = useNotesSync();
  const settings = sync.settings ?? DEFAULT_SETTINGS;
  const isMobileLayout = useMediaQuery('(max-width: 820px)');
  const keyboardCovered = useKeyboardCovered();
  const [view, setView] = useState<ViewKey>('inbox');
  const [activeNoteId, setActiveNoteId] = useState<string>();
  const [search, setSearch] = useState('');
  const [noteSort, setNoteSort] = useState<NoteSort>('recent');
  const [formatFilter, setFormatFilter] = useState<FormatFilter>('all');
  const [listOptionsOpen, setListOptionsOpen] = useState(false);
  const [quickCaptureOpen, setQuickCaptureOpen] = useState(false);
  const [quickText, setQuickText] = useState('');
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [folderMenuOpen, setFolderMenuOpen] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [labelDraft, setLabelDraft] = useState('');
  const [profileOpen, setProfileOpen] = useState(false);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [noteDetailsOpen, setNoteDetailsOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState<MobilePane>('notes');
  const [localTitle, setLocalTitle] = useState('');
  const [toast, setToast] = useState<ToastState>();
  const [deleteCandidate, setDeleteCandidate] = useState<NoteRecord>();
  const [permanentlyDeletingNoteId, setPermanentlyDeletingNoteId] = useState<string>();
  const [permanentDeleteError, setPermanentDeleteError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, Partial<NoteRecord>>>({});
  const [saveRevision, setSaveRevision] = useState(0);
  const [localSaveError, setLocalSaveError] = useState<string>();
  const [saveConflicts, setSaveConflicts] = useState<Record<string, SaveConflict>>({});
  const saveConflict = Object.values(saveConflicts)[0];
  const searchRef = useRef<HTMLInputElement>(null);
  const quickRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const profileWrapRef = useRef<HTMLDivElement>(null);
  const themeWrapRef = useRef<HTMLDivElement>(null);
  const folderPickerRef = useRef<HTMLDivElement>(null);
  const labelPickerRef = useRef<HTMLDivElement>(null);
  const listOptionsRef = useRef<HTMLDivElement>(null);
  const noteDetailsRef = useRef<HTMLDivElement>(null);
  const saveTimers = useRef(new Map<string, number>());
  const pendingPatches = useRef(new Map<string, PendingSave>());
  const inFlightNotes = useRef(new Map<string, PendingSave>());
  const inFlightPromises = useRef(new Map<string, Promise<void>>());
  const saveErrors = useRef(new Map<string, string>());
  const acknowledgedRevisions = useRef(new Map<string, number>());
  const retryCounts = useRef(new Map<string, number>());
  const cloudNotesRef = useRef<NoteRecord[]>([]);

  const cloudNotes = sync.notes ?? [];
  cloudNotesRef.current = cloudNotes;
  const allNotes = useMemo(() => cloudNotes.map((note) => ({
    ...note,
    ...noteDrafts[note.id],
  })), [cloudNotes, noteDrafts]);
  // Every view except Trash works from live notes only, so a trashed note can
  // never resurface in Inbox, a folder, a label, search, or a count.
  const notes = useMemo(() => allNotes.filter((note) => note.deleted !== true), [allNotes]);
  const trashedNotes = useMemo(() => allNotes.filter((note) => note.deleted === true), [allNotes]);
  const folders = sync.folders ?? [];
  const activeNote = allNotes.find((note) => note.id === activeNoteId);
  const activeNoteTrashed = activeNote?.deleted === true;

  const labels = useMemo(() => {
    const counts = new Map<string, number>();
    notes.forEach((note) => note.labels.forEach((label) => {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }));
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [notes]);

  const visibleNotes = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    const inTrashView = view === 'trash';
    return (inTrashView ? trashedNotes : notes)
      .filter((note) => {
        if (formatFilter !== 'all' && note.format !== formatFilter) return false;
        if (normalizedSearch) {
          const folderName = folders.find((folder) => folder.id === note.folderId)?.name ?? '';
          return [note.title, note.contentText, folderName, ...note.labels]
            .some((value) => value.toLowerCase().includes(normalizedSearch));
        }
        if (inTrashView) return true;
        if (view === 'inbox') return note.folderId === 'inbox';
        if (view === 'pinned') return note.pinned;
        if (view.startsWith('folder:')) return note.folderId === view.slice(7);
        if (view.startsWith('label:')) return note.labels.includes(view.slice(6));
        return true;
      })
      .sort((left, right) => {
        if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
        if (noteSort === 'oldest') return Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
        if (noteSort === 'title') return left.title.localeCompare(right.title, undefined, { sensitivity: 'base', numeric: true });
        return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      });
  }, [folders, formatFilter, noteSort, notes, search, trashedNotes, view]);

  const counts = useMemo(() => ({
    inbox: notes.filter((note) => note.folderId === 'inbox').length,
    pinned: notes.filter((note) => note.pinned).length,
    trash: trashedNotes.length,
  }), [notes, trashedNotes]);

  const showToast = useCallback((message: string, action?: Omit<ToastState, 'message'>) => {
    const next: ToastState = { message, ...action };
    setToast(next);
    // An undoable toast lingers so the action is actually reachable on a phone.
    const lifetime = action?.onAction ? 6000 : 2200;
    window.setTimeout(
      () => setToast((current) => (current === next ? undefined : current)),
      lifetime,
    );
  }, []);

  const touchSaveState = useCallback(() => {
    setSaveRevision((revision) => revision + 1);
  }, []);

  const setNoteSaveError = useCallback((noteId: string, message?: string) => {
    if (message) saveErrors.current.set(noteId, message);
    else saveErrors.current.delete(noteId);
    setLocalSaveError(saveErrors.current.values().next().value);
  }, []);

  const flushNoteRef = useRef<(noteId: string) => Promise<void>>(async () => undefined);

  const scheduleFlush = useCallback((noteId: string, delay: number) => {
    const currentTimer = saveTimers.current.get(noteId);
    if (currentTimer) window.clearTimeout(currentTimer);
    saveTimers.current.set(noteId, window.setTimeout(() => {
      saveTimers.current.delete(noteId);
      touchSaveState();
      void flushNoteRef.current(noteId);
    }, delay));
    touchSaveState();
  }, [touchSaveState]);

  const flushNote = useCallback(async (noteId: string) => {
    const timer = saveTimers.current.get(noteId);
    if (timer) window.clearTimeout(timer);
    saveTimers.current.delete(noteId);
    touchSaveState();

    const existingWrite = inFlightPromises.current.get(noteId);
    if (existingWrite) {
      await existingWrite;
      return;
    }

    const pending = pendingPatches.current.get(noteId);
    if (!pending || Object.keys(pending.patch).length === 0) return;
    pendingPatches.current.delete(noteId);
    inFlightNotes.current.set(noteId, pending);
    touchSaveState();

    const operation = (async () => {
      let shouldContinue = true;
      let retryDelay = 250;
      try {
        await sync.updateNote(noteId, pending.patch, pending.expectedRevision);
        retryCounts.current.delete(noteId);
        acknowledgedRevisions.current.set(
          noteId,
          Math.max(
            acknowledgedRevisions.current.get(noteId) ?? 0,
            pending.expectedRevision + 1,
          ),
        );
        setNoteSaveError(noteId);
        setSaveConflicts((current) => {
          if (!current[noteId]) return current;
          const next = { ...current };
          delete next[noteId];
          return next;
        });

        const newer = pendingPatches.current.get(noteId);
        if (newer && newer.expectedRevision <= pending.expectedRevision) {
          pendingPatches.current.set(noteId, {
            ...newer,
            expectedRevision: pending.expectedRevision + 1,
          });
        }
      } catch (saveError) {
        const newer = pendingPatches.current.get(noteId);
        pendingPatches.current.set(noteId, {
          expectedRevision: pending.expectedRevision,
          patch: {
            ...pending.patch,
            ...newer?.patch,
          },
        });
        setNoteDrafts((current) => ({
          ...current,
          [noteId]: {
            ...pending.patch,
            ...current[noteId],
            ...newer?.patch,
          },
        }));

        if (isConflictError(saveError)) {
          const message = 'This note changed on another device. Choose which version to keep.';
          const currentRevision = typeof saveError === 'object'
            && saveError
            && 'currentRevision' in saveError
            && typeof saveError.currentRevision === 'number'
            ? saveError.currentRevision
            : undefined;
          setSaveConflicts((current) => ({
            ...current,
            [noteId]: { noteId, message, currentRevision },
          }));
          setNoteSaveError(noteId, message);
          shouldContinue = false;
        } else if (isTransientSaveError(saveError)) {
          const attempts = (retryCounts.current.get(noteId) ?? 0) + 1;
          retryCounts.current.set(noteId, attempts);
          retryDelay = Math.min(15_000, 900 * (2 ** Math.min(attempts - 1, 4)));
          shouldContinue = navigator.onLine;
        } else {
          setNoteSaveError(noteId, errorMessage(saveError));
          shouldContinue = false;
        }
      } finally {
        inFlightNotes.current.delete(noteId);
        inFlightPromises.current.delete(noteId);
        touchSaveState();
        if (pendingPatches.current.has(noteId) && !saveTimers.current.has(noteId) && shouldContinue) {
          scheduleFlush(noteId, retryDelay);
        }
      }
    })();

    inFlightPromises.current.set(noteId, operation);
    await operation;
  }, [scheduleFlush, setNoteSaveError, sync.updateNote, touchSaveState]);

  flushNoteRef.current = flushNote;

  const flushNoteForAction = useCallback(async (noteId: string) => {
    // A write that was already in flight can leave a newer patch queued while
    // flushNote waits for it. Drain that follow-up patch before changing the
    // note's Trash state so the action can never discard a recent edit.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await flushNote(noteId);
      if (saveErrors.current.has(noteId)) {
        throw new Error('This note still has an unsaved edit.');
      }
      if (
        !pendingPatches.current.has(noteId)
        && !saveTimers.current.has(noteId)
        && !inFlightNotes.current.has(noteId)
        && !inFlightPromises.current.has(noteId)
      ) return;
    }
    throw new Error('This note is still saving.');
  }, [flushNote]);

  const flushAllNotes = useCallback(async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const noteIds = new Set([
        ...pendingPatches.current.keys(),
        ...saveTimers.current.keys(),
        ...inFlightPromises.current.keys(),
      ]);
      if (noteIds.size === 0) return;
      await Promise.all(Array.from(noteIds, (noteId) => flushNote(noteId)));
      if (pendingPatches.current.size === 0 && inFlightPromises.current.size === 0) return;
    }
  }, [flushNote]);

  const queueNotePatch = useCallback((noteId: string, patch: Partial<NoteRecord>) => {
    setNoteDrafts((current) => ({
      ...current,
      [noteId]: {
        ...current[noteId],
        ...patch,
      },
    }));
    const existing = pendingPatches.current.get(noteId);
    const inFlight = inFlightNotes.current.get(noteId);
    const cloudRevision = Math.max(
      cloudNotesRef.current.find((note) => note.id === noteId)?.revision ?? 0,
      acknowledgedRevisions.current.get(noteId) ?? 0,
    );
    pendingPatches.current.set(noteId, {
      expectedRevision: existing?.expectedRevision
        ?? (inFlight ? inFlight.expectedRevision + 1 : cloudRevision),
      patch: {
        ...existing?.patch,
        ...patch,
      },
    });
    retryCounts.current.delete(noteId);
    setNoteSaveError(noteId);
    setSaveConflicts((current) => {
      if (!current[noteId]) return current;
      const next = { ...current };
      delete next[noteId];
      return next;
    });
    scheduleFlush(noteId, 350);
  }, [scheduleFlush, setNoteSaveError]);

  useEffect(() => {
    setNoteDrafts((current) => {
      let changed = false;
      const next = { ...current };
      Object.entries(current).forEach(([noteId, patch]) => {
        const cloudNote = cloudNotes.find((note) => note.id === noteId);
        const acknowledgedRevision = acknowledgedRevisions.current.get(noteId);
        if (
          cloudNote
          && !pendingPatches.current.has(noteId)
          && !saveTimers.current.has(noteId)
          && !inFlightNotes.current.has(noteId)
          && (
            acknowledgedRevision !== undefined
              ? cloudNote.revision >= acknowledgedRevision
              : patchMatches(cloudNote, patch)
          )
        ) {
          delete next[noteId];
          acknowledgedRevisions.current.delete(noteId);
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [cloudNotes, saveRevision]);

  useEffect(() => {
    if (!activeNote) {
      setLocalTitle('');
      return;
    }
    setLocalTitle(activeNote.title);
  }, [activeNote?.id]);

  useEffect(() => {
    if (
      !activeNote
      || pendingPatches.current.has(activeNote.id)
      || saveTimers.current.has(activeNote.id)
      || inFlightNotes.current.has(activeNote.id)
    ) return;
    setLocalTitle(activeNote.title);
  }, [activeNote?.title, activeNote?.id, saveRevision]);

  useEffect(() => {
    const title = titleRef.current;
    if (!title) return;
    title.style.height = 'auto';
    title.style.height = `${Math.min(title.scrollHeight, 172)}px`;
  }, [activeNote?.id, localTitle]);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
    const updateThemeColor = () => {
      const dark = settings.theme === 'dark' || (settings.theme === 'system' && colorScheme.matches);
      document.querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', dark ? '#171814' : '#f7f3ec');
    };
    updateThemeColor();
    if (settings.theme === 'system') colorScheme.addEventListener('change', updateThemeColor);
    return () => colorScheme.removeEventListener('change', updateThemeColor);
  }, [settings.theme]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (command && event.shiftKey && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        setQuickCaptureOpen(true);
      }
      if (command && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        void createNewNote();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  useEffect(() => {
    if (quickCaptureOpen) window.setTimeout(() => quickRef.current?.focus(), 40);
  }, [quickCaptureOpen]);

  useEffect(() => {
    const anyOpen = profileOpen
      || themeMenuOpen
      || folderMenuOpen
      || labelsOpen
      || listOptionsOpen
      || noteDetailsOpen;
    if (!anyOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (profileOpen && !profileWrapRef.current?.contains(target)) setProfileOpen(false);
      if (themeMenuOpen && !themeWrapRef.current?.contains(target)) setThemeMenuOpen(false);
      if (folderMenuOpen && !folderPickerRef.current?.contains(target)) setFolderMenuOpen(false);
      if (labelsOpen && !labelPickerRef.current?.contains(target)) setLabelsOpen(false);
      if (listOptionsOpen && !listOptionsRef.current?.contains(target)) setListOptionsOpen(false);
      if (noteDetailsOpen && !noteDetailsRef.current?.contains(target)) setNoteDetailsOpen(false);
    };
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setProfileOpen(false);
      setThemeMenuOpen(false);
      setFolderMenuOpen(false);
      setLabelsOpen(false);
      setListOptionsOpen(false);
      setNoteDetailsOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onEscape);
    };
  }, [folderMenuOpen, labelsOpen, listOptionsOpen, noteDetailsOpen, profileOpen, themeMenuOpen]);

  useEffect(() => {
    if (!isMobileLayout || !mobileNavOpen) return;
    const drawer = sidebarRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : mobileMenuButtonRef.current;
    window.setTimeout(() => {
      drawer?.querySelector<HTMLElement>('.mobile-close-button')?.focus();
    }, 0);

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMobileNavOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !drawer) return;
      const focusable = Array.from(drawer.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hidden && element.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1) ?? first;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, [isMobileLayout, mobileNavOpen]);

  useEffect(() => {
    const flushBeforeLeaving = () => { void flushAllNotes(); };
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') void flushAllNotes();
    };
    window.addEventListener('pagehide', flushBeforeLeaving);
    window.addEventListener('online', flushBeforeLeaving);
    document.addEventListener('visibilitychange', flushWhenHidden);
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      if (
        pendingPatches.current.size === 0
        && saveTimers.current.size === 0
        && inFlightNotes.current.size === 0
      ) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => {
      window.removeEventListener('pagehide', flushBeforeLeaving);
      window.removeEventListener('online', flushBeforeLeaving);
      document.removeEventListener('visibilitychange', flushWhenHidden);
      window.removeEventListener('beforeunload', warnBeforeLeaving);
      void flushAllNotes();
      saveTimers.current.forEach((pendingTimer) => window.clearTimeout(pendingTimer));
    };
  }, [flushAllNotes]);

  const chooseView = (nextView: ViewKey) => {
    if (activeNoteId) void flushNote(activeNoteId);
    setView(nextView);
    setMobileNavOpen(false);
    setMobilePane('notes');
    setActiveNoteId(undefined);
    setNoteDetailsOpen(false);
  };

  const selectNote = (noteId: string) => {
    if (activeNoteId && activeNoteId !== noteId) void flushNote(activeNoteId);
    setActiveNoteId(noteId);
    setMobilePane('editor');
    setNoteDetailsOpen(false);
  };

  async function createNewNote() {
    if (creating) return;
    if (sync.syncStatus === 'offline' || !navigator.onLine) {
      showToast('Reconnect before creating a note — offline drafts are intentionally not stored here');
      return;
    }
    setCreating(true);
    try {
      const folderId = view.startsWith('folder:') ? view.slice(7) : 'inbox';
      // Trash can never list a live note, so a new note leaves that view with it.
      if (view === 'trash') setView('inbox');
      const id = await sync.createNote({
        title: 'Untitled note',
        content: '',
        contentText: '',
        format: 'rich',
        folderId,
        labels: [],
        pinned: false,
      });
      setActiveNoteId(id);
      setMobilePane('editor');
    } catch {
      showToast('Could not create the note');
    } finally {
      setCreating(false);
    }
  }

  const submitQuickCapture = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = quickText.trim();
    if (!text || creating) return;
    if (sync.syncStatus === 'offline' || !navigator.onLine) {
      showToast('Reconnect to capture this note safely');
      return;
    }
    setCreating(true);
    try {
      const rich = plainTextToRichContent(text, settings.smartFormatting);
      const id = await sync.createNote({
        title: noteTitleFromText(text),
        content: rich.content,
        contentText: rich.contentText,
        format: 'rich',
        folderId: 'inbox',
        labels: [],
        pinned: false,
      });
      setQuickText('');
      setQuickCaptureOpen(false);
      setView('inbox');
      setActiveNoteId(id);
      setMobilePane('editor');
      showToast('Captured and syncing');
    } catch {
      showToast('Could not capture that note');
    } finally {
      setCreating(false);
    }
  };

  const submitFolder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = newFolderName.trim();
    if (!name) return;
    try {
      const id = await sync.createFolder(name);
      setNewFolderName('');
      setNewFolderOpen(false);
      chooseView(`folder:${id}`);
    } catch {
      showToast('Could not create that folder');
    }
  };

  const copyNote = async (note: NoteRecord) => {
    const body = note.format === 'rich' ? richContentToPlainText(note.content) : note.content;
    const value = [note.title, body].filter(Boolean).join('\n\n');
    try {
      await navigator.clipboard.writeText(value);
      showToast('Copied to clipboard');
    } catch {
      showToast('Clipboard permission is blocked');
    }
  };

  // Trash and restore are discrete actions, so they need the freshest revision
  // the client knows about rather than whatever the row was rendered from.
  const freshestRevision = useCallback((noteId: string, fallback: number) => Math.max(
    cloudNotesRef.current.find((note) => note.id === noteId)?.revision ?? fallback,
    acknowledgedRevisions.current.get(noteId) ?? 0,
  ), []);

  const forgetDraft = useCallback((noteId: string) => {
    const timer = saveTimers.current.get(noteId);
    if (timer) window.clearTimeout(timer);
    saveTimers.current.delete(noteId);
    pendingPatches.current.delete(noteId);
    acknowledgedRevisions.current.delete(noteId);
    setNoteDrafts((current) => {
      if (!current[noteId]) return current;
      const next = { ...current };
      delete next[noteId];
      return next;
    });
  }, []);

  const setTrashed = useCallback(async (note: NoteRecord, trashed: boolean) => {
    try {
      await flushNoteForAction(note.id);
      const revision = await sync.setNoteTrashed(
        note.id,
        trashed,
        freshestRevision(note.id, note.revision),
      );
      forgetDraft(note.id);
      // The transaction can finish before its listener snapshot is rendered.
      // Keep the committed revision so an immediate Undo never looks stale.
      acknowledgedRevisions.current.set(note.id, revision);
      return true;
    } catch (trashError) {
      showToast(saveErrors.current.has(note.id)
        ? 'This note has an unsaved edit. Resolve it before changing its Trash state.'
        : isConflictError(trashError)
          ? 'This note changed on another device. Reopen it and try again.'
          : trashed ? 'Could not move that note to Trash' : 'Could not restore that note');
      return false;
    }
  }, [flushNoteForAction, forgetDraft, freshestRevision, showToast, sync.setNoteTrashed]);

  const trashNote = useCallback(async (note: NoteRecord) => {
    const title = note.title || 'Untitled note';
    if (!await setTrashed(note, true)) return;
    setActiveNoteId((current) => (current === note.id ? undefined : current));
    setNoteDetailsOpen(false);
    if (isMobileLayout) setMobilePane('notes');
    showToast(`“${title}” moved to Trash`, {
      actionLabel: 'Undo',
      onAction: () => { void setTrashed(note, false); },
    });
  }, [isMobileLayout, setTrashed, showToast]);

  const restoreNote = useCallback(async (note: NoteRecord) => {
    if (!await setTrashed(note, false)) return;
    if (activeNoteId === note.id) {
      setActiveNoteId(undefined);
      if (isMobileLayout) setMobilePane('notes');
    }
    setNoteDetailsOpen(false);
    showToast(`“${note.title || 'Untitled note'}” restored`);
  }, [activeNoteId, isMobileLayout, setTrashed, showToast]);

  const requestPermanentDelete = useCallback((note: NoteRecord) => {
    if (note.deleted !== true) return;
    setPermanentDeleteError(undefined);
    setDeleteCandidate(note);
  }, []);

  const closePermanentDelete = useCallback(() => {
    if (permanentlyDeletingNoteId) return;
    setPermanentDeleteError(undefined);
    setDeleteCandidate(undefined);
  }, [permanentlyDeletingNoteId]);

  const confirmPermanentDelete = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const candidate = deleteCandidate;
    if (!candidate || permanentlyDeletingNoteId) return;

    setPermanentDeleteError(undefined);
    setPermanentlyDeletingNoteId(candidate.id);
    try {
      await flushNoteForAction(candidate.id);
      await sync.permanentlyDeleteNote(
        candidate.id,
        freshestRevision(candidate.id, candidate.revision),
      );
      forgetDraft(candidate.id);
      setActiveNoteId((current) => (current === candidate.id ? undefined : current));
      setNoteDetailsOpen(false);
      if (isMobileLayout) setMobilePane('notes');
      setDeleteCandidate(undefined);
      showToast(`“${candidate.title || 'Untitled note'}” permanently deleted`);
    } catch (deleteError) {
      setPermanentDeleteError(saveErrors.current.has(candidate.id)
        ? 'This note has an unsaved edit. Resolve it before permanently deleting the note.'
        : isConflictError(deleteError)
          ? 'This note changed on another device. Close this dialog, reopen it, and try again.'
          : 'Could not permanently delete this note. Check your connection and try again.');
    } finally {
      setPermanentlyDeletingNoteId(undefined);
    }
  };

  const saveEditorChange = (change: EditorChange) => {
    if (!activeNote) return;
    queueNotePatch(activeNote.id, {
      content: change.content,
      contentText: change.contentText,
      format: change.format,
    });
  };

  const saveEditorFormat = (change: EditorChange) => {
    if (!activeNote) return;
    const patch: Partial<NoteRecord> = {
      content: change.content,
      contentText: change.contentText,
      format: change.format,
    };
    if (change.richBackup !== undefined) patch.richBackup = change.richBackup;
    queueNotePatch(activeNote.id, patch);
    showToast(change.format === 'plain' ? 'Plain text mode' : 'Rich text mode');
  };

  const addLabel = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeNote) return;
    const normalized = labelDraft.trim().replace(/\s+/g, ' ').slice(0, 48);
    if (!normalized) return;
    const nextLabels = Array.from(new Set([...activeNote.labels, normalized])).slice(0, 12);
    queueNotePatch(activeNote.id, { labels: nextLabels });
    setLabelDraft('');
    setLabelsOpen(false);
  };

  const removeLabel = (label: string) => {
    if (!activeNote) return;
    queueNotePatch(activeNote.id, {
      labels: activeNote.labels.filter((candidate) => candidate !== label),
    });
  };

  const setThemePreference = (next: ThemePreference) => {
    setThemeMenuOpen(false);
    void sync.updateSettings({ theme: next }).catch(() => {
      showToast('Could not save the theme');
    });
    showToast(`${next[0].toUpperCase()}${next.slice(1)} theme`);
  };

  const cycleTheme = () => {
    const themes: ThemePreference[] = ['system', 'light', 'dark'];
    setThemePreference(themes[(themes.indexOf(settings.theme) + 1) % themes.length]);
  };

  const retrySaving = async () => {
    saveErrors.current.clear();
    setLocalSaveError(undefined);
    setSaveConflicts({});
    sync.retrySync();
    await flushAllNotes();
  };

  const keepLocalConflict = async () => {
    if (!saveConflict) return;
    const pending = pendingPatches.current.get(saveConflict.noteId);
    const cloudRevision = saveConflict.currentRevision
      ?? cloudNotesRef.current.find((note) => note.id === saveConflict.noteId)?.revision;
    if (!pending || cloudRevision === undefined) return;
    pendingPatches.current.set(saveConflict.noteId, {
      ...pending,
      expectedRevision: cloudRevision,
    });
    setNoteSaveError(saveConflict.noteId);
    setSaveConflicts((current) => {
      const next = { ...current };
      delete next[saveConflict.noteId];
      return next;
    });
    touchSaveState();
    await flushNote(saveConflict.noteId);
  };

  const reloadCloudConflict = () => {
    if (!saveConflict) return;
    const noteId = saveConflict.noteId;
    const timer = saveTimers.current.get(noteId);
    if (timer) window.clearTimeout(timer);
    saveTimers.current.delete(noteId);
    pendingPatches.current.delete(noteId);
    acknowledgedRevisions.current.delete(noteId);
    setNoteDrafts((current) => {
      const next = { ...current };
      delete next[noteId];
      return next;
    });
    setNoteSaveError(noteId);
    setSaveConflicts((current) => {
      const next = { ...current };
      delete next[noteId];
      return next;
    });
    touchSaveState();
    showToast('Loaded the version from your other device');
  };

  const signOut = async () => {
    try {
      await flushAllNotes();
      if (pendingPatches.current.size || saveTimers.current.size || inFlightNotes.current.size) {
        setLocalSaveError('Finish saving or resolve the note conflict before signing out.');
        return;
      }
      await sync.signOut();
    } catch {
      showToast('Could not sign out yet');
    }
  };

  void saveRevision;
  const hasLocalSaves = pendingPatches.current.size > 0
    || saveTimers.current.size > 0
    || inFlightNotes.current.size > 0;
  const effectiveSyncStatus = sync.syncStatus === 'offline'
    ? 'offline'
    : localSaveError
      ? 'error'
      : hasLocalSaves
        ? 'syncing'
        : sync.syncStatus;
  const visibleSyncError = saveConflict?.message ?? localSaveError ?? sync.error;
  const offline = effectiveSyncStatus === 'offline';

  const authLoading = sync.authStatus === 'loading';
  if (sync.authStatus !== 'signed-in' || !sync.user) {
    return (
      <AuthScreen
        loading={authLoading}
        error={sync.error}
        onSignIn={sync.signIn}
      />
    );
  }

  return (
    <main className={`app-shell mobile-pane-${mobilePane} ${mobileNavOpen ? 'mobile-nav-open' : ''} ${keyboardCovered && !mobileNavOpen ? 'keyboard-open' : ''}`}>
      <aside
        ref={sidebarRef}
        className="sidebar"
        aria-label="Notes navigation"
        aria-hidden={isMobileLayout && !mobileNavOpen ? 'true' : undefined}
        inert={isMobileLayout && !mobileNavOpen}
      >
        <div className="sidebar-brand-row">
          <button className="mobile-close-button" type="button" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation">
            <X aria-hidden="true" />
          </button>
          <span className="wordmark">Notes</span>
          <button className="compose-button" type="button" onClick={() => void createNewNote()} aria-label="Create a new note" title="New note (⌘N)">
            <NotePencil aria-hidden="true" />
          </button>
        </div>

        <nav className="sidebar-scroll">
          <div className="nav-group main-nav">
            <NavButton active={view === 'inbox'} count={counts.inbox} icon={<Tray aria-hidden="true" />} label="Inbox" onClick={() => chooseView('inbox')} />
            <NavButton active={view === 'all'} count={notes.length} icon={<Notepad aria-hidden="true" />} label="All notes" onClick={() => chooseView('all')} />
            <NavButton active={view === 'pinned'} count={counts.pinned} icon={<PushPin aria-hidden="true" />} label="Pinned" onClick={() => chooseView('pinned')} />
            <NavButton active={view === 'trash'} count={counts.trash} icon={<Trash aria-hidden="true" />} label="Trash" onClick={() => chooseView('trash')} />
          </div>

          <div className="nav-divider" />
          <div className="nav-section-heading">
            <span>Folders</span>
            <button type="button" onClick={() => setNewFolderOpen(true)} aria-label="New folder" title="New folder"><Plus aria-hidden="true" /></button>
          </div>
          <div className="nav-group folder-nav">
            {folders.map((folder) => (
              <NavButton
                key={folder.id}
                active={view === `folder:${folder.id}`}
                count={notes.filter((note) => note.folderId === folder.id).length}
                icon={<Folder className={`tone-${folder.color}`} aria-hidden="true" />}
                label={folder.name}
                onClick={() => chooseView(`folder:${folder.id}`)}
              />
            ))}
            {folders.length === 0 && <p className="nav-empty">Your folders appear here.</p>}
          </div>

          <div className="nav-divider" />
          <div className="nav-section-heading"><span>Labels</span></div>
          <div className="nav-group label-nav">
            {labels.map((label) => (
              <button
                key={label.name}
                type="button"
                className={`label-nav-row ${view === `label:${label.name}` ? 'is-active' : ''}`}
                onClick={() => chooseView(`label:${label.name}`)}
              >
                <span className={`label-dot tone-${labelColor(label.name)}`} />
                <span>{label.name}</span>
                <small>{label.count}</small>
              </button>
            ))}
            {labels.length === 0 && <p className="nav-empty">Labels organize notes across folders.</p>}
          </div>
        </nav>

        <button className="quick-capture-button" type="button" onClick={() => setQuickCaptureOpen(true)}>
          <span className="quick-capture-icon"><Lightning weight="fill" aria-hidden="true" /></span>
          <span><strong>Quick capture</strong><small>Paste or type instantly</small></span>
          <kbd>⌘⇧C</kbd>
        </button>
      </aside>

      <header className="topbar" aria-hidden={isMobileLayout && mobileNavOpen ? 'true' : undefined} inert={isMobileLayout && mobileNavOpen}>
        <button ref={mobileMenuButtonRef} className="mobile-menu-button" type="button" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation">
          <SidebarSimple aria-hidden="true" />
        </button>
        <label className="search-field">
          <MagnifyingGlass aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            value={search}
            onFocus={() => setMobilePane('notes')}
            onChange={(event) => {
              setSearch(event.target.value);
              setMobilePane('notes');
            }}
            placeholder="Search notes…"
            aria-label="Search notes"
          />
          {search ? (
            <button type="button" onClick={() => setSearch('')} aria-label="Clear search"><X aria-hidden="true" /></button>
          ) : <kbd>⌘K</kbd>}
        </label>

        <button className="topbar-capture-button" type="button" onClick={() => setQuickCaptureOpen(true)}>
          <Lightning weight="fill" aria-hidden="true" />
          <span>Quick capture</span>
        </button>

        <button
          className={`sync-pill sync-${effectiveSyncStatus}`}
          type="button"
          title={visibleSyncError || syncLabel(effectiveSyncStatus, sync.lastSyncedAt)}
          aria-label={visibleSyncError ? `${visibleSyncError} Retry syncing.` : syncLabel(effectiveSyncStatus, sync.lastSyncedAt)}
          onClick={() => {
            if (visibleSyncError) void retrySaving();
          }}
        >
          <SyncIcon status={effectiveSyncStatus} />
          <span>{syncLabel(effectiveSyncStatus, sync.lastSyncedAt)}</span>
        </button>
        <span className="topbar-divider" />
        <div className="theme-wrap" ref={themeWrapRef}>
          <button
            className="icon-button theme-button"
            type="button"
            onClick={() => setThemeMenuOpen((open) => !open)}
            aria-label={`Theme: ${settings.theme}. Choose theme.`}
            aria-haspopup="dialog"
            aria-expanded={themeMenuOpen}
            aria-controls="theme-menu"
            title={`Theme: ${settings.theme}`}
          >
            <ThemeIcon theme={settings.theme} />
          </button>
          {themeMenuOpen && (
            <div className="theme-menu popover" id="theme-menu" role="dialog" aria-label="Choose theme">
              {(['system', 'light', 'dark'] as ThemePreference[]).map((theme) => (
                <button key={theme} type="button" onClick={() => setThemePreference(theme)}>
                  <ThemeIcon theme={theme} />
                  <span>{theme[0].toUpperCase()}{theme.slice(1)}</span>
                  {settings.theme === theme && <Check aria-hidden="true" />}
                </button>
              ))}
            </div>
          )}
        </div>
        <span className="topbar-divider" />
        <div className="profile-wrap" ref={profileWrapRef}>
          <button className="profile-button" type="button" onClick={() => setProfileOpen((open) => !open)} aria-haspopup="dialog" aria-controls="profile-menu" aria-expanded={profileOpen}>
            <span>{initials(sync.user)}</span><CaretDown aria-hidden="true" />
          </button>
          {profileOpen && (
            <div className="profile-menu popover" id="profile-menu" role="dialog" aria-label="Account">
              <div className="profile-summary">
                <span className="profile-avatar-large">{initials(sync.user)}</span>
                <span><strong>{sync.user.displayName || 'Harsh'}</strong><small>{sync.user.email}</small></span>
              </div>
              <div className="popover-divider" />
              <button type="button" onClick={() => void signOut()}><SignOut aria-hidden="true" />Sign out</button>
            </div>
          )}
        </div>
      </header>

      {visibleSyncError && (
        <div className="sync-error-banner" role="alert" aria-hidden={isMobileLayout && mobileNavOpen ? 'true' : undefined} inert={isMobileLayout && mobileNavOpen}>
          <WarningCircle aria-hidden="true" />
          <span>{visibleSyncError}</span>
          <div className="sync-error-actions">
            {saveConflict ? (
              <>
              <button type="button" onClick={() => void keepLocalConflict()}>Keep this version</button>
              <button type="button" onClick={reloadCloudConflict}>Load cloud version</button>
              </>
            ) : (
              <button type="button" onClick={() => void retrySaving()}>Retry</button>
            )}
          </div>
        </div>
      )}

      <section
        className="note-list-panel"
        aria-label={`${search ? 'Search results' : viewTitle(view, folders)} notes`}
        aria-hidden={isMobileLayout && (mobileNavOpen || mobilePane === 'editor') ? 'true' : undefined}
        inert={isMobileLayout && (mobileNavOpen || mobilePane === 'editor')}
      >
        <header className="note-list-header">
          <div>
            <button className="mobile-list-back" type="button" onClick={() => setMobileNavOpen(true)}><SidebarSimple aria-hidden="true" /></button>
            <h2>{search ? 'Search results' : viewTitle(view, folders)}</h2>
            <span>{visibleNotes.length}</span>
          </div>
          <div className="list-options-wrap" ref={listOptionsRef}>
            <button
              className="sort-button"
              type="button"
              aria-haspopup="dialog"
              aria-controls="list-options"
              aria-expanded={listOptionsOpen}
              onClick={() => setListOptionsOpen((open) => !open)}
              title="Pinned notes first; choose sort and format filter"
            >
              {noteSort === 'recent' ? 'Pinned + newest' : noteSort === 'oldest' ? 'Pinned + oldest' : 'Pinned + title'} <CaretDown aria-hidden="true" />
            </button>
            <button
              className="filter-icon"
              type="button"
              title="Sort and filter notes"
              aria-label="Sort and filter notes"
              aria-haspopup="dialog"
              aria-controls="list-options"
              aria-expanded={listOptionsOpen}
              onClick={() => setListOptionsOpen((open) => !open)}
            ><FunnelSimple aria-hidden="true" /></button>
            {listOptionsOpen && (
              <div className="list-options popover" id="list-options" role="dialog" aria-label="Sort and filter notes">
                <fieldset>
                  <legend>Sort</legend>
                  {([
                    ['recent', 'Newest first'],
                    ['oldest', 'Oldest first'],
                    ['title', 'Title A–Z'],
                  ] as const).map(([value, label]) => (
                    <button key={value} type="button" onClick={() => setNoteSort(value)} aria-pressed={noteSort === value}>
                      <span>{label}</span>{noteSort === value && <Check aria-hidden="true" />}
                    </button>
                  ))}
                </fieldset>
                <fieldset>
                  <legend>Format</legend>
                  {([
                    ['all', 'All notes'],
                    ['rich', 'Rich text'],
                    ['plain', 'Plain text'],
                  ] as const).map(([value, label]) => (
                    <button key={value} type="button" onClick={() => setFormatFilter(value)} aria-pressed={formatFilter === value}>
                      <span>{label}</span>{formatFilter === value && <Check aria-hidden="true" />}
                    </button>
                  ))}
                </fieldset>
                {(noteSort !== 'recent' || formatFilter !== 'all') && (
                  <button className="list-options-reset" type="button" onClick={() => {
                    setNoteSort('recent');
                    setFormatFilter('all');
                  }}>Reset</button>
                )}
              </div>
            )}
          </div>
        </header>

        <div className="note-list" role="list">
          {visibleNotes.map((note) => (
            <SwipeableNoteRow
              key={note.id}
              note={note}
              folderName={folders.find((folder) => folder.id === note.folderId)?.name
                || (note.folderId === 'inbox' ? 'Inbox' : 'Unfiled')}
              selected={note.id === activeNoteId}
              canSwipeToTrash={view !== 'trash' && note.deleted !== true}
              permanentlyDeleting={permanentlyDeletingNoteId === note.id}
              onSelect={() => selectNote(note.id)}
              onCopy={() => void copyNote(note)}
              onTrash={() => trashNote(note)}
              onRestore={() => restoreNote(note)}
              onDeleteRequest={() => requestPermanentDelete(note)}
            />
          ))}

          {visibleNotes.length === 0 && (
            view === 'trash' && !search ? (
              <div className="empty-list">
                <span><Trash aria-hidden="true" /></span>
                <h3>Trash is empty</h3>
                <p>Notes stay here until you restore them or permanently delete them.</p>
              </div>
            ) : (
              <div className="empty-list">
                <span><ListBullets aria-hidden="true" /></span>
                <h3>{search ? 'No notes match that search' : 'A clear desk, for now'}</h3>
                <p>{search ? 'Try a different word, folder, or label.' : 'Capture a thought and it will appear here on every signed-in device.'}</p>
                {!search && <button type="button" onClick={() => setQuickCaptureOpen(true)}>Quick capture</button>}
              </div>
            )
          )}
        </div>

        {view !== 'trash' && (
          <button className="mobile-new-note" type="button" onClick={() => void createNewNote()}><Plus aria-hidden="true" /> New note</button>
        )}
      </section>

      <section
        className="editor-panel"
        aria-label="Note editor"
        aria-hidden={isMobileLayout && (mobileNavOpen || mobilePane === 'notes') ? 'true' : undefined}
        inert={isMobileLayout && (mobileNavOpen || mobilePane === 'notes')}
      >
        {activeNote ? (
          <>
            <header className="editor-meta-bar">
              <div className="editor-meta-left">
                <button className="editor-back-button" type="button" onClick={() => {
                  void flushNote(activeNote.id);
                  setMobilePane('notes');
                }} aria-label="Back to note list"><ArrowLeft aria-hidden="true" /></button>
                <span>{displayDate(activeNote.updatedAt)}</span>
                <span className="meta-dot">•</span>
                <div className="folder-picker-wrap" ref={folderPickerRef}>
                  <button className="meta-link" type="button" onClick={() => setFolderMenuOpen((open) => !open)} aria-haspopup="dialog" aria-controls="folder-menu" aria-expanded={folderMenuOpen}>
                    {folders.find((folder) => folder.id === activeNote.folderId)?.name || 'Inbox'} <CaretDown aria-hidden="true" />
                  </button>
                  {folderMenuOpen && (
                    <div className="folder-menu popover" id="folder-menu" role="dialog" aria-label="Move note to folder">
                      <button type="button" onClick={() => {
                        queueNotePatch(activeNote.id, { folderId: 'inbox' });
                        setFolderMenuOpen(false);
                      }}><Tray aria-hidden="true" />Inbox{activeNote.folderId === 'inbox' && <Check />}</button>
                      {folders.map((folder) => (
                        <button key={folder.id} type="button" onClick={() => {
                          queueNotePatch(activeNote.id, { folderId: folder.id });
                          setFolderMenuOpen(false);
                        }}><Folder className={`tone-${folder.color}`} aria-hidden="true" />{folder.name}{activeNote.folderId === folder.id && <Check />}</button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="editor-actions">
                <button className="copy-note-button" type="button" onClick={() => void copyNote(activeNote)}><Copy aria-hidden="true" /><span>Copy note</span></button>
                <button className={`icon-button ${activeNote.pinned ? 'is-active' : ''}`} type="button" onClick={() => queueNotePatch(activeNote.id, { pinned: !activeNote.pinned })} aria-label={activeNote.pinned ? 'Unpin note' : 'Pin note'} title={activeNote.pinned ? 'Unpin note' : 'Pin note'}>
                  <PushPin weight={activeNote.pinned ? 'fill' : 'regular'} aria-hidden="true" />
                </button>
                <div className="note-details-wrap" ref={noteDetailsRef}>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label="Note details"
                    title="Note details"
                    aria-haspopup="dialog"
                    aria-expanded={noteDetailsOpen}
                    aria-controls="note-details"
                    onClick={() => setNoteDetailsOpen((open) => !open)}
                  ><DotsThree weight="bold" aria-hidden="true" /></button>
                  {noteDetailsOpen && (
                    <div className="note-details popover" id="note-details" role="dialog" aria-label="Note details">
                      <p><span>Format</span><strong>{activeNote.format === 'rich' ? 'Rich text' : 'Plain text'}</strong></p>
                      <p><span>Created</span><strong>{displayDate(activeNote.createdAt)}</strong></p>
                      <p><span>Updated</span><strong>{displayDate(activeNote.updatedAt)}</strong></p>
                      <p><span>Characters</span><strong>{activeNote.contentText.length.toLocaleString()}</strong></p>
                      <div className="popover-divider" />
                      {activeNoteTrashed ? (
                        <button className="note-details-action" type="button" onClick={() => void restoreNote(activeNote)}>
                          <ArrowCounterClockwise aria-hidden="true" />Restore note
                        </button>
                      ) : (
                        <button className="note-details-action is-danger" type="button" onClick={() => void trashNote(activeNote)}>
                          <Trash aria-hidden="true" />Move to Trash
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </header>

            {activeNoteTrashed && (
              <div className="trash-banner" role="status">
                <Trash aria-hidden="true" />
                <span>This note is in Trash. It stays out of your views until you restore it.</span>
                <button type="button" onClick={() => void restoreNote(activeNote)}>
                  <ArrowCounterClockwise aria-hidden="true" />Restore
                </button>
              </div>
            )}

            <div className="editor-label-row">
              {activeNote.labels.map((label) => (
                <span key={label} className={`editor-label tone-${labelColor(label)}`}>
                  <span>{label}</span>
                  <button type="button" onClick={() => removeLabel(label)} aria-label={`Remove ${label} label`}><X aria-hidden="true" /></button>
                </span>
              ))}
              <div className="label-picker-wrap" ref={labelPickerRef}>
                <button className="add-label-button" type="button" onClick={() => setLabelsOpen((open) => !open)} aria-haspopup="dialog" aria-controls="label-picker" aria-expanded={labelsOpen}><Tag aria-hidden="true" />{activeNote.labels.length ? 'Add label' : 'Label'}</button>
                {labelsOpen && (
                  <form className="label-popover popover" id="label-picker" role="dialog" aria-label="Add a label" onSubmit={addLabel}>
                    <label htmlFor="label-name">Add a label</label>
                    <input id="label-name" value={labelDraft} onChange={(event) => setLabelDraft(event.target.value)} maxLength={48} placeholder="e.g. Planning" autoFocus />
                    {labels
                      .filter((label) => !activeNote.labels.includes(label.name))
                      .filter((label) => !labelDraft.trim() || label.name.toLowerCase().includes(labelDraft.trim().toLowerCase()))
                      .slice(0, 10)
                      .map((label) => (
                      <button key={label.name} type="button" onClick={() => {
                        queueNotePatch(activeNote.id, { labels: [...activeNote.labels, label.name].slice(0, 12) });
                        setLabelsOpen(false);
                      }}><span className={`label-dot tone-${labelColor(label.name)}`} />{label.name}</button>
                      ))}
                    <button className="label-create" type="submit" disabled={!labelDraft.trim()}><Plus aria-hidden="true" />Create label</button>
                  </form>
                )}
              </div>
            </div>

            <div className="editor-scroll">
              <ErrorBoundary
                key={activeNote.id}
                fallback={(reset) => (
                  <div className="empty-editor editor-error" role="alert">
                    <span className="empty-editor-icon"><WarningCircle aria-hidden="true" /></span>
                    <p className="eyebrow">Editor hiccup</p>
                    <h2>This note hit a snag.</h2>
                    <p>Your writing is safe and still synced. Reload the editor to keep going.</p>
                    <div>
                      <button className="primary-button" type="button" onClick={reset}>
                        <ArrowCounterClockwise aria-hidden="true" />Reload editor
                      </button>
                    </div>
                  </div>
                )}
              >
                <Suspense fallback={<div className="editor-loading" role="status">Preparing the writing tools…</div>}>
                  <RichTextEditor
                    key={activeNote.id}
                    noteId={activeNote.id}
                    format={activeNote.format}
                    content={activeNote.content}
                    richBackup={activeNote.richBackup}
                    titleSlot={(
                      <textarea
                        ref={titleRef}
                        className="note-title-input"
                        rows={1}
                        value={localTitle}
                        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
                          const value = event.target.value.replace(/\r?\n/g, ' ').slice(0, 240);
                          setLocalTitle(value);
                          queueNotePatch(activeNote.id, { title: value || 'Untitled note' });
                        }}
                        onBlur={() => void flushNote(activeNote.id)}
                        aria-label="Note title"
                        placeholder="Untitled note"
                      />
                    )}
                    footerSlot={(
                      <footer className="editor-footer">
                        <span>{activeNote.contentText.trim() ? `${activeNote.contentText.trim().split(/\s+/).length} words` : '0 words'}</span>
                        <span className={`inline-sync sync-${effectiveSyncStatus}`}><SyncIcon status={effectiveSyncStatus} />{syncLabel(effectiveSyncStatus, sync.lastSyncedAt)}</span>
                      </footer>
                    )}
                    smartFormatting={settings.smartFormatting}
                    onSmartFormattingChange={(enabled) => {
                      void sync.updateSettings({ smartFormatting: enabled }).catch(() => {
                        showToast('Could not save smart formatting yet');
                      });
                    }}
                    onChange={saveEditorChange}
                    onFormatChange={saveEditorFormat}
                    onBlur={() => void flushNote(activeNote.id)}
                  />
                </Suspense>
              </ErrorBoundary>
            </div>
          </>
        ) : (
          <div className="empty-editor">
            <span className="empty-editor-icon"><NotePencil aria-hidden="true" /></span>
            <p className="eyebrow">Your writing space</p>
            <h2>Choose a note,<br />or begin a new one.</h2>
            <p>Rich text is ready when you want structure. Plain text is always one switch away.</p>
            <div>
              <button className="primary-button" type="button" onClick={() => void createNewNote()}><NotePencil aria-hidden="true" />New note</button>
              <button className="secondary-button" type="button" onClick={() => setQuickCaptureOpen(true)}><Lightning aria-hidden="true" />Quick capture</button>
            </div>
          </div>
        )}
      </section>

      <nav className="mobile-bottom-nav" aria-label="Mobile navigation" aria-hidden={isMobileLayout && mobileNavOpen ? 'true' : undefined} inert={isMobileLayout && mobileNavOpen}>
        <button className={mobilePane === 'notes' ? 'is-active' : ''} type="button" onClick={() => setMobilePane('notes')}><Notepad aria-hidden="true" /><span>Notes</span></button>
        <button type="button" onClick={() => setMobileNavOpen(true)}><Folder aria-hidden="true" /><span>Folders</span></button>
        <button className="mobile-capture" type="button" onClick={() => setQuickCaptureOpen(true)}><Plus aria-hidden="true" /><span>Capture</span></button>
        <button type="button" onClick={cycleTheme}><ThemeIcon theme={settings.theme} /><span>Theme</span></button>
      </nav>

      {mobileNavOpen && <button className="mobile-nav-scrim" type="button" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation" />}

      {quickCaptureOpen && (
        <ModalShell label="Quick capture" onClose={() => setQuickCaptureOpen(false)}>
          <form className="quick-capture-modal" onSubmit={submitQuickCapture}>
            <header>
              <span className="modal-icon"><Lightning weight="fill" aria-hidden="true" /></span>
              <div><p className="eyebrow">Quick capture</p><h2>Drop it here.</h2></div>
              <button className="modal-close" type="button" onClick={() => setQuickCaptureOpen(false)} aria-label="Close"><X aria-hidden="true" /></button>
            </header>
            <p>Capture it now and shape it later. Smart formatting carries the structure to every signed-in device.</p>
            <div className="quick-capture-hints" aria-label="Supported smart formatting">
              <span># Heading</span><span>- [ ] Task</span><span>| Table |</span><span>``` Code</span>
            </div>
            <textarea
              ref={quickRef}
              value={quickText}
              onChange={(event) => setQuickText(event.target.value)}
              placeholder={'Paste or type anything…\n\nUse # headings, - lists, - [ ] checklists, > quotes, | tables |, or ``` code and smart formatting will take care of the rest.'}
              rows={10}
            />
            <footer>
              <span><span className={`status-dot sync-${effectiveSyncStatus}`} />{offline ? 'Reconnect to save safely' : 'Saves to Inbox'}</span>
              <button className="primary-button" type="submit" disabled={!quickText.trim() || creating || offline}>{creating ? 'Capturing…' : offline ? 'Reconnect to capture' : 'Capture note'}</button>
            </footer>
          </form>
        </ModalShell>
      )}

      {newFolderOpen && (
        <ModalShell label="New folder" onClose={() => setNewFolderOpen(false)}>
          <form className="folder-modal" onSubmit={submitFolder}>
            <header><span className="modal-icon"><Folder aria-hidden="true" /></span><div><p className="eyebrow">Organization</p><h2>New folder</h2></div><button className="modal-close" type="button" onClick={() => setNewFolderOpen(false)} aria-label="Close"><X /></button></header>
            <label htmlFor="folder-name">Folder name</label>
            <input id="folder-name" value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} maxLength={80} placeholder="e.g. Travel" autoFocus />
            <div className="folder-color-preview" aria-label="Folder color preview">
              {FOLDER_COLORS.map((color) => <span key={color} className={`tone-${color}`} />)}
            </div>
            <footer><button className="secondary-button" type="button" onClick={() => setNewFolderOpen(false)}>Cancel</button><button className="primary-button" type="submit" disabled={!newFolderName.trim()}>Create folder</button></footer>
          </form>
        </ModalShell>
      )}

      {deleteCandidate && (
        <ModalShell label="Permanently delete note" onClose={closePermanentDelete}>
          <form
            className="permanent-delete-modal"
            aria-describedby="permanent-delete-description"
            onSubmit={confirmPermanentDelete}
          >
            <header>
              <span className="modal-icon is-danger"><Trash aria-hidden="true" /></span>
              <div><p className="eyebrow">Trash</p><h2>Delete forever?</h2></div>
              <button
                className="modal-close"
                type="button"
                onClick={closePermanentDelete}
                aria-label="Close"
                disabled={Boolean(permanentlyDeletingNoteId)}
              ><X aria-hidden="true" /></button>
            </header>
            <p id="permanent-delete-description">
              <strong>“{deleteCandidate.title || 'Untitled note'}”</strong> will be permanently
              removed from Firebase. This cannot be undone.
            </p>
            {permanentDeleteError && <p className="permanent-delete-error" role="alert">{permanentDeleteError}</p>}
            <footer>
              <button
                className="secondary-button"
                type="button"
                onClick={closePermanentDelete}
                disabled={Boolean(permanentlyDeletingNoteId)}
                autoFocus
              >Cancel</button>
              <button className="danger-button" type="submit" disabled={Boolean(permanentlyDeletingNoteId)}>
                {permanentlyDeletingNoteId ? 'Deleting…' : 'Delete permanently'}
              </button>
            </footer>
          </form>
        </ModalShell>
      )}

      {toast && (
        <div className="toast" role="status">
          <Check aria-hidden="true" />
          <span>{toast.message}</span>
          {toast.onAction && toast.actionLabel && (
            <button className="toast-action" type="button" onClick={() => {
              toast.onAction?.();
              setToast(undefined);
            }}>{toast.actionLabel}</button>
          )}
        </div>
      )}
    </main>
  );
}
