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

/** Table cells store line breaks as `<br>`. A backslash keeps a literal tag. */
const decodeTableCellLines = (value: string): string[] => {
  const lines: string[] = [];
  let current = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value.startsWith('\\<br>', index)) {
      current += '<br>';
      index += '\\<br>'.length - 1;
    } else if (value.startsWith('<br>', index)) {
      lines.push(current);
      current = '';
      index += '<br>'.length - 1;
    } else {
      current += value[index];
    }
  }
  lines.push(current);
  return lines;
};

const tableCell = (value: string, header = false): RichTextNode => ({
  type: header ? 'tableHeader' : 'tableCell',
  content: [paragraphFromLines(decodeTableCellLines(value))],
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
const isEmbeddedImageSrc = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('data:image/');

/** Remote image URLs are tracking pixels. Paste already rejects them. */
function stripRemoteImages<T extends RichTextNode>(node: T): T {
  if (!node.content) return node;
  let changed = false;
  const content: RichTextNode[] = [];
  for (const child of node.content) {
    if (child.type === 'image' && !isEmbeddedImageSrc(child.attrs?.src)) {
      changed = true;
      continue;
    }
    const next = stripRemoteImages(child);
    if (next !== child) changed = true;
    content.push(next);
  }
  if (!changed) return node;
  return { ...node, content };
}

export const parseRichContent = (value: string): RichTextDocument => {
  if (!value.trim()) {
    return emptyRichDocument();
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (isRichTextDocument(parsed)) {
      const sanitized = stripRemoteImages(parsed);
      return sanitized.content.length ? sanitized : emptyRichDocument();
    }
  } catch {
    // Existing plain notes are intentionally upgraded instead of discarded.
  }

  return plainTextToRichDocument(value);
};

export const serializeRichDocument = (document: RichTextDocument): string =>
  JSON.stringify(document);

interface PlainSyntaxSegment {
  kind: 'syntax';
  text: string;
}

interface PlainTextSegment {
  kind: 'text';
  text: string;
  path: number[];
  offset: number;
}

interface PlainImageSegment {
  kind: 'image';
  node: RichTextNode;
}

type PlainSegment = PlainSyntaxSegment | PlainTextSegment | PlainImageSegment;

const syntax = (text: string): PlainSegment[] =>
  (text ? [{ kind: 'syntax', text }] : []);

const segmentText = (segments: PlainSegment[]): string => {
  let text = '';
  for (const segment of segments) {
    if (segment.kind !== 'image') text += segment.text;
  }
  return text;
};

const joinSegments = (groups: PlainSegment[][], separator: string): PlainSegment[] => {
  const result: PlainSegment[] = [];
  groups.forEach((group, index) => {
    if (index > 0 && separator) result.push(...syntax(separator));
    result.push(...group);
  });
  return result;
};

const imageSegment = (node: RichTextNode): PlainSegment[] => {
  if (!isEmbeddedImageSrc(node.attrs?.src)) return [];
  return [{ kind: 'image', node }];
};

const serializeInlineSegments = (node: RichTextNode, path: number[]): PlainSegment[] => {
  if (node.type === 'image') return imageSegment(node);
  if (node.type === 'hardBreak') return syntax('\n');
  if (node.type !== 'text') {
    return (node.content ?? []).flatMap((child, index) =>
      serializeInlineSegments(child, [...path, index]));
  }

  let segments: PlainSegment[] = [{
    kind: 'text',
    text: node.text ?? '',
    path,
    offset: 0,
  }];
  const marks = node.marks ?? [];
  const wrap = (before: string, after: string) => {
    segments = [...syntax(before), ...segments, ...syntax(after)];
  };
  if (marks.some(mark => mark.type === 'code')) wrap('`', '`');
  if (marks.some(mark => mark.type === 'bold')) wrap('**', '**');
  if (marks.some(mark => mark.type === 'italic')) wrap('_', '_');
  if (marks.some(mark => mark.type === 'strike')) wrap('~~', '~~');

  const link = marks.find(mark => mark.type === 'link');
  const href = typeof link?.attrs?.href === 'string'
    ? normalizeLinkHref(link.attrs.href)
    : null;
  if (href) wrap('[', `](${href})`);
  return segments;
};

const segmentsToLines = (segments: PlainSegment[]): PlainSegment[][] => {
  const lines: PlainSegment[][] = [[]];
  for (const segment of segments) {
    if (segment.kind === 'image') {
      lines[lines.length - 1].push(segment);
      continue;
    }
    const parts = segment.text.split('\n');
    let consumed = 0;
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (segment.kind === 'text') {
        if (part) {
          lines[lines.length - 1].push({
            kind: 'text',
            text: part,
            path: segment.path,
            offset: segment.offset + consumed,
          });
        }
        consumed += part.length + (index < parts.length - 1 ? 1 : 0);
      } else if (part) {
        lines[lines.length - 1].push({ kind: 'syntax', text: part });
      }
    });
  }
  return lines;
};

const trimEndSegments = (segments: PlainSegment[]): PlainSegment[] => {
  let end = segments.length;
  while (end > 0 && segments[end - 1].kind === 'image') end -= 1;
  const result = segments.slice(0, end);
  while (result.length > 0) {
    const last = result[result.length - 1];
    if (last.kind === 'image') break;
    const trimmed = last.text.trimEnd();
    if (trimmed === last.text) break;
    if (!trimmed) {
      result.pop();
      continue;
    }
    result[result.length - 1] = last.kind === 'syntax'
      ? { kind: 'syntax', text: trimmed }
      : { ...last, text: trimmed };
    break;
  }
  return [...result, ...segments.slice(end)];
};

const indentLineSegments = (lines: PlainSegment[][], prefix: string): PlainSegment[] => {
  if (lines.length === 0) return syntax(prefix.trimEnd());
  const indent = ' '.repeat(prefix.length);
  return joinSegments(lines.map((line, index) => [
    ...syntax(index === 0 ? prefix : indent),
    ...line,
  ]), '\n');
};

const listItemLines = (node: RichTextNode, path: number[]): PlainSegment[][] => {
  const lines: PlainSegment[][] = [];
  (node.content ?? []).forEach((child, index) => {
    lines.push(...segmentsToLines(serializeBlockSegments(child, [...path, index])));
  });
  return lines;
};

const escapeLiteralBreakTags = (segments: PlainSegment[]): PlainSegment[] => {
  const result: PlainSegment[] = [];
  for (const segment of segments) {
    if (segment.kind !== 'text' || !segment.text.includes('<br>')) {
      result.push(segment);
      continue;
    }
    const parts = segment.text.split('<br>');
    let local = 0;
    parts.forEach((part, index) => {
      if (part) {
        result.push({
          kind: 'text',
          text: part,
          path: segment.path,
          offset: segment.offset + local,
        });
        local += part.length;
      }
      if (index < parts.length - 1) {
        result.push({ kind: 'syntax', text: '\\<br>' });
        local += '<br>'.length;
      }
    });
  }
  return result;
};

const escapePipesAndNewlines = (segments: PlainSegment[]): PlainSegment[] => {
  const result: PlainSegment[] = [];
  for (const segment of segments) {
    if (segment.kind === 'image') {
      result.push(segment);
      continue;
    }
    const pieces = segment.text.split(/(\||\n)/);
    let local = 0;
    for (const piece of pieces) {
      if (!piece) continue;
      if (piece === '|') {
        result.push({ kind: 'syntax', text: '\\|' });
        if (segment.kind === 'text') local += 1;
      } else if (piece === '\n') {
        result.push({ kind: 'syntax', text: '<br>' });
        if (segment.kind === 'text') local += 1;
      } else if (segment.kind === 'syntax') {
        result.push({ kind: 'syntax', text: piece });
      } else {
        result.push({
          kind: 'text',
          text: piece,
          path: segment.path,
          offset: segment.offset + local,
        });
        local += piece.length;
      }
    }
  }
  return result;
};

const serializeTableCell = (cell: RichTextNode, cellPath: number[]): PlainSegment[] => {
  const blocks = (cell.content ?? []).map((block, index) =>
    escapeLiteralBreakTags(serializeBlockSegments(block, [...cellPath, index])));
  return escapePipesAndNewlines(joinSegments(blocks, '<br>'));
};

const pipeRow = (cells: PlainSegment[][]): PlainSegment[] => {
  const result: PlainSegment[] = [...syntax('| ')];
  cells.forEach((cell, index) => {
    if (index > 0) result.push(...syntax(' | '));
    result.push(...cell);
  });
  result.push(...syntax(' |'));
  return result;
};

function serializeBlockSegments(node: RichTextNode, path: number[]): PlainSegment[] {
  switch (node.type) {
    case 'paragraph':
      return (node.content ?? []).flatMap((child, index) =>
        serializeInlineSegments(child, [...path, index]));
    case 'heading': {
      const level = Math.min(3, Math.max(1, Number(node.attrs?.level) || 1));
      const inline = (node.content ?? []).flatMap((child, index) =>
        serializeInlineSegments(child, [...path, index]));
      return [...syntax(`${'#'.repeat(level)} `), ...inline];
    }
    case 'bulletList':
      return joinSegments(
        (node.content ?? []).map((item, index) =>
          indentLineSegments(listItemLines(item, [...path, index]), '- ')),
        '\n',
      );
    case 'orderedList': {
      const start = Math.max(1, Number(node.attrs?.start) || 1);
      return joinSegments(
        (node.content ?? []).map((item, index) =>
          indentLineSegments(listItemLines(item, [...path, index]), `${start + index}. `)),
        '\n',
      );
    }
    case 'taskList':
      return joinSegments(
        (node.content ?? []).map((item, index) =>
          indentLineSegments(
            listItemLines(item, [...path, index]),
            `- [${item.attrs?.checked ? 'x' : ' '}] `,
          )),
        '\n',
      );
    case 'blockquote': {
      const inner = joinSegments(
        (node.content ?? []).map((child, index) => serializeBlockSegments(child, [...path, index])),
        '\n',
      );
      return joinSegments(
        segmentsToLines(inner).map(line => trimEndSegments([...syntax('> '), ...line])),
        '\n',
      );
    }
    case 'codeBlock': {
      const body = (node.content ?? []).flatMap((child, index) => (
        child.type === 'text'
          ? [{ kind: 'text' as const, text: child.text ?? '', path: [...path, index], offset: 0 }]
          : serializeInlineSegments(child, [...path, index])
      ));
      return [...syntax('```\n'), ...body, ...syntax('\n```')];
    }
    case 'horizontalRule':
      return syntax('---');
    case 'image':
      return imageSegment(node);
    case 'table': {
      const rowNodes = node.content ?? [];
      const matrix = rowNodes.map((row, rowIndex) =>
        (row.content ?? []).map((cell, cellIndex) =>
          serializeTableCell(cell, [...path, rowIndex, cellIndex])));
      if (!matrix.length) return [];
      const width = Math.max(2, ...matrix.map(row => row.length));
      const normalized = matrix.map(row => Array.from({ length: width }, (_, index) => row[index] ?? []));
      const firstRowIsHeader = (rowNodes[0]?.content ?? []).every(cell => cell.type === 'tableHeader');
      const header = firstRowIsHeader
        ? normalized[0]
        : Array.from({ length: width }, () => [] as PlainSegment[]);
      const body = firstRowIsHeader ? normalized.slice(1) : normalized;
      const divider = syntax(`| ${Array.from({ length: width }, () => '---').join(' | ')} |`);
      return joinSegments([pipeRow(header), divider, ...body.map(row => pipeRow(row))], '\n');
    }
    case 'listItem':
    case 'taskItem':
      return joinSegments(listItemLines(node, path), '\n');
    default:
      return joinSegments(
        (node.content ?? []).map((child, index) => serializeBlockSegments(child, [...path, index])),
        '\n',
      );
  }
}

const serializeBlockNode = (node: RichTextNode): string =>
  segmentText(serializeBlockSegments(node, []));

/** Plain mode uses readable Markdown-style markers so block structure survives. */
export const richDocumentToPlainText = (document: RichTextDocument): string =>
  document.content.map(node => serializeBlockNode(node)).join('\n\n').trim();

interface PlacedText {
  plainStart: number;
  plainEnd: number;
  path: number[];
  offset: number;
}

interface TextHunk {
  oldStart: number;
  oldEnd: number;
  newText: string;
}

interface TextReplacement {
  path: number[];
  offset: number;
  deleteCount: number;
  insert: string;
}

interface PlainLayout {
  text: string;
  segments: PlainSegment[];
  images: Array<{ offset: number; node: RichTextNode }>;
}

const slicePlainSegments = (
  segments: PlainSegment[],
  start: number,
  end: number,
): PlainSegment[] => {
  const result: PlainSegment[] = [];
  let cursor = 0;
  for (const segment of segments) {
    if (segment.kind === 'image') continue;
    const segStart = cursor;
    const segEnd = cursor + segment.text.length;
    cursor = segEnd;
    if (segEnd <= start || segStart >= end) continue;
    const from = Math.max(0, start - segStart);
    const to = Math.min(segment.text.length, end - segStart);
    const text = segment.text.slice(from, to);
    if (!text) continue;
    if (segment.kind === 'syntax') result.push({ kind: 'syntax', text });
    else result.push({ ...segment, text, offset: segment.offset + from });
  }
  return result;
};

const layoutPlain = (document: RichTextDocument): PlainLayout => {
  const full = joinSegments(
    document.content.map((node, index) => serializeBlockSegments(node, [index])),
    '\n\n',
  );
  const raw = segmentText(full);
  const trimmed = raw.trim();
  const start = raw.length - raw.trimStart().length;
  const images: PlainLayout['images'] = [];
  let cursor = 0;
  for (const segment of full) {
    if (segment.kind === 'image') {
      images.push({
        offset: Math.max(0, Math.min(trimmed.length, cursor - start)),
        node: structuredClone(segment.node),
      });
      continue;
    }
    cursor += segment.text.length;
  }
  return {
    text: trimmed,
    segments: slicePlainSegments(full, start, start + trimmed.length),
    images,
  };
};

const sharedPrefixLength = (left: string, right: string): number => {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return index;
};

const longestSharedPiece = (
  left: string,
  right: string,
): { oldIndex: number; newIndex: number; length: number } | null => {
  if (!left || !right || left.length * right.length > 1_000_000) return null;
  let best = 0;
  let bestOld = 0;
  let bestNew = 0;
  const row = new Uint32Array(right.length + 1);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= right.length; j += 1) {
      const nextDiagonal = row[j];
      if (left.charCodeAt(i - 1) === right.charCodeAt(j - 1)) {
        const length = diagonal + 1;
        row[j] = length;
        if (length > best) {
          best = length;
          bestOld = i - length;
          bestNew = j - length;
        }
      } else {
        row[j] = 0;
      }
      diagonal = nextDiagonal;
    }
  }
  if (best < 8) return null;
  return { oldIndex: bestOld, newIndex: bestNew, length: best };
};

const splitEdits = (
  oldText: string,
  newText: string,
  oldBase: number,
  newBase: number,
  depth: number,
): TextHunk[] => {
  if (oldText === newText) return [];
  const prefix = sharedPrefixLength(oldText, newText);
  let suffix = 0;
  while (
    suffix < oldText.length - prefix
    && suffix < newText.length - prefix
    && oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)
  ) suffix += 1;
  const oldMid = oldText.slice(prefix, oldText.length - suffix);
  const newMid = newText.slice(prefix, newText.length - suffix);
  const split = depth < 6 ? longestSharedPiece(oldMid, newMid) : null;
  if (split) {
    return [
      ...splitEdits(
        oldMid.slice(0, split.oldIndex),
        newMid.slice(0, split.newIndex),
        oldBase + prefix,
        newBase + prefix,
        depth + 1,
      ),
      ...splitEdits(
        oldMid.slice(split.oldIndex + split.length),
        newMid.slice(split.newIndex + split.length),
        oldBase + prefix + split.oldIndex + split.length,
        newBase + prefix + split.newIndex + split.length,
        depth + 1,
      ),
    ];
  }
  return [{
    oldStart: oldBase + prefix,
    oldEnd: oldBase + oldText.length - suffix,
    newText: newMid,
  }];
};

const placeTextSegments = (segments: PlainSegment[]): PlacedText[] => {
  const placed: PlacedText[] = [];
  let cursor = 0;
  for (const segment of segments) {
    const start = cursor;
    if (segment.kind !== 'image') cursor += segment.text.length;
    if (segment.kind === 'text' && segment.text.length > 0) {
      placed.push({
        plainStart: start,
        plainEnd: cursor,
        path: segment.path,
        offset: segment.offset,
      });
    }
  }
  return placed;
};

const locateHunk = (
  hunk: TextHunk,
  placed: PlacedText[],
  oldPlain: string,
): TextReplacement | null => {
  const covering = placed.find(segment =>
    hunk.oldStart >= segment.plainStart && hunk.oldEnd <= segment.plainEnd);
  if (!covering) return null;
  const deleted = oldPlain.slice(hunk.oldStart, hunk.oldEnd);
  const visible = oldPlain.slice(covering.plainStart, covering.plainEnd);
  if ((deleted.includes('\n') || hunk.newText.includes('\n')) && !visible.includes('\n')) {
    return null;
  }
  return {
    path: covering.path,
    offset: covering.offset + hunk.oldStart - covering.plainStart,
    deleteCount: hunk.oldEnd - hunk.oldStart,
    insert: hunk.newText,
  };
};

const nodeAt = (root: RichTextNode, path: number[]): RichTextNode | null => {
  let current = root;
  for (const index of path) {
    const next = current.content?.[index];
    if (!next) return null;
    current = next;
  }
  return current;
};

const removeEmptyText = (node: RichTextNode) => {
  if (!node.content) return;
  node.content = node.content.filter(child => child.type !== 'text' || Boolean(child.text));
  node.content.forEach(removeEmptyText);
  if (node.content.length === 0 && node.type !== 'doc') delete node.content;
};

const applyTextReplacements = (
  document: RichTextDocument,
  replacements: TextReplacement[],
): RichTextDocument | null => {
  const clone = structuredClone(document);
  const grouped = new Map<string, TextReplacement[]>();
  for (const replacement of replacements) {
    const key = replacement.path.join('.');
    const list = grouped.get(key) ?? [];
    list.push(replacement);
    grouped.set(key, list);
  }
  for (const [key, list] of grouped) {
    const node = nodeAt(clone, key ? key.split('.').map(Number) : []);
    if (!node || node.type !== 'text' || typeof node.text !== 'string') return null;
    let text = node.text;
    const ordered = [...list].sort((left, right) => right.offset - left.offset);
    for (const replacement of ordered) {
      const end = replacement.offset + replacement.deleteCount;
      if (replacement.offset < 0 || end > text.length) return null;
      text = text.slice(0, replacement.offset) + replacement.insert + text.slice(end);
    }
    node.text = text;
  }
  removeEmptyText(clone);
  if (clone.content.length === 0) clone.content = [paragraph()];
  return clone;
};

/** Keeps marks, lists, and images when a plain-text edit stays inside existing text. */
const applyPlainTextEdit = (
  document: RichTextDocument,
  oldPlain: string,
  newPlain: string,
): RichTextDocument | null => {
  const layout = layoutPlain(document);
  if (layout.text !== oldPlain) return null;
  const replacements: TextReplacement[] = [];
  for (const hunk of splitEdits(oldPlain, newPlain, 0, 0, 0)) {
    const located = locateHunk(hunk, placeTextSegments(layout.segments), oldPlain);
    if (!located) return null;
    replacements.push(located);
  }
  if (replacements.length === 0) return null;
  const patched = applyTextReplacements(document, replacements);
  if (!patched || richDocumentToPlainText(patched) !== newPlain) return null;
  return patched;
};

const mapPlainOffset = (oldText: string, newText: string, offset: number): number => {
  const prefix = sharedPrefixLength(oldText, newText);
  let suffix = 0;
  while (
    suffix < oldText.length - prefix
    && suffix < newText.length - prefix
    && oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)
  ) suffix += 1;
  const oldMidEnd = oldText.length - suffix;
  if (offset <= prefix) return Math.min(offset, newText.length);
  if (offset >= oldMidEnd) return newText.length - (oldText.length - offset);
  const oldSpan = oldMidEnd - prefix;
  const newSpan = newText.length - suffix - prefix;
  if (oldSpan <= 0) return prefix;
  return prefix + Math.round(((offset - prefix) / oldSpan) * newSpan);
};

const placeBackupImages = (
  document: RichTextDocument,
  images: PlainLayout['images'],
  oldPlain: string,
  newPlain: string,
): RichTextDocument => {
  if (images.length === 0) return document;
  const placed = images
    .map(image => ({ node: image.node, offset: mapPlainOffset(oldPlain, newPlain, image.offset) }))
    .sort((left, right) => left.offset - right.offset);
  if (richDocumentToPlainText(document) !== newPlain) {
    return { type: 'doc', content: [...placed.map(image => image.node), ...document.content] };
  }
  const content: RichTextNode[] = [];
  let cursor = 0;
  let imageIndex = 0;
  const flush = (position: number) => {
    while (imageIndex < placed.length && placed[imageIndex].offset <= position) {
      content.push(placed[imageIndex].node);
      imageIndex += 1;
    }
  };
  document.content.forEach((block, index) => {
    flush(cursor);
    content.push(block);
    cursor += serializeBlockNode(block).length;
    if (index < document.content.length - 1) cursor += 2;
  });
  flush(Number.POSITIVE_INFINITY);
  return { type: 'doc', content: content.length ? content : [paragraph()] };
};

export const richContentToPlainText = (content: string): string =>
  richDocumentToPlainText(parseRichContent(content));

const imageAccessibleName = (node: RichTextNode): string => {
  const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt.trim() : '';
  if (alt) return alt;
  const title = typeof node.attrs?.title === 'string' ? node.attrs.title.trim() : '';
  if (title) return title;
  return 'Image';
};

const collectImageNames = (node: RichTextNode): string[] => {
  if (node.type === 'image') return [imageAccessibleName(node)];
  return (node.content ?? []).flatMap(collectImageNames);
};

/** Copy text includes picture names. Plain-mode round trip still omits embeds. */
export const richDocumentToClipboardText = (document: RichTextDocument): string => {
  const plain = richDocumentToPlainText(document);
  const images = collectImageNames(document);
  if (images.length === 0) return plain;
  const imageText = images.join('\n');
  return plain ? `${plain}\n\n${imageText}` : imageText;
};

export const richContentToClipboardText = (content: string): string =>
  richDocumentToClipboardText(parseRichContent(content));

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
  if (node.type === 'image') {
    return imageAccessibleName(node);
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

const restoredRichValue = (document: RichTextDocument): EditorContentValue => ({
  content: serializeRichDocument(document),
  contentText: richDocumentToContentText(document),
  format: 'rich',
  richBackup: '',
});

/**
 * Restores the rich document after a plain-text view.
 * An unchanged string returns the backup verbatim. Edits inside the existing
 * text keep marks, lists, tables, and images. A structural rewrite reparses
 * the text and still puts embedded images back.
 */
export const restoreRichContentFromPlain = (
  text: string,
  richBackup: string,
  smartFormatting = true,
): EditorContentValue => {
  const normalized = normalizePlainText(text);
  if (richBackup) {
    const backupDocument = parseRichContent(richBackup);
    const backupPlain = richDocumentToPlainText(backupDocument);
    if (backupPlain === normalized) return restoredRichValue(backupDocument);

    const patched = applyPlainTextEdit(backupDocument, backupPlain, normalized);
    if (patched) return restoredRichValue(patched);

    const parsed = smartFormatting
      ? plainTextToRichDocument(normalized)
      : plainTextToBasicRichDocument(normalized);
    return restoredRichValue(
      placeBackupImages(parsed, layoutPlain(backupDocument).images, backupPlain, normalized),
    );
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
