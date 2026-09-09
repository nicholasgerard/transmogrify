'use strict';

// A bounded, single-line excerpt of a child's last message, for wakes and
// event payloads. Control characters are removed, whitespace is collapsed,
// and anything past the bound is cut with an ellipsis. Never a substitute for
// reading the child's handback: it exists so the parent knows what came back
// before it looks.

const MAX_EXCERPT_CHARS = 240;

function normalizeExcerpt(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!cleaned) return null;
  const characters = Array.from(cleaned);
  if (characters.length <= MAX_EXCERPT_CHARS) return cleaned;
  return `${characters.slice(0, MAX_EXCERPT_CHARS - 1).join('').trimEnd()}…`;
}

module.exports = { MAX_EXCERPT_CHARS, normalizeExcerpt };
