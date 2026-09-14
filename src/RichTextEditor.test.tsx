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
    expect(within(toolbar).getByRole('button', { name: 'Insert image' })).toBeEnabled();

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

  it('disables image insert in plain-text mode', async () => {
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
    expect(within(toolbar).getByRole('button', { name: 'Insert image' })).toBeDisabled();
  });
});
