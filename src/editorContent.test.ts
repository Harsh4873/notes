import { describe, expect, it } from 'vitest';

import {
  convertEditorContent,
  looksLikeStructuredText,
  parseRichContent,
  plainTextToRichContent,
  plainTextToRichDocument,
  richDocumentToPlainText,
  restoreRichContentFromPlain,
} from './editorContent';

describe('plainTextToRichDocument', () => {
  it('smart-parses explicit headings, lists, checklists, quotes, dividers, and code', () => {
    const document = plainTextToRichDocument(`# Trip plan

Pack **light**.

- [ ] Passport
- [x] Charger

- Train
- Hotel

3. Arrive
4. Check in

> Keep the confirmation handy.

---

\`\`\`
const ready = true
\`\`\``);

    expect(document.content.map(node => node.type)).toEqual([
      'heading',
      'paragraph',
      'taskList',
      'bulletList',
      'orderedList',
      'blockquote',
      'horizontalRule',
      'codeBlock',
    ]);
    expect(document.content[0].attrs).toEqual({ level: 1 });
    expect(document.content[1].content?.[1].marks).toEqual([{ type: 'bold' }]);
    expect(document.content[2].content?.map(item => item.attrs?.checked)).toEqual([
      false,
      true,
    ]);
    expect(document.content[4].attrs).toEqual({ start: 3 });
    expect(document.content[7].content?.[0].text).toBe('const ready = true');
  });

  it('keeps ordinary multiline text as readable prose with hard breaks', () => {
    const document = plainTextToRichDocument('Call Mom\nAsk about Sunday');

    expect(document.content).toEqual([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Call Mom' },
          { type: 'hardBreak' },
          { type: 'text', text: 'Ask about Sunday' },
        ],
      },
    ]);
  });

  it('recognizes only explicit block structure for smart paste', () => {
    expect(looksLikeStructuredText('A regular note\nwith two lines')).toBe(false);
    expect(looksLikeStructuredText('## Decisions\n- Ship it')).toBe(true);
    expect(looksLikeStructuredText('- [ ] Follow up')).toBe(true);
  });
});

describe('stored rich content', () => {
  it('accepts valid Tiptap JSON and upgrades legacy plain content safely', () => {
    const stored = JSON.stringify({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Saved' }] }],
    });

    expect(parseRichContent(stored).content[0].type).toBe('paragraph');
    expect(parseRichContent('# Legacy note').content[0]).toMatchObject({
      type: 'heading',
      attrs: { level: 1 },
    });
  });

  it('round-trips readable block structure through plain mode', () => {
    const source = plainTextToRichDocument(`# Ideas

- [x] Capture
- [ ] Refine

> Small notes compound.

\`\`\`
copy on phone
\`\`\``);
    const plain = richDocumentToPlainText(source);

    expect(plain).toContain('# Ideas');
    expect(plain).toContain('- [x] Capture');
    expect(plain).toContain('> Small notes compound.');
    expect(plain).toContain('```\ncopy on phone\n```');
    expect(plainTextToRichDocument(plain)).toEqual(source);
  });

  it('produces canonical rich payloads for quick capture', () => {
    const result = plainTextToRichContent('## Inbox\n- paste from phone');

    expect(JSON.parse(result.content)).toMatchObject({
      type: 'doc',
      content: [{ type: 'heading' }, { type: 'bulletList' }],
    });
    expect(result.contentText).toBe('Inbox\npaste from phone');
  });

  it('keeps formatting markers literal when smart formatting is disabled', () => {
    const result = plainTextToRichContent('## Literal\n- not a list\n**not bold**', false);
    const document = JSON.parse(result.content);

    expect(document.content).toEqual([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '## Literal' },
          { type: 'hardBreak' },
          { type: 'text', text: '- not a list' },
          { type: 'hardBreak' },
          { type: 'text', text: '**not bold**' },
        ],
      },
    ]);
  });

  it('converts modes without exposing JSON in plain mode', () => {
    const rich = convertEditorContent('# Topic\n\nDetails', 'plain', 'rich');
    const plain = convertEditorContent(rich.content, 'rich', 'plain');

    expect(rich.format).toBe('rich');
    expect(() => JSON.parse(rich.content)).not.toThrow();
    expect(plain).toEqual({
      content: '# Topic\n\nDetails',
      contentText: 'Topic\nDetails',
      format: 'plain',
    });
  });

  it('restores exact rich-only marks, alignment, and nesting after an unchanged plain view', () => {
    const backup = JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { textAlign: 'center' },
          content: [{
            type: 'text',
            text: 'Styled thought',
            marks: [
              { type: 'underline' },
              { type: 'highlight', attrs: { color: '#f9e8a7' } },
              { type: 'textStyle', attrs: { color: '#4051b5' } },
            ],
          }],
        },
        {
          type: 'bulletList',
          content: [{
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'Parent' }] },
              {
                type: 'bulletList',
                content: [{
                  type: 'listItem',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Child' }] }],
                }],
              },
            ],
          }],
        },
      ],
    });
    const plain = convertEditorContent(backup, 'rich', 'plain').content;

    const restored = restoreRichContentFromPlain(plain, backup, false);

    expect(restored.content).toBe(backup);
    expect(restored.richBackup).toBe('');
    expect(JSON.parse(restored.content).content[0].marks).toBeUndefined();
    expect(JSON.parse(restored.content).content[0].content[0].marks).toHaveLength(3);
  });

  it('uses current smart-formatting behavior after plain text is actually edited', () => {
    const original = plainTextToRichContent('## Heading\n- Item').content;

    const restored = restoreRichContentFromPlain('## Heading\n- Item\nChanged', original, false);
    const document = JSON.parse(restored.content);

    expect(restored.richBackup).toBe('');
    expect(document.content).toHaveLength(1);
    expect(document.content[0].type).toBe('paragraph');
    expect(document.content[0].content[0].text).toBe('## Heading');
  });
});
