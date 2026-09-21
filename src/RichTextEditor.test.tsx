import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as imageAttachments from './imageAttachments';
import { RichTextEditor } from './RichTextEditor';

const emptyRich = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] });

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('RichTextEditor tables', () => {
  it('inserts an editable table and exposes contextual table controls', async () => {
    const onChange = vi.fn();
    const { container } = render(
      <RichTextEditor
        noteId="table-note"
        format="rich"
        content={emptyRich}
        onChange={onChange}
        onFormatChange={vi.fn()}
      />,
    );

    const insert = await within(container).findByRole('button', { name: 'Insert 3 by 3 table' });
    fireEvent.click(insert);

    await waitFor(() => {
      expect(container.querySelectorAll('table tbody tr')).toHaveLength(3);
    });
    expect(within(container).getByRole('toolbar', { name: 'Table editing' })).toBeInTheDocument();

    fireEvent.click(within(container).getByRole('button', { name: 'Add row' }));
    await waitFor(() => {
      expect(container.querySelectorAll('table tbody tr')).toHaveLength(4);
    });
    expect(onChange).toHaveBeenCalled();
  });
});

describe('RichTextEditor images', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('embeds a compressed image from the file picker', async () => {
    const onChange = vi.fn();
    const dataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    vi.spyOn(imageAttachments, 'processImageFile').mockResolvedValue({
      dataUrl,
      mimeType: 'image/png',
      width: 1,
      height: 1,
      encodedLength: dataUrl.length,
    });

    const { container } = render(
      <RichTextEditor
        noteId="image-note"
        format="rich"
        content={emptyRich}
        onChange={onChange}
        onFormatChange={vi.fn()}
      />,
    );

    const toolbar = within(container).getByRole('toolbar', { name: 'Text formatting' });
    expect(within(toolbar).getByRole('button', { name: 'Images' })).toBeEnabled();

    const input = container.querySelector(
      'input[data-testid="rich-text-image-input"]',
    ) as HTMLInputElement;
    expect(input).toBeTruthy();

    const file = new File([new Uint8Array([1, 2, 3, 4])], 'dot.png', {
      type: 'image/png',
    });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      const img = container.querySelector('img.notes-embedded-image, img[src^="data:image"]');
      expect(img).toBeTruthy();
      expect(img?.getAttribute('src')).toBe(dataUrl);
    });
    expect(imageAttachments.processImageFile).toHaveBeenCalled();
    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls.at(-1)?.[0];
    expect(lastCall?.content).toContain('data:image/png;base64');
  });

  it('shows a notice and does not insert when the note budget rejects the image', async () => {
    const onChange = vi.fn();
    const dataUrl = `data:image/png;base64,${'A'.repeat(200)}`;

    vi.spyOn(imageAttachments, 'processImageFile').mockResolvedValue({
      dataUrl,
      mimeType: 'image/png',
      width: 40,
      height: 40,
      encodedLength: dataUrl.length,
    });
    vi.spyOn(imageAttachments, 'imageFitsNoteBudget').mockReturnValue({
      fits: false,
      reason: 'This note is already too full to embed another image.',
    });

    const { container } = render(
      <RichTextEditor
        noteId="budget-note"
        format="rich"
        content={emptyRich}
        onChange={onChange}
        onFormatChange={vi.fn()}
      />,
    );

    const input = container.querySelector(
      'input[data-testid="rich-text-image-input"]',
    ) as HTMLInputElement;
    const file = new File([new Uint8Array([9, 9, 9])], 'big.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(
        within(container).getByText('This note is already too full to embed another image.'),
      ).toBeInTheDocument();
    });
    expect(container.querySelector('img[src^="data:image"]')).toBeNull();
  });

  it('keeps Images available in plain-text mode', async () => {
    const { container } = render(
      <RichTextEditor
        noteId="plain-note"
        format="plain"
        content="Just text"
        onChange={vi.fn()}
        onFormatChange={vi.fn()}
      />,
    );

    const toolbar = within(container).getByRole('toolbar', { name: 'Text formatting' });
    expect(within(toolbar).getByRole('button', { name: 'Images' })).toBeEnabled();
  });

  it('embeds an image pasted from the clipboard', async () => {
    const onChange = vi.fn();
    const dataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    vi.spyOn(imageAttachments, 'processImageFile').mockResolvedValue({
      dataUrl,
      mimeType: 'image/png',
      width: 1,
      height: 1,
      encodedLength: dataUrl.length,
    });

    const { container } = render(
      <RichTextEditor
        noteId="paste-note"
        format="rich"
        content={emptyRich}
        onChange={onChange}
        onFormatChange={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('.ProseMirror')).toBeTruthy();
    });
    const editor = container.querySelector('.ProseMirror') as HTMLElement;
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'shot.png', { type: 'image/png' });
    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
        getData: () => '',
        types: ['Files'],
      },
    });

    await waitFor(() => {
      const img = container.querySelector('img.notes-embedded-image, img[src^="data:image"]');
      expect(img?.getAttribute('src')).toBe(dataUrl);
    });
    expect(onChange).toHaveBeenCalled();
  });

  it('embeds a pasted data-url image and refuses a remote image hotlink', async () => {
    const onChange = vi.fn();
    const dataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    vi.spyOn(imageAttachments, 'processImageFile').mockResolvedValue({
      dataUrl,
      mimeType: 'image/png',
      width: 1,
      height: 1,
      encodedLength: dataUrl.length,
    });

    const { container } = render(
      <RichTextEditor
        noteId="html-paste-note"
        format="rich"
        content={emptyRich}
        onChange={onChange}
        onFormatChange={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('.ProseMirror')).toBeTruthy();
    });
    const editor = container.querySelector('.ProseMirror') as HTMLElement;
    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        items: [],
        types: ['text/html'],
        getData: (type: string) => (
          type === 'text/html' ? '<img src="data:image/png;base64,AAAA">' : ''
        ),
      },
    });

    await waitFor(() => {
      expect(container.querySelector('img[src^="data:image"]')).toBeTruthy();
    });

    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        items: [],
        types: ['text/html'],
        getData: (type: string) => (
          type === 'text/html' ? '<img src="https://example.com/secret.png" alt="Remote">' : ''
        ),
      },
    });

    await waitFor(() => {
      expect(
        within(container).getByText('That paste did not include the image file. Open Images and add it from your photos.'),
      ).toBeInTheDocument();
    });
    expect(container.querySelector('img[src^="https:"]')).toBeNull();
  });

  it('switches a plain note to rich text when an image is pasted', async () => {
    const onFormatChange = vi.fn();
    const dataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    vi.spyOn(imageAttachments, 'processImageFile').mockResolvedValue({
      dataUrl,
      mimeType: 'image/png',
      width: 1,
      height: 1,
      encodedLength: dataUrl.length,
    });

    const { container } = render(
      <RichTextEditor
        noteId="plain-paste"
        format="plain"
        content="Keep this thought."
        onChange={vi.fn()}
        onFormatChange={onFormatChange}
      />,
    );

    const textbox = within(container).getByRole('textbox', { name: 'Plain text note' });
    const file = new File([new Uint8Array([8, 8])], 'clip.png', { type: 'image/png' });
    fireEvent.paste(textbox, {
      clipboardData: {
        files: [file],
        items: [],
        getData: () => '',
        types: ['Files'],
      },
    });

    await waitFor(() => {
      expect(onFormatChange).toHaveBeenCalled();
    });
    const next = onFormatChange.mock.calls.at(-1)?.[0];
    expect(next.format).toBe('rich');
    expect(next.content).toContain('data:image/png;base64');
    expect(next.content).toContain('Keep this thought.');
  });

  it('shows an empty gallery, then the image added from photos', async () => {
    const dataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    vi.spyOn(imageAttachments, 'processImageFile').mockResolvedValue({
      dataUrl,
      mimeType: 'image/png',
      width: 1,
      height: 1,
      encodedLength: dataUrl.length,
    });

    const { container } = render(
      <RichTextEditor
        noteId="gallery-note"
        format="rich"
        content={emptyRich}
        onChange={vi.fn()}
        onFormatChange={vi.fn()}
      />,
    );

    fireEvent.click(within(container).getByRole('button', { name: 'Images' }));
    const gallery = within(container).getByRole('dialog', { name: 'Images' });
    expect(within(gallery).getByText('No images in this note yet.')).toBeInTheDocument();

    const input = container.querySelector(
      'input[data-testid="rich-text-image-input"]',
    ) as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], 'Field sketch.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(within(gallery).getByRole('button', { name: 'Show Field sketch in the note' })).toBeInTheDocument();
    });
    expect(within(gallery).queryByText('No images in this note yet.')).toBeNull();
  });

  it('lists images already in the note and removes one from the gallery', async () => {
    const dataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const content = JSON.stringify({
      type: 'doc',
      content: [
        { type: 'paragraph' },
        { type: 'image', attrs: { src: dataUrl, alt: 'Field sketch' } },
      ],
    });

    const { container } = render(
      <RichTextEditor
        noteId="existing-images"
        format="rich"
        content={content}
        onChange={vi.fn()}
        onFormatChange={vi.fn()}
      />,
    );

    fireEvent.click(within(container).getByRole('button', { name: 'Images' }));
    const gallery = within(container).getByRole('dialog', { name: 'Images' });
    expect(within(gallery).getByRole('button', { name: 'Show Field sketch in the note' })).toBeInTheDocument();

    fireEvent.click(within(gallery).getByRole('button', { name: 'Remove Field sketch' }));
    await waitFor(() => {
      expect(within(gallery).getByText('No images in this note yet.')).toBeInTheDocument();
    });
    expect(container.querySelector('img[src^="data:image"]')).toBeNull();
  });

  it('shows a gallery error when a chosen file cannot be embedded', async () => {
    vi.spyOn(imageAttachments, 'processImageFile').mockRejectedValue(
      new imageAttachments.ImageAttachmentError('That image is too large to attach. Try one under 25 MB.'),
    );

    const { container } = render(
      <RichTextEditor
        noteId="gallery-error"
        format="rich"
        content={emptyRich}
        onChange={vi.fn()}
        onFormatChange={vi.fn()}
      />,
    );

    fireEvent.click(within(container).getByRole('button', { name: 'Images' }));
    const input = container.querySelector(
      'input[data-testid="rich-text-image-input"]',
    ) as HTMLInputElement;
    const file = new File([new Uint8Array([1])], 'huge.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });

    const gallery = within(container).getByRole('dialog', { name: 'Images' });
    await waitFor(() => {
      expect(
        within(gallery).getByRole('alert'),
      ).toHaveTextContent('That image is too large to attach. Try one under 25 MB.');
    });
    expect(within(gallery).getByText('No images in this note yet.')).toBeInTheDocument();
  });
});
