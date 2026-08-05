import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RichTextEditor } from './RichTextEditor';

describe('RichTextEditor tables', () => {
  it('inserts an editable table and exposes contextual table controls', async () => {
    const onChange = vi.fn();
    const { container } = render(
      <RichTextEditor
        noteId="table-note"
        format="rich"
        content={JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] })}
        onChange={onChange}
        onFormatChange={vi.fn()}
      />,
    );

    const insert = await screen.findByRole('button', { name: 'Insert 3 by 3 table' });
    fireEvent.click(insert);

    await waitFor(() => {
      expect(container.querySelectorAll('table tbody tr')).toHaveLength(3);
    });
    expect(screen.getByRole('toolbar', { name: 'Table editing' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add row' }));
    await waitFor(() => {
      expect(container.querySelectorAll('table tbody tr')).toHaveLength(4);
    });
    expect(onChange).toHaveBeenCalled();
  });
});
