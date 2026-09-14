// Image attachments for Notes.
//
// Notes has no app-owned IndexedDB, no file-upload backend, and no Firebase
// Storage bucket wired into this repo. The Firestore schema is a shared,
// byte-identical canonical ruleset: notes may only carry the twelve fixed
// fields (plus the trash pair), so a new "images" subcollection or a new note
// field is impossible without changing infrastructure shared by nine sibling
// apps. The one place an image can live is *inside* the note body: a rich note
// stores TipTap/ProseMirror JSON in `content`, and an `image` node with a
// `data:` URL in `attrs.src` round-trips through that JSON and the existing
// document validators untouched.
//
// The whole design therefore hinges on keeping each embedded image small. The
// helpers below decode an incoming file, downscale it, and re-encode it to a
// tight byte budget (WebP where supported, JPEG otherwise, PNG only when
// transparency must survive) so a note with a few images stays well under the
// Firestore document limit and does not make cross-device sync expensive.

// Formats we accept from a picker/paste/drop. GIF is accepted but flattened to
// a single still frame during re-encode (animation is intentionally dropped to
// respect the size budget).
export const ACCEPTED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/avif',
] as const;

export const ACCEPTED_IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.avif',
] as const;

// The largest source file we will even attempt to decode. Bigger than this and
// we reject immediately rather than spend time decoding something that can
// never fit after compression.
export const MAX_SOURCE_IMAGE_BYTES = 25 * 1024 * 1024; // 25 MiB

// Longest edge, in CSS pixels, an embedded image is scaled down to. Screens in
// this app never render an image wider than the editor column, so anything
// larger is wasted bytes.
export const DEFAULT_MAX_IMAGE_DIMENSION = 1600;

// Target encoded byte size for a single embedded image (measured on the raw
// bytes, before base64). The encoder walks quality/size down until it lands at
// or below this, so a handful of images comfortably share the note budget.
export const DEFAULT_IMAGE_BYTE_BUDGET = 90 * 1024; // ~90 KiB raw (~120 KiB base64)

// Hard ceiling for a single image's raw bytes. Even if a note is otherwise
// empty we refuse to embed something larger than this so one image can never
// monopolise the whole document.
export const MAX_EMBEDDED_IMAGE_BYTES = 320 * 1024; // ~320 KiB raw (~427 KiB base64)

export interface ProcessedImage {
  /** A `data:` URL ready to drop into an image node's `src`. */
  dataUrl: string;
  mimeType: string;
  width: number;
  height: number;
  /** Length of the data URL string, i.e. what actually costs note budget. */
  encodedLength: number;
}

export interface ImageProcessingOptions {
  maxDimension?: number;
  byteBudget?: number;
  /** Bytes already spent in the note body; used for the fit check. */
  hasAlpha?: boolean;
}

/** UTF-8 byte length of a data URL. Data URLs are ASCII, so this is just length. */
export function dataUrlByteSize(dataUrl: string): number {
  // A `data:` URL is pure ASCII (base64 + a short ASCII header), so its UTF-16
  // length, its code-unit count, and its UTF-8 byte length all coincide.
  return dataUrl.length;
}

export function isAcceptedImageType(type: string): boolean {
  return (ACCEPTED_IMAGE_MIME_TYPES as readonly string[]).includes(type);
}

export function looksLikeImageFile(file: { type?: string; name?: string }): boolean {
  if (file.type && isAcceptedImageType(file.type)) return true;
  if (file.type && file.type.startsWith('image/')) return true;
  const name = (file.name ?? '').toLowerCase();
  return (ACCEPTED_IMAGE_EXTENSIONS as readonly string[]).some((ext) => name.endsWith(ext));
}

/**
 * How many bytes an already-encoded image would add to a note, and whether it
 * still fits under the shared 850 KB text budget once the current body,
 * searchable text, and rich backup are accounted for.
 *
 * `contentLength` is the UTF-16 length of the serialized rich `content` string
 * (the field an embedded image grows), mirroring the client + ruleset checks.
 */
export function imageFitsNoteBudget(params: {
  encodedLength: number;
  contentBytes: number;
  contentTextBytes: number;
  richBackupBytes: number;
  contentLength: number;
  maxTextBytes: number;
  maxContentLength: number;
}): { fits: boolean; reason?: string } {
  const {
    encodedLength,
    contentBytes,
    contentTextBytes,
    richBackupBytes,
    contentLength,
    maxTextBytes,
    maxContentLength,
  } = params;

  // Embedding an image node adds the data URL plus a little JSON scaffolding
  // (`{"type":"image","attrs":{"src":"…"}}`). Reserve a small, fixed overhead
  // so the estimate stays conservative.
  const nodeOverhead = 64;
  const projectedContentLength = contentLength + encodedLength + nodeOverhead;
  const projectedTextBytes =
    contentBytes + encodedLength + nodeOverhead + contentTextBytes + richBackupBytes;

  if (projectedContentLength > maxContentLength) {
    return {
      fits: false,
      reason: 'This note is already too full to embed another image.',
    };
  }
  if (projectedTextBytes > maxTextBytes) {
    return {
      fits: false,
      reason: 'This image would push the note past its safe sync size. Remove some content or add a smaller image.',
    };
  }
  return { fits: true };
}

function pickEncodeType(sourceType: string, hasAlpha: boolean, canWebp: boolean): string {
  if (canWebp) return 'image/webp';
  // Without WebP, preserve transparency with PNG; otherwise JPEG is far smaller.
  if (hasAlpha || sourceType === 'image/png') return 'image/png';
  return 'image/jpeg';
}

let cachedWebpSupport: boolean | null = null;

/** Whether this browser can encode canvases to WebP. Cached after first probe. */
export function canvasSupportsWebp(
  createCanvas: () => HTMLCanvasElement | OffscreenCanvas = () => document.createElement('canvas'),
): boolean {
  if (cachedWebpSupport !== null) return cachedWebpSupport;
  try {
    const canvas = createCanvas() as HTMLCanvasElement;
    if (typeof canvas.toDataURL !== 'function') {
      cachedWebpSupport = false;
      return false;
    }
    const probe = canvas.toDataURL('image/webp');
    cachedWebpSupport = probe.startsWith('data:image/webp');
  } catch {
    cachedWebpSupport = false;
  }
  return cachedWebpSupport;
}

/** Scales (w,h) so the longest edge is at most `maxDimension`, never upscaling. */
export function scaledDimensions(
  width: number,
  height: number,
  maxDimension: number,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const longest = Math.max(width, height);
  if (longest <= maxDimension) {
    return { width: Math.round(width), height: Math.round(height) };
  }
  const scale = maxDimension / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export class ImageAttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageAttachmentError';
  }
}

interface DecodedBitmap {
  draw: (canvas: HTMLCanvasElement, width: number, height: number) => void;
  width: number;
  height: number;
  cleanup: () => void;
}

async function decodeImage(file: Blob): Promise<DecodedBitmap> {
  // Prefer createImageBitmap: it decodes off the main thread and avoids the
  // <img> load dance. Fall back to an object-URL <img> when unavailable.
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        width: bitmap.width,
        height: bitmap.height,
        draw: (canvas, width, height) => {
          const context = canvas.getContext('2d');
          if (!context) throw new ImageAttachmentError('This browser cannot process images.');
          context.drawImage(bitmap, 0, 0, width, height);
        },
        cleanup: () => bitmap.close(),
      };
    } catch {
      // Fall through to the <img> path.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new ImageAttachmentError('This file is not a readable image.'));
      element.src = url;
    });
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      draw: (canvas, width, height) => {
        const context = canvas.getContext('2d');
        if (!context) throw new ImageAttachmentError('This browser cannot process images.');
        context.drawImage(image, 0, 0, width, height);
      },
      cleanup: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function canvasToDataUrl(canvas: HTMLCanvasElement, type: string, quality: number): string {
  const url = canvas.toDataURL(type, quality);
  // Some browsers silently fall back to PNG for unsupported types. Accept
  // whatever came back; the caller measures the real bytes regardless.
  return url;
}

/**
 * Decode → downscale → re-encode a source image into a compact `data:` URL that
 * respects `byteBudget`. Quality is stepped down, then dimensions, until the
 * encoded bytes fit the budget (or the hard ceiling is reached). Throws
 * {@link ImageAttachmentError} with a user-facing message on failure.
 */
export async function processImageFile(
  file: File | Blob,
  options: ImageProcessingOptions = {},
): Promise<ProcessedImage> {
  const size = (file as File).size ?? file.size ?? 0;
  if (size > MAX_SOURCE_IMAGE_BYTES) {
    throw new ImageAttachmentError('That image is too large to attach. Try one under 25 MB.');
  }

  const maxDimension = options.maxDimension ?? DEFAULT_MAX_IMAGE_DIMENSION;
  const byteBudget = Math.min(
    options.byteBudget ?? DEFAULT_IMAGE_BYTE_BUDGET,
    MAX_EMBEDDED_IMAGE_BYTES,
  );

  const decoded = await decodeImage(file);
  try {
    if (!decoded.width || !decoded.height) {
      throw new ImageAttachmentError('This image has no visible content.');
    }

    const sourceType = (file as File).type || 'image/png';
    const hasAlpha = options.hasAlpha ?? (sourceType === 'image/png' || sourceType === 'image/webp' || sourceType === 'image/avif' || sourceType === 'image/gif');
    const canWebp = canvasSupportsWebp();
    const encodeType = pickEncodeType(sourceType, hasAlpha, canWebp);
    const canvas = document.createElement('canvas');

    // Try progressively smaller dimensions; at each size, step quality down.
    let dimension = maxDimension;
    let best: ProcessedImage | null = null;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const { width, height } = scaledDimensions(decoded.width, decoded.height, dimension);
      canvas.width = width;
      canvas.height = height;
      decoded.draw(canvas, width, height);

      const qualities = encodeType === 'image/png' ? [1] : [0.82, 0.7, 0.58, 0.45];
      for (const quality of qualities) {
        const dataUrl = canvasToDataUrl(canvas, encodeType, quality);
        const encodedLength = dataUrlByteSize(dataUrl);
        const candidate: ProcessedImage = {
          dataUrl,
          mimeType: dataUrl.slice(5, dataUrl.indexOf(';')) || encodeType,
          width,
          height,
          encodedLength,
        };
        if (!best || candidate.encodedLength < best.encodedLength) best = candidate;
        if (encodedLength <= byteBudget) {
          return candidate;
        }
      }

      // Still too big: shrink the longest edge and try again.
      const longest = Math.max(width, height);
      if (longest <= 320) break; // Don't degrade past a usable thumbnail.
      dimension = Math.round(longest * 0.75);
    }

    if (best && best.encodedLength <= MAX_EMBEDDED_IMAGE_BYTES) {
      return best;
    }
    throw new ImageAttachmentError(
      'This image is too detailed to compress small enough to embed. Try a simpler or smaller image.',
    );
  } finally {
    decoded.cleanup();
  }
}
