import { describe, expect, it } from 'vitest';

import {
  convertEditorContent,
  looksLikeStructuredText,
  parseRichContent,
  plainTextToRichContent,
  plainTextToRichDocument,
  richContentToClipboardText,
  richContentToContentText,
  richContentToPlainText,
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

  it('turns a pasted Markdown table into an editable rich table', () => {
    const source = `| Item | Owner | Status |
| --- | --- | --- |
| Outline \\| review | Me | Done |
| Review | Team | Next |`;
    const document = plainTextToRichDocument(source);

    expect(looksLikeStructuredText(source)).toBe(true);
    expect(document.content[0]).toMatchObject({
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableHeader' },
            { type: 'tableHeader' },
            { type: 'tableHeader' },
          ],
        },
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell' },
            { type: 'tableCell' },
            { type: 'tableCell' },
          ],
        },
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell' },
            { type: 'tableCell' },
            { type: 'tableCell' },
          ],
        },
      ],
    });
    expect(richDocumentToPlainText(document)).toBe(source);
    expect(plainTextToRichContent(source).contentText).toBe(
      'Item\tOwner\tStatus\nOutline | review\tMe\tDone\nReview\tTeam\tNext',
    );
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

  it('indexes image names for search and copy without breaking plain-mode restore', () => {
    const backup = JSON.stringify({
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: 'data:image/png;base64,AAAA', alt: 'Field sketch' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'Beside the photo' }] },
      ],
    });
    const plain = convertEditorContent(backup, 'rich', 'plain');

    expect(plain.content).toBe('Beside the photo');
    expect(plain.contentText).toBe('Field sketch\nBeside the photo');
    expect(richContentToPlainText(backup)).toBe('Beside the photo');
    expect(richContentToClipboardText(backup)).toBe('Beside the photo\n\nField sketch');

    const restored = restoreRichContentFromPlain(plain.content, backup, false);
    expect(JSON.parse(restored.content).content[0].type).toBe('image');
    expect(JSON.parse(restored.content).content[0].attrs.alt).toBe('Field sketch');
  });

  it('names an image-only note from the picture instead of leaving it blank', () => {
    const backup = JSON.stringify({
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: 'data:image/png;base64,AAAA' } },
      ],
    });

    expect(richContentToContentText(backup)).toBe('Image');
    expect(richContentToClipboardText(backup)).toBe('Image');
    expect(richContentToPlainText(backup)).toBe('');
  });

  it('turns multiline table cells back into line breaks, including after an edit', () => {
    const source = [
      '| Note | line1<br>line2 |',
      '| --- | --- |',
      '| A | B |',
    ].join('\n');
    const document = plainTextToRichDocument(source);
    const headerCell = document.content[0].content?.[0].content?.[1];
    expect(headerCell?.content?.[0].content?.map(node => (
      node.type === 'hardBreak' ? '\n' : node.text
    )).join('')).toBe('line1\nline2');
    expect(richDocumentToPlainText(document)).toBe(source);

    const edited = source.replace('| A | B |', '| A | C |');
    const restored = JSON.parse(restoreRichContentFromPlain(edited, JSON.stringify(document), true).content) as typeof document;
    const restoredCell = restored.content[0].content?.[0].content?.[1];
    expect(restoredCell?.content?.[0].content?.some(node => node.type === 'hardBreak')).toBe(true);
    expect(richDocumentToPlainText(restored)).toBe(edited);
  });

  it('keeps a literal br tag in a table cell distinct from a line break', () => {
    const document = {
      type: 'doc' as const,
      content: [{
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableHeader',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }],
              },
              {
                type: 'tableHeader',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'use <br> here' }] }],
              },
            ],
          },
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }],
              },
              {
                type: 'tableCell',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'C' }] }],
              },
            ],
          },
        ],
      }],
    };
    const plain = richDocumentToPlainText(document);
    expect(plain).toContain('use \\<br> here');
    const roundTrip = plainTextToRichDocument(plain);
    const cell = roundTrip.content[0].content?.[0].content?.[1];
    expect(cell?.content?.[0].content?.map(node => node.text).join('')).toBe('use <br> here');
    expect(cell?.content?.[0].content?.some(node => node.type === 'hardBreak')).toBe(false);
  });

  it('keeps embedded images when the plain text around them changes', () => {
    const backup = JSON.stringify({
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: 'data:image/png;base64,AAAA', alt: 'Field sketch' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'Beside the photo' }] },
      ],
    });

    const restored = JSON.parse(restoreRichContentFromPlain('Beside the photo!', backup, false).content);
    expect(restored.content.map((node: { type: string }) => node.type)).toEqual(['image', 'paragraph']);
    expect(restored.content[0].attrs.src).toBe('data:image/png;base64,AAAA');
    expect(restored.content[0].attrs.alt).toBe('Field sketch');
    expect(restored.content[1].content[0].text).toBe('Beside the photo!');
  });

  it('keeps pictures when an image-only note gains a caption', () => {
    const backup = JSON.stringify({
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: 'data:image/png;base64,AAAA', alt: 'Field sketch' } },
      ],
    });

    const restored = JSON.parse(restoreRichContentFromPlain('Caption', backup, false).content);
    expect(restored.content[0].type).toBe('image');
    expect(restored.content[0].attrs.src).toBe('data:image/png;base64,AAAA');
    expect(restored.content[1].content[0].text).toBe('Caption');
  });

  it('keeps nested lists and text marks when a plain-text typo is fixed', () => {
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
    const plain = richContentToPlainText(backup);
    expect(plain).toBe('Styled thought\n\n- Parent\n  - Child');

    const restored = JSON.parse(restoreRichContentFromPlain(
      plain.replace('Styled thought', 'Styled thoughts').replace('Child', 'Child!'),
      backup,
      false,
    ).content);
    expect(restored.content[0].attrs).toEqual({ textAlign: 'center' });
    expect(restored.content[0].content[0].text).toBe('Styled thoughts');
    expect(restored.content[0].content[0].marks).toHaveLength(2);
    expect(restored.content[1].content[0].content[1].type).toBe('bulletList');
    expect(restored.content[1].content[0].content[1].content[0].content[0].content[0].text).toBe('Child!');
  });

  it('drops remote image URLs when reading stored JSON', () => {
    const document = parseRichContent(JSON.stringify({
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: 'https://tracker.example/px.png', alt: 'Remote' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] },
      ],
    }));

    expect(JSON.stringify(document)).not.toContain('http');
    expect(document.content.some(node => node.type === 'image')).toBe(false);
    expect(document.content[0].content?.[0].text).toBe('Hi');
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
