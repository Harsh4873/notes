export type EditorFormat = 'rich' | 'plain';

export interface RichTextMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface RichTextNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: RichTextNode[];
  marks?: RichTextMark[];
  text?: string;
}

export interface RichTextDocument extends RichTextNode {
  type: 'doc';
  content: RichTextNode[];
}

export interface EditorContentValue {
  content: string;
  contentText: string;
  format: EditorFormat;
  /** Exact rich document retained while a note is viewed or edited as plain text. */
  richBackup?: string;
}

const paragraph = (content: RichTextNode[] = []): RichTextNode => ({
  type: 'paragraph',
  ...(content.length ? { content } : {}),
});

const textNode = (text: string, marks?: RichTextMark[]): RichTextNode => ({
  type: 'text',
  text,
  ...(marks?.length ? { marks } : {}),
});

export const emptyRichDocument = (): RichTextDocument => ({
  type: 'doc',
  content: [paragraph()],
});

const normalizePlainText = (value: string): string =>
  value.replace(/\r\n?/g, '\n').replace(/\u0000/g, '');

export const normalizeLinkHref = (value: string): string | null => {
  const href = value.trim();

  if (!href || /[\u0000-\u001f\u007f]/.test(href)) {
    return null;
  }

  if (/^(?:https?:\/\/|mailto:|tel:|#|\/)/i.test(href)) {
    return href;
  }

  if (/^[a-z][a-z\d+.-]*:/i.test(href)) {
    return null;
  }

  return `https://${href}`;
};

const marksKey = (marks: RichTextMark[] | undefined): string =>
  JSON.stringify(marks ?? []);

const mergeAdjacentTextNodes = (nodes: RichTextNode[]): RichTextNode[] => {
  const merged: RichTextNode[] = [];

  for (const node of nodes) {
    const previous = merged.at(-1);
    if (
      node.type === 'text' &&
      previous?.type === 'text' &&
      marksKey(node.marks) === marksKey(previous.marks)
    ) {
      previous.text = `${previous.text ?? ''}${node.text ?? ''}`;
    } else {
      merged.push(node);
    }
  }

  return merged;
};

/**
 * Parses a deliberately small, predictable Markdown subset. This is used for
 * smart paste and mode conversion, not as a general-purpose Markdown parser.
 */
const parseInline = (
  value: string,
  inheritedMarks: RichTextMark[] = [],
  depth = 0,
): RichTextNode[] => {
  if (!value) {
    return [];
  }

  if (depth > 5) {
    return [textNode(value, inheritedMarks)];
  }

  const tokenPattern =
    /\[([^\]\n]+)\]\(([^)\s]+)\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|(^|[^\w])\*([^*\n]+)\*(?!\w)|(^|[^\w])_([^_\n]+)_(?!\w)/g;
  const nodes: RichTextNode[] = [];
  let cursor = 0;

  for (const match of value.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    const leadingBoundary = match[7] ?? match[9] ?? '';
    const tokenIndex = index + leadingBoundary.length;

    if (tokenIndex > cursor) {
      nodes.push(textNode(value.slice(cursor, tokenIndex), inheritedMarks));
    }

    if (match[1] !== undefined) {
      const href = normalizeLinkHref(match[2]);
      if (href) {
        nodes.push(
          ...parseInline(
            match[1],
            [...inheritedMarks, { type: 'link', attrs: { href } }],
            depth + 1,
          ),
        );
      } else {
        nodes.push(textNode(match[0], inheritedMarks));
      }
    } else if (match[3] !== undefined) {
      nodes.push(textNode(match[3], [...inheritedMarks, { type: 'code' }]));
    } else if (match[4] !== undefined || match[5] !== undefined) {
      nodes.push(
        ...parseInline(
          match[4] ?? match[5],
          [...inheritedMarks, { type: 'bold' }],
          depth + 1,
        ),
      );
    } else if (match[6] !== undefined) {
      nodes.push(
        ...parseInline(
          match[6],
          [...inheritedMarks, { type: 'strike' }],
          depth + 1,
        ),
      );
    } else {
      nodes.push(
        ...parseInline(
          match[8] ?? match[10],
          [...inheritedMarks, { type: 'italic' }],
          depth + 1,
        ),
      );
    }

    cursor = index + match[0].length;
  }

  if (cursor < value.length) {
    nodes.push(textNode(value.slice(cursor), inheritedMarks));
  }

  return mergeAdjacentTextNodes(nodes);
};

const paragraphFromLines = (lines: string[]): RichTextNode => {
  const content: RichTextNode[] = [];

  lines.forEach((line, index) => {
    if (index > 0) {
      content.push({ type: 'hardBreak' });
    }
    content.push(...parseInline(line));
  });

  return paragraph(content);
};

const headingPattern = /^\s{0,3}(#{1,3})\s+(.+?)\s*$/;
const taskPattern = /^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/;
const bulletPattern = /^\s*[-*+]\s+(.+)$/;
const orderedPattern = /^\s*(\d+)[.)]\s+(.+)$/;
const quotePattern = /^\s*>\s?(.*)$/;
const fencePattern = /^\s*```(?:[\w+-]+)?\s*$/;
const dividerPattern = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const tableDividerCellPattern = /^:?-{3,}:?$/;

const splitMarkdownTableRow = (line: string): string[] => {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return [];
  let withoutEdges = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  if (withoutEdges.endsWith('|') && !withoutEdges.endsWith('\\|')) {
    withoutEdges = withoutEdges.slice(0, -1);
  }
  const cells: string[] = [];
  let current = '';

  for (let index = 0; index < withoutEdges.length; index += 1) {
    const character = withoutEdges[index];
    if (character === '\\' && withoutEdges[index + 1] === '|') {
      current += '|';
      index += 1;
    } else if (character === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  return cells;
};

const isMarkdownTableStart = (lines: string[], index: number): boolean => {
  const cells = splitMarkdownTableRow(lines[index] ?? '');
  const dividers = splitMarkdownTableRow(lines[index + 1] ?? '');
  return cells.length >= 2
    && dividers.length === cells.length
    && dividers.every(cell => tableDividerCellPattern.test(cell.replace(/\s+/g, '')));
};

const tableCell = (value: string, header = false): RichTextNode => ({
  type: header ? 'tableHeader' : 'tableCell',
  content: [paragraph(parseInline(value))],
});

const isRecognizedBlockStart = (line: string): boolean =>
  headingPattern.test(line) ||
  taskPattern.test(line) ||
  bulletPattern.test(line) ||
  orderedPattern.test(line) ||
  quotePattern.test(line) ||
  fencePattern.test(line) ||
  dividerPattern.test(line);

/** Returns true only when the text contains explicit block-formatting syntax. */
export const looksLikeStructuredText = (value: string): boolean => {
  const text = normalizePlainText(value);
  const lines = text.split('\n');
  const hasFencePair = lines.filter(line => fencePattern.test(line)).length >= 2;
  const hasTable = lines.some((_, index) => isMarkdownTableStart(lines, index));

  return (
    hasFencePair ||
    hasTable ||
    lines.some(
      line =>
        headingPattern.test(line) ||
        taskPattern.test(line) ||
        bulletPattern.test(line) ||
        orderedPattern.test(line) ||
        quotePattern.test(line) ||
        dividerPattern.test(line),
    )
  );
};

/**
 * Converts phone-friendly plain text or Markdown-style text into Tiptap JSON.
 * Unrecognized text remains ordinary paragraphs, so smart paste is lossless.
 */
export const plainTextToRichDocument = (value: string): RichTextDocument => {
  const text = normalizePlainText(value);
  if (!text.trim()) {
    return emptyRichDocument();
  }

  const lines = text.split('\n');
  const content: RichTextNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      const headings = splitMarkdownTableRow(line);
      const rows: RichTextNode[] = [{
        type: 'tableRow',
        content: headings.map(value => tableCell(value, true)),
      }];
      index += 2;

      while (index < lines.length && lines[index].trim()) {
        const values = splitMarkdownTableRow(lines[index]);
        if (!values.length) break;
        rows.push({
          type: 'tableRow',
          content: headings.map((_, cellIndex) => tableCell(values[cellIndex] ?? '')),
        });
        index += 1;
      }

      content.push({ type: 'table', content: rows });
      continue;
    }

    const fence = line.match(fencePattern);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !fencePattern.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      const code = codeLines.join('\n');
      content.push({
        type: 'codeBlock',
        ...(code ? { content: [textNode(code)] } : {}),
      });
      continue;
    }

    const heading = line.match(headingPattern);
    if (heading) {
      content.push({
        type: 'heading',
        attrs: { level: heading[1].length },
        content: parseInline(heading[2]),
      });
      index += 1;
      continue;
    }

    if (dividerPattern.test(line)) {
      content.push({ type: 'horizontalRule' });
      index += 1;
      continue;
    }

    const task = line.match(taskPattern);
    if (task) {
      const items: RichTextNode[] = [];
      while (index < lines.length) {
        const item = lines[index].match(taskPattern);
        if (!item) {
          break;
        }
        items.push({
          type: 'taskItem',
          attrs: { checked: item[1].toLowerCase() === 'x' },
          content: [paragraph(parseInline(item[2]))],
        });
        index += 1;
      }
      content.push({ type: 'taskList', content: items });
      continue;
    }

    const bullet = line.match(bulletPattern);
    if (bullet) {
      const items: RichTextNode[] = [];
      while (index < lines.length) {
        const item = lines[index].match(bulletPattern);
        if (!item || taskPattern.test(lines[index])) {
          break;
        }
        items.push({
          type: 'listItem',
          content: [paragraph(parseInline(item[1]))],
        });
        index += 1;
      }
      content.push({ type: 'bulletList', content: items });
      continue;
    }

    const ordered = line.match(orderedPattern);
    if (ordered) {
      const items: RichTextNode[] = [];
      const start = Number(ordered[1]);
      while (index < lines.length) {
        const item = lines[index].match(orderedPattern);
        if (!item) {
          break;
        }
        items.push({
          type: 'listItem',
          content: [paragraph(parseInline(item[2]))],
        });
        index += 1;
      }
      content.push({
        type: 'orderedList',
        attrs: { start: Number.isSafeInteger(start) && start > 0 ? start : 1 },
        content: items,
      });
      continue;
    }

    const quote = line.match(quotePattern);
    if (quote) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const quotedLine = lines[index].match(quotePattern);
        if (!quotedLine) {
          break;
        }
        quoteLines.push(quotedLine[1]);
        index += 1;
      }
      content.push({
        type: 'blockquote',
        content: [paragraphFromLines(quoteLines)],
      });
      continue;
    }

    const proseLines: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !isMarkdownTableStart(lines, index) &&
      !isRecognizedBlockStart(lines[index])
    ) {
      proseLines.push(lines[index]);
      index += 1;
    }
    content.push(paragraphFromLines(proseLines.length ? proseLines : [line]));
    if (!proseLines.length) {
      index += 1;
    }
  }

  return { type: 'doc', content: content.length ? content : [paragraph()] };
};

/** Converts text without interpreting Markdown-style formatting markers. */
export const plainTextToBasicRichDocument = (value: string): RichTextDocument => {
  const text = normalizePlainText(value);
  if (!text.trim()) {
    return emptyRichDocument();
  }

  const content = text.split(/\n\s*\n/).map(block => {
    const nodes: RichTextNode[] = [];
    block.split('\n').forEach((line, index) => {
      if (index > 0) {
        nodes.push({ type: 'hardBreak' });
      }
      const literal = line.replace(/\s+$/g, '');
      if (literal) {
        nodes.push(textNode(literal));
      }
    });
    return paragraph(nodes);
  });
  return { type: 'doc', content };
};

const isRichTextNode = (value: unknown): value is RichTextNode => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const node = value as Partial<RichTextNode>;
  if (typeof node.type !== 'string') {
    return false;
  }

  if (node.text !== undefined && typeof node.text !== 'string') {
    return false;
  }

  return node.content === undefined ||
    (Array.isArray(node.content) && node.content.every(isRichTextNode));
};

export const isRichTextDocument = (value: unknown): value is RichTextDocument =>
  isRichTextNode(value) &&
  value.type === 'doc' &&
  Array.isArray(value.content);

/** Safely reads stored Tiptap JSON and preserves legacy plain content. */
export const parseRichContent = (value: string): RichTextDocument => {
  if (!value.trim()) {
    return emptyRichDocument();
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (isRichTextDocument(parsed)) {
      return parsed.content.length ? parsed : emptyRichDocument();
    }
  } catch {
    // Existing plain notes are intentionally upgraded instead of discarded.
  }

  return plainTextToRichDocument(value);
};

export const serializeRichDocument = (document: RichTextDocument): string =>
  JSON.stringify(document);

const serializeInlineNode = (node: RichTextNode): string => {
  if (node.type === 'hardBreak') {
    return '\n';
  }

  if (node.type !== 'text') {
    return (node.content ?? []).map(serializeInlineNode).join('');
  }

  let value = node.text ?? '';
  const marks = node.marks ?? [];

  if (marks.some(mark => mark.type === 'code')) {
    value = `\`${value}\``;
  }
  if (marks.some(mark => mark.type === 'bold')) {
    value = `**${value}**`;
  }
  if (marks.some(mark => mark.type === 'italic')) {
    value = `_${value}_`;
  }
  if (marks.some(mark => mark.type === 'strike')) {
    value = `~~${value}~~`;
  }

  const link = marks.find(mark => mark.type === 'link');
  const href =
    typeof link?.attrs?.href === 'string'
      ? normalizeLinkHref(link.attrs.href)
      : null;
  if (href) {
    value = `[${value}](${href})`;
  }

  return value;
};

const serializeListItemBody = (node: RichTextNode): string[] => {
  const parts = (node.content ?? []).map(child => serializeBlockNode(child));
  return parts.flatMap(part => part.split('\n'));
};

const indentContinuation = (lines: string[], prefix: string): string => {
  if (!lines.length) {
    return prefix.trimEnd();
  }
  return [
    `${prefix}${lines[0]}`,
    ...lines.slice(1).map(line => `${' '.repeat(prefix.length)}${line}`),
  ].join('\n');
};

const serializeBlockNode = (node: RichTextNode): string => {
  switch (node.type) {
    case 'paragraph':
      return (node.content ?? []).map(serializeInlineNode).join('');
    case 'heading': {
      const level = Math.min(3, Math.max(1, Number(node.attrs?.level) || 1));
      return `${'#'.repeat(level)} ${(node.content ?? []).map(serializeInlineNode).join('')}`;
    }
    case 'bulletList':
      return (node.content ?? [])
        .map(item => indentContinuation(serializeListItemBody(item), '- '))
        .join('\n');
    case 'orderedList': {
      const start = Math.max(1, Number(node.attrs?.start) || 1);
      return (node.content ?? [])
        .map((item, index) =>
          indentContinuation(serializeListItemBody(item), `${start + index}. `),
        )
        .join('\n');
    }
    case 'taskList':
      return (node.content ?? [])
        .map(item =>
          indentContinuation(
            serializeListItemBody(item),
            `- [${item.attrs?.checked ? 'x' : ' '}] `,
          ),
        )
        .join('\n');
    case 'blockquote':
      return (node.content ?? [])
        .map(serializeBlockNode)
        .join('\n')
        .split('\n')
        .map(line => `> ${line}`.trimEnd())
        .join('\n');
    case 'codeBlock':
      return `\`\`\`\n${(node.content ?? []).map(child => child.text ?? '').join('')}\n\`\`\``;
    case 'horizontalRule':
      return '---';
    case 'table': {
      const rows = (node.content ?? []).map(row => (row.content ?? []).map(cell =>
        (cell.content ?? [])
          .map(serializeBlockNode)
          .join('<br>')
          .replace(/\|/g, '\\|')
          .replace(/\n/g, '<br>'),
      ));
      if (!rows.length) return '';
      const width = Math.max(2, ...rows.map(row => row.length));
      const normalized = rows.map(row => Array.from({ length: width }, (_, index) => row[index] ?? ''));
      const firstRowIsHeader = (node.content?.[0]?.content ?? []).every(cell => cell.type === 'tableHeader');
      const header = firstRowIsHeader ? normalized[0] : Array.from({ length: width }, () => '');
      const body = firstRowIsHeader ? normalized.slice(1) : normalized;
      return [
        `| ${header.join(' | ')} |`,
        `| ${header.map(() => '---').join(' | ')} |`,
        ...body.map(row => `| ${row.join(' | ')} |`),
      ].join('\n');
    }
    case 'listItem':
    case 'taskItem':
      return serializeListItemBody(node).join('\n');
    default:
      return (node.content ?? []).map(serializeBlockNode).join('\n');
  }
};

/** Plain mode uses readable Markdown-style markers so block structure survives. */
export const richDocumentToPlainText = (document: RichTextDocument): string =>
  document.content.map(serializeBlockNode).join('\n\n').trim();

export const richContentToPlainText = (content: string): string =>
  richDocumentToPlainText(parseRichContent(content));

const collectReadableText = (node: RichTextNode): string => {
  if (node.type === 'text') {
    return node.text ?? '';
  }
  if (node.type === 'hardBreak') {
    return '\n';
  }
  if (node.type === 'horizontalRule') {
    return '';
  }
  if (node.type === 'table') {
    return (node.content ?? []).map(collectReadableText).join('\n');
  }
  if (node.type === 'tableRow') {
    return (node.content ?? []).map(collectReadableText).join('\t');
  }
  if (node.type === 'tableCell' || node.type === 'tableHeader') {
    return (node.content ?? []).map(collectReadableText).join(' ');
  }

  const separator =
    node.type === 'doc' ||
    node.type === 'bulletList' ||
    node.type === 'orderedList' ||
    node.type === 'taskList' ||
    node.type === 'blockquote' ||
    node.type === 'listItem' ||
    node.type === 'taskItem'
      ? '\n'
      : '';

  return (node.content ?? []).map(collectReadableText).join(separator);
};

export const richDocumentToContentText = (document: RichTextDocument): string =>
  collectReadableText(document).replace(/\n{3,}/g, '\n\n').trim();

export const richContentToContentText = (content: string): string =>
  richDocumentToContentText(parseRichContent(content));

export const plainTextToRichContent = (
  text: string,
  smartFormatting = true,
): { content: string; contentText: string } => {
  const document = smartFormatting
    ? plainTextToRichDocument(text)
    : plainTextToBasicRichDocument(text);
  return {
    content: serializeRichDocument(document),
    contentText: richDocumentToContentText(document),
  };
};

/**
 * Restores the exact rich document when plain text was only a view change.
 * Once the plain text itself changes, conversion intentionally follows the
 * current smart-formatting preference and clears the stale backup.
 */
export const restoreRichContentFromPlain = (
  text: string,
  richBackup: string,
  smartFormatting = true,
): EditorContentValue => {
  const normalized = normalizePlainText(text);
  if (richBackup) {
    const backupDocument = parseRichContent(richBackup);
    if (richDocumentToPlainText(backupDocument) === normalized) {
      return {
        content: serializeRichDocument(backupDocument),
        contentText: richDocumentToContentText(backupDocument),
        format: 'rich',
        richBackup: '',
      };
    }
  }

  return {
    ...plainTextToRichContent(normalized, smartFormatting),
    format: 'rich',
    richBackup: '',
  };
};

export const convertEditorContent = (
  content: string,
  from: EditorFormat,
  to: EditorFormat,
): EditorContentValue => {
  if (to === 'rich') {
    const document =
      from === 'rich' ? parseRichContent(content) : plainTextToRichDocument(content);
    return {
      content: serializeRichDocument(document),
      contentText: richDocumentToContentText(document),
      format: 'rich',
    };
  }

  if (from === 'rich') {
    const document = parseRichContent(content);
    return {
      content: richDocumentToPlainText(document),
      contentText: richDocumentToContentText(document),
      format: 'plain',
    };
  }

  const normalized = normalizePlainText(content);
  return {
    content: normalized,
    contentText: normalized.trim(),
    format: 'plain',
  };
};
