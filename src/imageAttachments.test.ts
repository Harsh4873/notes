import { describe, expect, it } from 'vitest';

import {
  ACCEPTED_IMAGE_MIME_TYPES,
  dataUrlByteSize,
  imageFitsNoteBudget,
  isAcceptedImageType,
  looksLikeImageFile,
  scaledDimensions,
} from './imageAttachments';

describe('image mime acceptance', () => {
  it('accepts the documented raster formats', () => {
    for (const type of ACCEPTED_IMAGE_MIME_TYPES) {
      expect(isAcceptedImageType(type)).toBe(true);
    }
  });

  it('rejects non-image types', () => {
    expect(isAcceptedImageType('application/pdf')).toBe(false);
    expect(isAcceptedImageType('text/plain')).toBe(false);
    expect(isAcceptedImageType('')).toBe(false);
  });

  it('recognises image files by mime or extension', () => {
    expect(looksLikeImageFile({ type: 'image/png' })).toBe(true);
    expect(looksLikeImageFile({ type: 'image/heic' })).toBe(true); // any image/*
    expect(looksLikeImageFile({ type: '', name: 'photo.JPEG' })).toBe(true);
    expect(looksLikeImageFile({ type: '', name: 'clip.webp' })).toBe(true);
    expect(looksLikeImageFile({ type: '', name: 'notes.txt' })).toBe(false);
    expect(looksLikeImageFile({})).toBe(false);
  });
});

describe('scaledDimensions', () => {
  it('never upscales an image smaller than the cap', () => {
    expect(scaledDimensions(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });

  it('scales the longest edge down to the cap and keeps aspect ratio', () => {
    expect(scaledDimensions(3200, 1600, 1600)).toEqual({ width: 1600, height: 800 });
    expect(scaledDimensions(1000, 4000, 1600)).toEqual({ width: 400, height: 1600 });
  });

  it('guards against degenerate sizes', () => {
    expect(scaledDimensions(0, 0, 1600)).toEqual({ width: 0, height: 0 });
    expect(scaledDimensions(10000, 1, 1600).height).toBeGreaterThanOrEqual(1);
  });
});

describe('dataUrlByteSize', () => {
  it('measures the data URL length (ASCII, so bytes == length)', () => {
    const url = 'data:image/webp;base64,AAAA';
    expect(dataUrlByteSize(url)).toBe(url.length);
  });
});

describe('imageFitsNoteBudget', () => {
  const base = {
    contentBytes: 0,
    contentTextBytes: 0,
    richBackupBytes: 0,
    contentLength: 0,
    maxTextBytes: 850_000,
    maxContentLength: 600_000,
  };

  it('accepts a small image into an empty note', () => {
    expect(imageFitsNoteBudget({ ...base, encodedLength: 120_000 }).fits).toBe(true);
  });

  it('rejects an image that would exceed the shared text-byte budget', () => {
    const result = imageFitsNoteBudget({
      ...base,
      encodedLength: 200_000,
      contentBytes: 400_000,
      contentTextBytes: 300_000,
    });
    expect(result.fits).toBe(false);
    expect(result.reason).toMatch(/past its safe sync size/);
  });

  it('rejects an image that would exceed the content-length limit', () => {
    const result = imageFitsNoteBudget({
      ...base,
      encodedLength: 200_000,
      contentLength: 590_000,
    });
    expect(result.fits).toBe(false);
    expect(result.reason).toMatch(/too full/);
  });

  it('leaves headroom for JSON node scaffolding', () => {
    // Exactly at the raw budget should fail once node overhead is added.
    const result = imageFitsNoteBudget({
      ...base,
      encodedLength: 850_000,
    });
    expect(result.fits).toBe(false);
  });
});
