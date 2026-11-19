import type Quill from 'quill';

const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;
const URL_BEFORE_CURSOR = /https?:\/\/[^\s<>"']+$/;
const URL_TRAILING_PUNCTUATION = /[.,:!?)\]]+$/;
const LOOKBACK = 2048; // max URL length considered when a space/Enter is typed

/**
 * Turn bare URLs into links as they're entered: on paste, and when a space or Enter follows a typed URL.
 * Text that is already a link or inside code is left alone. Ctrl/Cmd+Z undoes the link like any edit.
 */
export function enableAutoLink(quill: Quill): void {
  quill.on('text-change', (delta, _oldDelta, source) => {
    if (source !== 'user') return; // also ignores the format changes made below
    let index = 0;
    for (const op of delta.ops) {
      if (typeof op.retain === 'number') {
        index += op.retain;
      } else if (typeof op.insert === 'string') {
        if (/^\s$/.test(op.insert)) linkUrlBefore(quill, index);
        else if (!op.attributes?.['link']) linkUrlsIn(quill, index, op.insert);
        index += op.insert.length;
      } else if (op.insert) {
        index += 1; // embed
      }
    }
  });
}

/** Typed space/Enter at `index`: link the URL that ends right before it. */
function linkUrlBefore(quill: Quill, index: number): void {
  const start = Math.max(0, index - LOOKBACK);
  const match = URL_BEFORE_CURSOR.exec(quill.getText(start, index - start));
  if (match) applyLink(quill, start + match.index, match[0]);
}

/** Pasted text inserted at `index`: link every URL in it. */
function linkUrlsIn(quill: Quill, index: number, text: string): void {
  for (const match of text.matchAll(URL_PATTERN)) {
    applyLink(quill, index + (match.index ?? 0), match[0]);
  }
}

function applyLink(quill: Quill, at: number, rawUrl: string): void {
  const url = rawUrl.replace(URL_TRAILING_PUNCTUATION, '');
  const format = quill.getFormat(at, url.length);
  if (format['link'] || format['code'] || format['code-block']) return;
  // Own undo step: the first Ctrl/Cmd+Z removes just the link, not the text typed before it
  const history = quill.getModule('history') as { cutoff(): void } | undefined;
  history?.cutoff();
  quill.formatText(at, url.length, 'link', url, 'user');
  history?.cutoff();
}
