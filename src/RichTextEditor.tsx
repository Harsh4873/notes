import { ArrowClockwise } from '@phosphor-icons/react/ArrowClockwise';
import { ArrowCounterClockwise } from '@phosphor-icons/react/ArrowCounterClockwise';
import { CaretDown } from '@phosphor-icons/react/CaretDown';
import { Check } from '@phosphor-icons/react/Check';
import { CheckSquare } from '@phosphor-icons/react/CheckSquare';
import { Code } from '@phosphor-icons/react/Code';
import { CodeBlock } from '@phosphor-icons/react/CodeBlock';
import { ColumnsPlusRight } from '@phosphor-icons/react/ColumnsPlusRight';
import { DotsThree } from '@phosphor-icons/react/DotsThree';
import { Highlighter } from '@phosphor-icons/react/Highlighter';
import { Image as ImageIcon } from '@phosphor-icons/react/Image';
import { LinkSimple } from '@phosphor-icons/react/LinkSimple';
import { ListBullets } from '@phosphor-icons/react/ListBullets';
import { ListNumbers } from '@phosphor-icons/react/ListNumbers';
import { Minus } from '@phosphor-icons/react/Minus';
import { Palette } from '@phosphor-icons/react/Palette';
import { Quotes } from '@phosphor-icons/react/Quotes';
import { RowsPlusBottom } from '@phosphor-icons/react/RowsPlusBottom';
import { Table } from '@phosphor-icons/react/Table';
import { TextAa } from '@phosphor-icons/react/TextAa';
import { TextAlignCenter } from '@phosphor-icons/react/TextAlignCenter';
import { TextAlignLeft } from '@phosphor-icons/react/TextAlignLeft';
import { TextAlignRight } from '@phosphor-icons/react/TextAlignRight';
import { TextB } from '@phosphor-icons/react/TextB';
import { TextItalic } from '@phosphor-icons/react/TextItalic';
import { TextStrikethrough } from '@phosphor-icons/react/TextStrikethrough';
import { TextTSlash } from '@phosphor-icons/react/TextTSlash';
import { TextUnderline } from '@phosphor-icons/react/TextUnderline';
import { X } from '@phosphor-icons/react/X';
import Color from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import { TableKit } from '@tiptap/extension-table';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
import { Fragment, Slice } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import type { CSSProperties, FormEvent, MouseEvent, ReactNode } from 'react';
import { useEffect, useId, useRef, useState } from 'react';

import {
  convertEditorContent,
  looksLikeStructuredText,
  normalizeLinkHref,
  parseRichContent,
  plainTextToRichDocument,
  richDocumentToContentText,
  restoreRichContentFromPlain,
  serializeRichDocument,
  type EditorContentValue,
  type EditorFormat,
} from './editorContent';
import {
  ACCEPTED_IMAGE_EXTENSIONS,
  ACCEPTED_IMAGE_MIME_TYPES,
  ImageAttachmentError,
  altTextForImageFile,
  clipboardTextIsIncidental,
  embeddedImagesInDocument,
  fileFromImageDataUrl,
  imageDataUrlsFromHtml,
  imageFilesFromDataTransfer,
  imageFitsNoteBudget,
  looksLikeImageFile,
  processImageFile,
  type ProcessedImage,
} from './imageAttachments';
import {
  MAX_NOTE_CONTENT_LENGTH,
  MAX_NOTE_TEXT_BYTES,
} from './notesCore';

export interface RichTextEditorProps {
  noteId: string;
  format: EditorFormat;
  content: string;
  richBackup?: string;
  footerSlot?: ReactNode;
  onChange: (next: EditorContentValue) => void;
  onFormatChange: (next: EditorContentValue) => void;
  smartFormatting?: boolean;
  onSmartFormattingChange?: (enabled: boolean) => void;
  onBlur?: () => void;
}

export type EditorChange = EditorContentValue;

const DEFAULT_TEXT_COLOR = '#4051b5';
const DEFAULT_HIGHLIGHT_COLOR = '#f9e8a7';

const EDITOR_EXTENSIONS = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    link: {
      autolink: true,
      linkOnPaste: true,
      openOnClick: false,
      defaultProtocol: 'https',
      HTMLAttributes: {
        rel: 'noopener noreferrer nofollow',
        target: '_blank',
      },
    },
  }),
  TextStyle,
  Color,
  Highlight.configure({ multicolor: true }),
  TaskList.configure({
    HTMLAttributes: { class: 'notes-task-list' },
  }),
  TaskItem.configure({
    nested: true,
    a11y: {
      checkboxLabel: node => `Task: ${node.textContent || 'Untitled task'}`,
    },
  }),
  TableKit.configure({
    table: {
      resizable: true,
      lastColumnResizable: false,
      HTMLAttributes: { class: 'notes-table' },
    },
  }),
  TextAlign.configure({
    types: ['heading', 'paragraph'],
    alignments: ['left', 'center', 'right'],
  }),
  Image.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        src: {
          default: null,
          parseHTML: (element: HTMLElement) => {
            const src = element.getAttribute('src');
            // In-note embeds are data URLs only — no hotlinked remote images.
            if (!src || !src.startsWith('data:image/')) {
              return null;
            }
            return src;
          },
          renderHTML: (attributes: Record<string, unknown>) => {
            if (!attributes.src) {
              return {};
            }
            return { src: attributes.src };
          },
        },
      };
    },
  }).configure({
    allowBase64: true,
    HTMLAttributes: {
      class: 'notes-embedded-image',
    },
  }),
  Placeholder.configure({
    placeholder: 'Start writing…',
  }),
];

const IMAGE_FILE_ACCEPT = [
  'image/*',
  ...ACCEPTED_IMAGE_MIME_TYPES,
  ...ACCEPTED_IMAGE_EXTENSIONS,
].join(',');

interface GalleryImage {
  key: string;
  pos: number | null;
  src: string;
  alt: string;
}

function imagesInEditor(editor: Editor): GalleryImage[] {
  const images: GalleryImage[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'image') return;
    const src = node.attrs.src;
    if (typeof src !== 'string' || !src.startsWith('data:image/')) return;
    const alt = typeof node.attrs.alt === 'string' && node.attrs.alt.trim()
      ? node.attrs.alt.trim()
      : 'Embedded image';
    images.push({ key: `${pos}`, pos, src, alt });
  });
  return images;
}

function appendImageNode<T extends { type: 'doc'; content: Array<{ type: string; attrs?: Record<string, unknown>; content?: unknown[] }> }>(
  document: T,
  image: { dataUrl: string; alt: string },
): T {
  return {
    ...document,
    content: [
      ...document.content,
      { type: 'image', attrs: { src: image.dataUrl, alt: image.alt } },
    ],
  };
}

async function readClipboardImageFiles(): Promise<File[]> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.read) return [];
  try {
    const items = await navigator.clipboard.read();
    const files: File[] = [];
    for (const item of items) {
      const type = item.types.find(entry => entry.startsWith('image/'));
      if (!type) continue;
      const blob = await item.getType(type);
      const extension = (blob.type || type).slice('image/'.length).replace('jpeg', 'jpg') || 'png';
      files.push(new File([blob], `pasted-image.${extension}`, { type: blob.type || type }));
    }
    return files;
  } catch {
    return [];
  }
}

interface ImageGalleryProps {
  images: GalleryImage[];
  busy: boolean;
  error: string;
  plainMode: boolean;
  onClose: () => void;
  onAdd: () => void;
  onShow: (image: GalleryImage) => void;
  onRemove: (image: GalleryImage) => void;
}

function ImageGallery({
  images,
  busy,
  error,
  plainMode,
  onClose,
  onAdd,
  onShow,
  onRemove,
}: ImageGalleryProps) {
  const titleId = useId();
  return (
    <section
      className="image-gallery"
      id="note-image-gallery"
      role="dialog"
      aria-labelledby={titleId}
    >
      <header className="image-gallery__header">
        <h2 id={titleId}>Images</h2>
        <button type="button" onClick={onClose} aria-label="Close images">
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <p className="image-gallery__hint">
        Images stay inside this note. They are not sent to a separate image host.
        {plainMode
          ? ' Adding a photo switches this note to rich text so the picture can stay with the writing.'
          : ''}
      </p>
      {error ? (
        <p className="image-gallery__error" role="alert">{error}</p>
      ) : null}
      {busy ? (
        <p className="image-gallery__status" role="status">Adding image…</p>
      ) : null}
      {images.length === 0 ? (
        <div className="image-gallery__empty">
          <ImageIcon size={22} aria-hidden="true" />
          <p>No images in this note yet.</p>
          <button
            type="button"
            className="primary-button"
            onClick={onAdd}
            disabled={busy}
          >
            Add from photos
          </button>
        </div>
      ) : (
        <>
          <ul className="image-gallery__grid">
            {images.map(image => (
              <li key={image.key} className="image-gallery__card">
                <button
                  type="button"
                  className="image-gallery__thumb"
                  onClick={() => onShow(image)}
                  aria-label={`Show ${image.alt} in the note`}
                >
                  <img src={image.src} alt="" />
                </button>
                <div className="image-gallery__meta">
                  <span className="image-gallery__name">{image.alt}</span>
                  {image.pos !== null ? (
                    <button
                      type="button"
                      className="image-gallery__remove"
                      onClick={() => onRemove(image)}
                      aria-label={`Remove ${image.alt}`}
                    >
                      Remove
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="image-gallery__remove"
                      onClick={() => onShow(image)}
                    >
                      Show
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <div className="image-gallery__actions">
            <button
              type="button"
              className="primary-button"
              onClick={onAdd}
              disabled={busy}
            >
              Add from photos
            </button>
          </div>
        </>
      )}
    </section>
  );
}

interface ToolbarButtonProps {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
  className?: string;
  ariaHasPopup?: 'dialog' | 'menu';
  ariaControls?: string;
  ariaExpanded?: boolean;
}

function ToolbarButton({
  label,
  active,
  disabled,
  onClick,
  children,
  className = '',
  ariaHasPopup,
  ariaControls,
  ariaExpanded,
}: ToolbarButtonProps) {
  return (
    <button
      type="button"
      className={`rich-text-editor__tool ${active ? 'is-active' : ''} ${className}`.trim()}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      aria-haspopup={ariaHasPopup}
      aria-controls={ariaControls}
      aria-expanded={ariaExpanded}
      title={label}
      disabled={disabled}
      onMouseDown={event => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

const asInputColor = (value: unknown, fallback: string): string =>
  typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value : fallback;

const hasMeaningfulRichHtml = (html: string): boolean =>
  /<(?:h[1-6]|ul|ol|li|blockquote|pre|code|table)\b/i.test(html);

export function RichTextEditor({
  noteId,
  format,
  content,
  richBackup = '',
  footerSlot,
  onChange,
  onFormatChange,
  smartFormatting = true,
  onSmartFormattingChange,
  onBlur,
}: RichTextEditorProps) {
  const linkInputId = useId();
  const linkErrorId = useId();
  const formatRef = useRef(format);
  const smartFormattingRef = useRef(smartFormatting);
  const onChangeRef = useRef(onChange);
  const onFormatChangeRef = useRef(onFormatChange);
  const onBlurRef = useRef(onBlur);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const [plainValue, setPlainValue] = useState(() =>
    format === 'plain' ? content : convertEditorContent(content, 'rich', 'plain').content,
  );
  const [toolbarRevision, setToolbarRevision] = useState(0);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState('');
  const [linkError, setLinkError] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [morePosition, setMorePosition] = useState({ top: 0, left: 0 });
  const [smartMessage, setSmartMessage] = useState<string | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryError, setGalleryError] = useState('');
  const imageInputRef = useRef<HTMLInputElement>(null);
  const richBackupRef = useRef(richBackup);
  const plainValueRef = useRef(plainValue);
  const embedFilesRef = useRef<(files: File[]) => Promise<void>>(async () => {});
  const capturedPasteFilesRef = useRef<File[] | null>(null);
  const pendingClipboardReadRef = useRef<Promise<File[]> | null>(null);
  const editorRef = useRef<Editor | null>(null);

  formatRef.current = format;
  smartFormattingRef.current = smartFormatting;
  onChangeRef.current = onChange;
  onFormatChangeRef.current = onFormatChange;
  onBlurRef.current = onBlur;
  richBackupRef.current = richBackup;
  plainValueRef.current = plainValue;

  const editor = useEditor(
    {
      extensions: EDITOR_EXTENSIONS,
      content:
        format === 'rich'
          ? parseRichContent(content)
          : plainTextToRichDocument(content),
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: {
          class: 'rich-text-editor__prose',
          'aria-label': 'Rich text note',
          spellcheck: 'true',
          autocapitalize: 'sentences',
        },
        transformPastedHTML(html) {
          return html.replace(/<img\b[^>]*>/gi, '');
        },
        handlePaste(view, event) {
          if (view.state.selection.$from.parent.type.name === 'codeBlock') {
            capturedPasteFilesRef.current = null;
            pendingClipboardReadRef.current = null;
            return false;
          }

          const captured = capturedPasteFilesRef.current;
          capturedPasteFilesRef.current = null;
          const pendingRead = pendingClipboardReadRef.current;
          pendingClipboardReadRef.current = null;
          const text = event.clipboardData?.getData('text/plain') ?? '';
          const html = event.clipboardData?.getData('text/html') ?? '';

          if (captured && captured.length > 0) {
            const exclusive = clipboardTextIsIncidental(text);
            if (exclusive) event.preventDefault();
            void embedFilesRef.current(captured);
            return exclusive;
          }

          if (pendingRead || (/<img\b/i.test(html) && clipboardTextIsIncidental(text))) {
            event.preventDefault();
            const read = pendingRead ?? readClipboardImageFiles();
            void read.then(files => {
              if (files.length > 0) {
                void embedFilesRef.current(files);
                return;
              }
              const dataFiles = imageDataUrlsFromHtml(html).flatMap((url, index) => {
                try {
                  return [fileFromImageDataUrl(url, `pasted-image-${index + 1}`)];
                } catch {
                  return [];
                }
              });
              if (dataFiles.length > 0) {
                void embedFilesRef.current(dataFiles);
                return;
              }
              const message = 'That paste did not include the image file. Open Images and add it from your photos.';
              setSmartMessage(message);
              setGalleryError(message);
            });
            return true;
          }

          if (
            !smartFormattingRef.current ||
            !text ||
            !looksLikeStructuredText(text) ||
            (html && hasMeaningfulRichHtml(html))
          ) {
            return false;
          }

          try {
            const document = plainTextToRichDocument(text);
            const nodes = document.content.map(node =>
              view.state.schema.nodeFromJSON(node),
            );
            const slice = new Slice(Fragment.fromArray(nodes), 0, 0);
            event.preventDefault();
            view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
            setSmartMessage('Paste formatted');
            return true;
          } catch {
            return false;
          }
        },
        handleDrop(view, event, _slice, moved) {
          if (moved) {
            return false;
          }

          const imageFiles = imageFilesFromDataTransfer(event.dataTransfer);
          if (imageFiles.length === 0) {
            return false;
          }

          event.preventDefault();
          const coords = view.posAtCoords({
            left: event.clientX,
            top: event.clientY,
          });
          if (coords && formatRef.current === 'rich') {
            view.dispatch(
              view.state.tr.setSelection(
                TextSelection.create(view.state.doc, coords.pos),
              ),
            );
          }

          void embedFilesRef.current(imageFiles);
          return true;
        },
      },
      onUpdate({ editor: nextEditor }) {
        setToolbarRevision(revision => revision + 1);
        if (formatRef.current !== 'rich') {
          return;
        }

        const document = nextEditor.getJSON();
        onChangeRef.current({
          content: JSON.stringify(document),
          contentText: richDocumentToContentText(document),
          format: 'rich',
        });
      },
      onSelectionUpdate() {
        setToolbarRevision(revision => revision + 1);
      },
      onBlur() {
        onBlurRef.current?.();
      },
    },
    [],
  );

  editorRef.current = editor;

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    let dom: HTMLElement;
    try {
      dom = editor.view.dom;
    } catch {
      return;
    }
    const onPasteCapture = (event: ClipboardEvent) => {
      const data = event.clipboardData;
      if (!data) return;
      const parentName = editor.state.selection.$from.parent.type.name;
      if (parentName === 'codeBlock') return;
      // Read files before any getData call. Chromium drops file items once text is read.
      const files = imageFilesFromDataTransfer(data);
      if (files.length > 0) {
        capturedPasteFilesRef.current = files;
        return;
      }
      const html = data.getData('text/html') ?? '';
      const dataUrls = imageDataUrlsFromHtml(html);
      if (dataUrls.length > 0) {
        capturedPasteFilesRef.current = dataUrls.flatMap((url, index) => {
          try {
            return [fileFromImageDataUrl(url, `pasted-image-${index + 1}`)];
          } catch {
            return [];
          }
        });
        return;
      }
      if (/<img\b/i.test(html)) {
        capturedPasteFilesRef.current = [];
        pendingClipboardReadRef.current = readClipboardImageFiles();
        return;
      }
      const types = Array.from(data.types ?? []);
      if (types.some(type => type === 'Files' || type.startsWith('image/'))) {
        capturedPasteFilesRef.current = [];
        pendingClipboardReadRef.current = readClipboardImageFiles();
      }
    };
    dom.addEventListener('paste', onPasteCapture, true);
    return () => dom.removeEventListener('paste', onPasteCapture, true);
  }, [editor]);

  useEffect(() => {
    if (!smartMessage) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setSmartMessage(null);
    }, 2800);
    return () => window.clearTimeout(timeout);
  }, [smartMessage]);

  useEffect(() => {
    if (!moreOpen) return;
    const timer = window.setTimeout(() => {
      moreMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [moreOpen]);

  useEffect(() => {
    if (!linkOpen && !moreOpen && !galleryOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element
        ? event.target
        : event.target instanceof Node
          ? event.target.parentElement
          : null;
      if (!target?.closest('#rich-link-editor, [aria-controls="rich-link-editor"]')) setLinkOpen(false);
      if (!target?.closest('#rich-more-menu, [aria-controls="rich-more-menu"]')) setMoreOpen(false);
      if (!target?.closest('#note-image-gallery, [aria-controls="note-image-gallery"]')) setGalleryOpen(false);
    };
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setLinkOpen(false);
      setMoreOpen(false);
      setGalleryOpen(false);
      if (editor && !editor.isDestroyed) editor.commands.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onEscape);
    };
  }, [editor, linkOpen, moreOpen, galleryOpen]);

  useEffect(() => {
    setLinkOpen(false);
    setMoreOpen(false);
    setLinkError('');

    if (format === 'plain') {
      setPlainValue(content);
    }
  }, [content, format, noteId]);

  useEffect(() => {
    // Under React StrictMode and Suspense reveal, `useEditor` can hand back an
    // instance whose ProseMirror view has already been torn down. It is still a
    // truthy Editor, but reading `editor.commands` (or getJSON) throws because
    // the internal command manager is null. Without an error boundary that throw
    // unmounts the whole app, so guard on the destroyed state, not just null.
    if (!editor || editor.isDestroyed) {
      return;
    }

    // setEditable emits an update by default. During a format or content change
    // that echo would send the stale document back to the parent and fight the
    // incoming note, including a just-added image.
    const editable = format === 'rich';
    if (editor.isEditable !== editable) {
      editor.setEditable(editable, false);
    }
    if (!editable) {
      return;
    }

    const document = parseRichContent(content);
    let current = '';
    try {
      current = JSON.stringify(editor.getJSON());
    } catch {
      return;
    }
    if (current !== serializeRichDocument(document)) {
      editor.commands.setContent(document, { emitUpdate: false });
      setToolbarRevision(revision => revision + 1);
    }
  }, [content, editor, format, noteId]);

  const richEnabled = Boolean(editor) && format === 'rich';
  const textStyle = editor?.isActive('heading', { level: 1 })
    ? 'h1'
    : editor?.isActive('heading', { level: 2 })
      ? 'h2'
      : editor?.isActive('heading', { level: 3 })
        ? 'h3'
        : 'paragraph';
  const selectedTextColor = asInputColor(
    editor?.getAttributes('textStyle').color,
    DEFAULT_TEXT_COLOR,
  );
  const selectedHighlightColor = asInputColor(
    editor?.getAttributes('highlight').color,
    DEFAULT_HIGHLIGHT_COLOR,
  );
  const hasTextColor = Boolean(editor?.getAttributes('textStyle').color);
  const hasHighlight = Boolean(editor?.isActive('highlight'));
  const canUndo = Boolean(editor?.can().chain().undo().run());
  const canRedo = Boolean(editor?.can().chain().redo().run());
  const isInTable = Boolean(editor?.isActive('table'));

  const changeTextStyle = (nextStyle: string) => {
    if (!editor) {
      return;
    }

    if (nextStyle === 'paragraph') {
      editor.chain().focus().setParagraph().run();
      return;
    }

    const level = Number(nextStyle.slice(1)) as 1 | 2 | 3;
    editor.chain().focus().setHeading({ level }).run();
  };

  const openLinkEditor = () => {
    if (!editor) {
      return;
    }
    setLinkValue(String(editor.getAttributes('link').href ?? ''));
    setLinkError('');
    setLinkOpen(open => !open);
    setMoreOpen(false);
  };

  const applyLink = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor) {
      return;
    }

    if (!linkValue.trim()) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      setLinkOpen(false);
      return;
    }

    const href = normalizeLinkHref(linkValue);
    if (!href) {
      setLinkError('Use a web, email, phone, anchor, or relative link.');
      return;
    }

    editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    setLinkValue(href);
    setLinkOpen(false);
    setLinkError('');
  };

  const reportImageIssue = (message: string) => {
    setSmartMessage(message);
    setGalleryError(message);
  };

  const imageFitsDocument = (
    document: ReturnType<typeof parseRichContent>,
    encodedLength: number,
    backup: string,
  ) => {
    const serialized = serializeRichDocument(document);
    const contentText = richDocumentToContentText(document);
    const encoder = new TextEncoder();
    return imageFitsNoteBudget({
      encodedLength,
      contentBytes: encoder.encode(serialized).byteLength,
      contentTextBytes: encoder.encode(contentText).byteLength,
      richBackupBytes: encoder.encode(backup).byteLength,
      contentLength: serialized.length,
      maxTextBytes: MAX_NOTE_TEXT_BYTES,
      maxContentLength: MAX_NOTE_CONTENT_LENGTH,
    });
  };

  const embedFiles = async (files: File[]) => {
    const supported = files.filter(looksLikeImageFile);
    if (supported.length === 0) {
      reportImageIssue('That file is not a supported image.');
      return;
    }

    setImageBusy(true);
    setGalleryError('');
    let blocked = false;
    try {
      const processed: Array<ProcessedImage & { alt: string }> = [];
      for (const file of supported) {
        try {
          const image = await processImageFile(file);
          processed.push({ ...image, alt: altTextForImageFile(file) });
        } catch (error) {
          blocked = true;
          reportImageIssue(
            error instanceof ImageAttachmentError
              ? error.message
              : 'Could not embed that image.',
          );
        }
      }
      if (processed.length === 0) return;

      const liveEditor = editorRef.current;
      const richLive = formatRef.current === 'rich' && liveEditor && !liveEditor.isDestroyed;
      let added = 0;

      if (!richLive) {
        const restored = restoreRichContentFromPlain(
          plainValueRef.current,
          richBackupRef.current || '',
          smartFormattingRef.current,
        );
        let document = parseRichContent(restored.content);
        for (const image of processed) {
          const fit = imageFitsDocument(document, image.encodedLength, '');
          if (!fit.fits) {
            blocked = true;
            reportImageIssue(fit.reason ?? 'This note is already too full to embed another image.');
            break;
          }
          document = appendImageNode(document, image);
          added += 1;
        }
        if (added === 0) return;
        onFormatChangeRef.current({
          content: serializeRichDocument(document),
          contentText: richDocumentToContentText(document),
          format: 'rich',
          richBackup: '',
        });
      } else {
        for (const image of processed) {
          const document = parseRichContent(JSON.stringify(liveEditor.getJSON()));
          const fit = imageFitsDocument(document, image.encodedLength, richBackupRef.current || '');
          if (!fit.fits) {
            blocked = true;
            reportImageIssue(fit.reason ?? 'This note is already too full to embed another image.');
            break;
          }
          const inserted = liveEditor
            .chain()
            .focus()
            .setImage({ src: image.dataUrl, alt: image.alt })
            .run();
          if (!inserted) {
            blocked = true;
            reportImageIssue('Could not embed that image.');
            break;
          }
          added += 1;
        }
      }

      if (added > 0 && !blocked) {
        setSmartMessage(added === 1 ? 'Image embedded' : `${added} images embedded`);
        setGalleryError('');
      }
    } finally {
      setImageBusy(false);
    }
  };

  embedFilesRef.current = embedFiles;

  const openImagePicker = () => {
    if (imageBusy) return;
    imageInputRef.current?.click();
  };

  const openGallery = () => {
    setMoreOpen(false);
    setLinkOpen(false);
    setGalleryOpen(open => !open);
  };

  const switchFormat = (nextFormat: EditorFormat) => {
    if (nextFormat === format) {
      return;
    }

    if (nextFormat === 'plain') {
      const document = editor?.getJSON() ?? parseRichContent(content);
      const serialized = serializeRichDocument(document);
      const next = convertEditorContent(
        serialized,
        'rich',
        'plain',
      );
      setPlainValue(next.content);
      onFormatChangeRef.current({ ...next, richBackup: serialized });
      return;
    }

    const next = restoreRichContentFromPlain(plainValue, richBackup, smartFormatting);
    editor?.commands.setContent(parseRichContent(next.content), { emitUpdate: false });
    onFormatChangeRef.current(next);
  };

  const runMoreCommand = (command: () => void) => {
    command();
    setMoreOpen(false);
  };

  const galleryImages: GalleryImage[] = (() => {
    if (format === 'rich' && editor && !editor.isDestroyed) {
      try {
        return imagesInEditor(editor);
      } catch {
        return [];
      }
    }
    return embeddedImagesInDocument(parseRichContent(richBackup)).map((image, index) => ({
      key: `backup-${index}`,
      pos: null,
      src: image.src,
      alt: image.alt,
    }));
  })();

  return (
    <section
      className="rich-text-editor"
      data-format={format}
      data-toolbar-revision={toolbarRevision}
      aria-label="Note editor"
    >
      <input
        ref={imageInputRef}
        type="file"
        accept={IMAGE_FILE_ACCEPT}
        hidden
        tabIndex={-1}
        aria-hidden="true"
        multiple
        data-testid="rich-text-image-input"
        onChange={event => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length > 0) {
            void embedFiles(files);
          }
        }}
      />
      <div className={`rich-text-editor__chrome ${format === 'plain' ? 'is-plain' : ''}`}>
        <div
          className="rich-text-editor__toolbar"
          role="toolbar"
          aria-label="Text formatting"
        >
          <div className="rich-text-editor__style-select-wrap">
            <select
              className="rich-text-editor__style-select"
              aria-label="Paragraph style"
              title="Paragraph style"
              value={textStyle}
              disabled={!richEnabled}
              onChange={event => changeTextStyle(event.target.value)}
            >
              <option value="paragraph">Paragraph</option>
              <option value="h1">Heading 1</option>
              <option value="h2">Heading 2</option>
              <option value="h3">Heading 3</option>
            </select>
            <CaretDown size={12} weight="bold" aria-hidden="true" />
          </div>

          <span className="rich-text-editor__separator" aria-hidden="true" />

          <ToolbarButton
            label="Bold (⌘B)"
            active={Boolean(editor?.isActive('bold'))}
            disabled={!richEnabled}
            onClick={() => editor?.chain().focus().toggleBold().run()}
          >
            <TextB size={17} weight="bold" aria-hidden="true" />
          </ToolbarButton>
          <ToolbarButton
            label="Italic (⌘I)"
            active={Boolean(editor?.isActive('italic'))}
            disabled={!richEnabled}
            onClick={() => editor?.chain().focus().toggleItalic().run()}
          >
            <TextItalic size={17} aria-hidden="true" />
          </ToolbarButton>
          <ToolbarButton
            label="Underline (⌘U)"
            active={Boolean(editor?.isActive('underline'))}
            disabled={!richEnabled}
            onClick={() => editor?.chain().focus().toggleUnderline().run()}
          >
            <TextUnderline size={17} aria-hidden="true" />
          </ToolbarButton>

          <div className="rich-text-editor__color-group">
            <ToolbarButton
              label={hasHighlight ? 'Remove highlight' : 'Highlight'}
              active={hasHighlight}
              disabled={!richEnabled}
              onClick={() => {
                if (hasHighlight) {
                  editor?.chain().focus().unsetHighlight().run();
                } else {
                  editor
                    ?.chain()
                    .focus()
                    .setHighlight({ color: selectedHighlightColor })
                    .run();
                }
              }}
            >
              <Highlighter size={17} aria-hidden="true" />
            </ToolbarButton>
            <label
              className="rich-text-editor__swatch"
              title="Highlight color"
              style={
                { '--editor-swatch': selectedHighlightColor } as CSSProperties
              }
            >
              <input
                type="color"
                aria-label="Highlight color"
                value={selectedHighlightColor}
                disabled={!richEnabled}
                onChange={event =>
                  editor
                    ?.chain()
                    .focus()
                    .setHighlight({ color: event.target.value })
                    .run()
                }
              />
            </label>
          </div>

          <div className="rich-text-editor__color-group">
            <ToolbarButton
              label={hasTextColor ? 'Remove text color' : 'Text color'}
              active={hasTextColor}
              disabled={!richEnabled}
              onClick={() => {
                if (hasTextColor) {
                  editor?.chain().focus().unsetColor().run();
                } else {
                  editor?.chain().focus().setColor(selectedTextColor).run();
                }
              }}
            >
              <Palette size={17} aria-hidden="true" />
            </ToolbarButton>
            <label
              className="rich-text-editor__swatch"
              title="Text color"
              style={{ '--editor-swatch': selectedTextColor } as CSSProperties}
            >
              <input
                type="color"
                aria-label="Text color"
                value={selectedTextColor}
                disabled={!richEnabled}
                onChange={event =>
                  editor?.chain().focus().setColor(event.target.value).run()
                }
              />
            </label>
          </div>

          <ToolbarButton
            label="Add or edit link"
            active={Boolean(editor?.isActive('link')) || linkOpen}
            disabled={!richEnabled}
            ariaHasPopup="dialog"
            ariaControls="rich-link-editor"
            ariaExpanded={linkOpen}
            onClick={openLinkEditor}
          >
            <LinkSimple size={17} aria-hidden="true" />
          </ToolbarButton>

          <span className="rich-text-editor__separator" aria-hidden="true" />

          <ToolbarButton
            label="Task list"
            active={Boolean(editor?.isActive('taskList'))}
            disabled={!richEnabled}
            onClick={() => editor?.chain().focus().toggleTaskList().run()}
          >
            <CheckSquare size={17} aria-hidden="true" />
          </ToolbarButton>
          <ToolbarButton
            label="Bulleted list"
            active={Boolean(editor?.isActive('bulletList'))}
            disabled={!richEnabled}
            onClick={() => editor?.chain().focus().toggleBulletList().run()}
          >
            <ListBullets size={17} aria-hidden="true" />
          </ToolbarButton>
          <ToolbarButton
            label="Numbered list"
            active={Boolean(editor?.isActive('orderedList'))}
            disabled={!richEnabled}
            onClick={() => editor?.chain().focus().toggleOrderedList().run()}
          >
            <ListNumbers size={17} aria-hidden="true" />
          </ToolbarButton>
          <ToolbarButton
            label="Insert 3 by 3 table"
            active={isInTable}
            disabled={!richEnabled || isInTable}
            onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
          >
            <Table size={17} aria-hidden="true" />
          </ToolbarButton>
          <ToolbarButton
            label="Images"
            active={galleryOpen}
            disabled={imageBusy}
            className="rich-text-editor__images-tool"
            ariaHasPopup="dialog"
            ariaControls="note-image-gallery"
            ariaExpanded={galleryOpen}
            onClick={openGallery}
          >
            <ImageIcon size={17} aria-hidden="true" />
          </ToolbarButton>
          <span className="rich-text-editor__separator" aria-hidden="true" />

          <ToolbarButton
            label="Undo (⌘Z)"
            disabled={!richEnabled || !canUndo}
            onClick={() => editor?.chain().focus().undo().run()}
          >
            <ArrowCounterClockwise size={17} aria-hidden="true" />
          </ToolbarButton>
          <ToolbarButton
            label="Redo (⌘⇧Z)"
            disabled={!richEnabled || !canRedo}
            onClick={() => editor?.chain().focus().redo().run()}
          >
            <ArrowClockwise size={17} aria-hidden="true" />
          </ToolbarButton>

          <div className="rich-text-editor__more-wrap">
            <ToolbarButton
              label="More formatting"
              active={moreOpen}
              disabled={!richEnabled}
              className="rich-text-editor__more-trigger"
              ariaHasPopup="menu"
              ariaControls="rich-more-menu"
              ariaExpanded={moreOpen}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setMorePosition({
                  top: rect.bottom + 6,
                  left: Math.max(12, Math.min(window.innerWidth - 202, rect.right - 190)),
                });
                setMoreOpen(open => !open);
                setLinkOpen(false);
              }}
            >
              <DotsThree size={20} weight="bold" aria-hidden="true" />
            </ToolbarButton>

            {moreOpen ? (
              <div
                ref={moreMenuRef}
                className="rich-text-editor__more-menu"
                id="rich-more-menu"
                style={morePosition}
                role="menu"
                aria-label="More formatting"
                onKeyDown={(event) => {
                  const items = Array.from(
                    event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
                  );
                  const index = items.indexOf(document.activeElement as HTMLButtonElement);
                  let nextIndex: number | undefined;
                  if (event.key === 'ArrowDown') nextIndex = (index + 1) % items.length;
                  if (event.key === 'ArrowUp') nextIndex = (index - 1 + items.length) % items.length;
                  if (event.key === 'Home') nextIndex = 0;
                  if (event.key === 'End') nextIndex = items.length - 1;
                  if (nextIndex === undefined || items.length === 0) return;
                  event.preventDefault();
                  items[nextIndex]?.focus();
                }}
              >
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={Boolean(editor?.isActive('strike'))}
                  onClick={() =>
                    runMoreCommand(() =>
                      void editor?.chain().focus().toggleStrike().run(),
                    )
                  }
                >
                  <TextStrikethrough size={16} aria-hidden="true" />
                  Strikethrough
                  {editor?.isActive('strike') ? (
                    <Check size={14} weight="bold" aria-hidden="true" />
                  ) : null}
                </button>
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={Boolean(editor?.isActive('blockquote'))}
                  onClick={() => runMoreCommand(() => void editor?.chain().focus().toggleBlockquote().run())}
                >
                  <Quotes size={16} aria-hidden="true" />
                  Quote
                  {editor?.isActive('blockquote') ? <Check size={14} weight="bold" aria-hidden="true" /> : null}
                </button>
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={Boolean(editor?.isActive('code'))}
                  onClick={() => runMoreCommand(() => void editor?.chain().focus().toggleCode().run())}
                >
                  <Code size={16} aria-hidden="true" />
                  Inline code
                  {editor?.isActive('code') ? <Check size={14} weight="bold" aria-hidden="true" /> : null}
                </button>
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={Boolean(editor?.isActive('codeBlock'))}
                  onClick={() => runMoreCommand(() => void editor?.chain().focus().toggleCodeBlock().run())}
                >
                  <CodeBlock size={16} aria-hidden="true" />
                  Code block
                  {editor?.isActive('codeBlock') ? <Check size={14} weight="bold" aria-hidden="true" /> : null}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => runMoreCommand(() => void editor?.chain().focus().setHorizontalRule().run())}
                >
                  <Minus size={16} aria-hidden="true" />
                  Divider
                </button>
                {!isInTable ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => runMoreCommand(() => void editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}
                  >
                    <Table size={16} aria-hidden="true" />
                    Insert table
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  disabled={imageBusy}
                  onClick={() => runMoreCommand(() => setGalleryOpen(true))}
                >
                  <ImageIcon size={16} aria-hidden="true" />
                  Images
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={Boolean(editor?.isActive({ textAlign: 'left' }))}
                  onClick={() =>
                    runMoreCommand(() =>
                      void editor?.chain().focus().setTextAlign('left').run(),
                    )
                  }
                >
                  <TextAlignLeft size={16} aria-hidden="true" />
                  Align left
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={Boolean(editor?.isActive({ textAlign: 'center' }))}
                  onClick={() =>
                    runMoreCommand(() =>
                      void editor?.chain().focus().setTextAlign('center').run(),
                    )
                  }
                >
                  <TextAlignCenter size={16} aria-hidden="true" />
                  Align center
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={Boolean(editor?.isActive({ textAlign: 'right' }))}
                  onClick={() =>
                    runMoreCommand(() =>
                      void editor?.chain().focus().setTextAlign('right').run(),
                    )
                  }
                >
                  <TextAlignRight size={16} aria-hidden="true" />
                  Align right
                </button>
                <span className="rich-text-editor__menu-separator" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() =>
                    runMoreCommand(() =>
                      void editor?.chain().focus().unsetAllMarks().clearNodes().run(),
                    )
                  }
                >
                  <TextTSlash size={16} aria-hidden="true" />
                  Clear formatting
                </button>
              </div>
            ) : null}
          </div>
        </div>

        <div className="rich-text-editor__mode-tools">
          {onSmartFormattingChange ? (
            <button
              type="button"
              className={`rich-text-editor__smart ${smartFormatting ? 'is-active' : ''}`}
              aria-pressed={smartFormatting}
              title="Recognize headings, lists, tasks, quotes, and code when pasting"
              onClick={() => onSmartFormattingChange(!smartFormatting)}
            >
              <TextAa size={15} weight="bold" aria-hidden="true" />
              <span role="status">
                {smartMessage ??
                  `Smart formatting ${smartFormatting ? 'on' : 'off'}`}
              </span>
            </button>
          ) : (
            <span className="rich-text-editor__smart" role="status">
              <TextAa size={15} weight="bold" aria-hidden="true" />
              {smartMessage ?? 'Smart formatting on'}
            </span>
          )}
          <div className="rich-text-editor__mode-switch" aria-label="Editor mode">
            <button
              type="button"
              className={format === 'rich' ? 'is-active' : ''}
              aria-pressed={format === 'rich'}
              onClick={() => switchFormat('rich')}
            >
              Rich text
            </button>
            <button
              type="button"
              className={format === 'plain' ? 'is-active' : ''}
              aria-pressed={format === 'plain'}
              title="Use plain text. Rich styling is restored if the text is unchanged."
              onClick={() => switchFormat('plain')}
            >
              Plain text
            </button>
          </div>
        </div>

        {format === 'rich' && isInTable ? (
          <div className="rich-text-editor__table-tools" role="toolbar" aria-label="Table editing">
            <span><Table size={15} aria-hidden="true" />Table</span>
            <button type="button" onClick={() => editor?.chain().focus().addRowAfter().run()}>
              <RowsPlusBottom size={15} aria-hidden="true" />Add row
            </button>
            <button type="button" onClick={() => editor?.chain().focus().addColumnAfter().run()}>
              <ColumnsPlusRight size={15} aria-hidden="true" />Add column
            </button>
            <button type="button" onClick={() => editor?.chain().focus().toggleHeaderRow().run()}>
              Header
            </button>
            <button type="button" onClick={() => editor?.chain().focus().deleteRow().run()}>
              Remove row
            </button>
            <button type="button" onClick={() => editor?.chain().focus().deleteColumn().run()}>
              Remove column
            </button>
            <button className="is-danger" type="button" onClick={() => editor?.chain().focus().deleteTable().run()}>
              Remove table
            </button>
          </div>
        ) : null}

        {linkOpen ? (
          <form className="rich-text-editor__link-popover" id="rich-link-editor" role="dialog" aria-label="Edit link" onSubmit={applyLink}>
            <label htmlFor={linkInputId}>Link</label>
            <input
              id={linkInputId}
              type="text"
              inputMode="url"
              autoComplete="url"
              autoFocus
              placeholder="https://example.com"
              value={linkValue}
              aria-invalid={Boolean(linkError)}
              aria-describedby={linkError ? linkErrorId : undefined}
              onChange={event => {
                setLinkValue(event.target.value);
                setLinkError('');
              }}
              onKeyDown={event => {
                if (event.key === 'Escape') {
                  setLinkOpen(false);
                  editor?.commands.focus();
                }
              }}
            />
            {linkError ? (
              <span id={linkErrorId} className="rich-text-editor__link-error">
                {linkError}
              </span>
            ) : null}
            <button type="submit" aria-label="Apply link" title="Apply link">
              <Check size={16} weight="bold" aria-hidden="true" />
            </button>
            {editor?.isActive('link') ? (
              <button
                type="button"
                onClick={() => {
                  editor.chain().focus().extendMarkRange('link').unsetLink().run();
                  setLinkOpen(false);
                }}
              >
                Remove
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Close link editor"
              title="Close"
              onClick={() => setLinkOpen(false)}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </form>
        ) : null}

        {galleryOpen ? (
          <ImageGallery
            images={galleryImages}
            busy={imageBusy}
            error={galleryError}
            plainMode={format !== 'rich'}
            onClose={() => setGalleryOpen(false)}
            onAdd={openImagePicker}
            onShow={image => {
              if (image.pos === null || !editor || editor.isDestroyed || format !== 'rich') {
                switchFormat('rich');
                return;
              }
              editor.chain().focus().setNodeSelection(image.pos).scrollIntoView().run();
            }}
            onRemove={image => {
              if (image.pos === null || !editor || editor.isDestroyed) return;
              editor.chain().focus().setNodeSelection(image.pos).deleteSelection().run();
            }}
          />
        ) : null}
        {format === 'plain' && smartMessage && !galleryOpen ? (
          <p className="rich-text-editor__image-notice" role="alert">{smartMessage}</p>
        ) : null}
      </div>

      <div className="rich-text-editor__document">

      {format === 'rich' ? (
        <EditorContent
          key={noteId}
          editor={editor}
          className="rich-text-editor__surface rich-text-editor__surface--rich"
        />
      ) : (
        <div className="rich-text-editor__surface rich-text-editor__surface--plain">
          <textarea
            aria-label="Plain text note"
            value={plainValue}
            placeholder="Start writing…"
            spellCheck
            autoCapitalize="sentences"
            onBlur={() => onBlurRef.current?.()}
            onPaste={event => {
              const clipboard = event.clipboardData;
              const files = imageFilesFromDataTransfer(clipboard);
              const html = files.length > 0 ? '' : clipboard?.getData('text/html') ?? '';
              const dataFiles = files.length > 0
                ? []
                : imageDataUrlsFromHtml(html).flatMap((url, index) => {
                  try {
                    return [fileFromImageDataUrl(url, `pasted-image-${index + 1}`)];
                  } catch {
                    return [];
                  }
                });
              const imageFiles = files.length > 0 ? files : dataFiles;
              if (imageFiles.length > 0) {
                event.preventDefault();
                void embedFiles(imageFiles);
                return;
              }
              const types = Array.from(clipboard?.types ?? []);
              const clipboardClaimsImage = /<img\b/i.test(html)
                || types.some(type => type === 'Files' || type.startsWith('image/'));
              if (clipboardClaimsImage) {
                event.preventDefault();
                void readClipboardImageFiles().then(clipboardFiles => {
                  if (clipboardFiles.length > 0) {
                    void embedFiles(clipboardFiles);
                    return;
                  }
                  reportImageIssue('That paste did not include the image file. Open Images and add it from your photos.');
                });
              }
            }}
            onChange={event => {
              const nextValue = event.target.value;
              setPlainValue(nextValue);
              onChangeRef.current({
                content: nextValue,
                contentText: nextValue.trim(),
                format: 'plain',
              });
            }}
          />
        </div>
      )}
      {footerSlot ? <div className="rich-text-editor__footer-slot">{footerSlot}</div> : null}
      </div>
    </section>
  );
}

export default RichTextEditor;
