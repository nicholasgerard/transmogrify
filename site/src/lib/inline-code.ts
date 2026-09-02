/**
 * Frontmatter strings are plain text, but the copy in them is technical enough
 * that `backticked` spans and **bold** runs earn their place. Rather than pull
 * a Markdown renderer into a field that must never contain arbitrary HTML, we
 * recognise exactly those two inline forms and emit them as elements.
 *
 * Unmatched delimiters stay literal, so an odd backtick can never swallow the
 * rest of a sentence.
 */

export type InlineToken =
  | { kind: 'text'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'strong'; value: string };

const PATTERN = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;

export function parseInline(source: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let lastIndex = 0;

  for (const match of source.matchAll(PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      tokens.push({ kind: 'text', value: source.slice(lastIndex, index) });
    }
    if (match[1] !== undefined) {
      tokens.push({ kind: 'code', value: match[1] });
    } else if (match[2] !== undefined) {
      tokens.push({ kind: 'strong', value: match[2] });
    }
    lastIndex = index + match[0].length;
  }

  if (lastIndex < source.length) {
    tokens.push({ kind: 'text', value: source.slice(lastIndex) });
  }
  return tokens;
}
