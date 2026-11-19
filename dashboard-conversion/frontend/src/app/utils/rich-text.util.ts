/**
 * Helpers for the Tech Intake multi-line fields. Their values are rich text (HTML from the
 * Quill editor); plain-text values are still accepted everywhere.
 */

// The editor always produces a block tag first; anything else is plain text
const RICH_TEXT_PATTERN = /^\s*<(p|ol|ul|pre|blockquote|h[1-6]|div)[\s>]/i;
const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;
const HAS_URL = /https?:\/\//i;
const URL_TRAILING_PUNCTUATION = /[.,:!?)\]]+$/;
const NBSP = String.fromCharCode(0xa0);

export function isRichText(value: unknown): boolean {
  return typeof value === 'string' && RICH_TEXT_PATTERN.test(value);
}

/** Text only (block ends become line breaks) — for required-field checks and edit-history labels. */
export function toPlainText(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (!isRichText(text)) return text;
  const withBreaks = text.replace(/<br\s*\/?>|<\/(p|li|pre|h[1-6]|blockquote|div)>/gi, '\n');
  const doc = new DOMParser().parseFromString(withBreaks, 'text/html');
  return (doc.body.textContent || '').replaceAll(NBSP, ' ').replace(/\n{2,}/g, '\n').trim();
}

/**
 * Read-only HTML for the Review page: formatting kept, bare URLs linked, links open in a new tab.
 * Bind with [innerHTML] — Angular still sanitizes the result.
 */
export function toDisplayHtml(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  const text = String(value);
  const doc = new DOMParser().parseFromString('', 'text/html');
  if (isRichText(text)) {
    doc.body.innerHTML = text; // inert document: nothing runs or loads here
  } else {
    text.split(/\r?\n/).forEach((line, i) => {
      if (i > 0) doc.body.append(doc.createElement('br'));
      doc.body.append(line);
    });
  }
  linkifyTextNodes(doc.body);
  doc.body.querySelectorAll('a').forEach((a) => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
  return doc.body.innerHTML.replaceAll('&nbsp;', ' ');
}

/** Wrap bare http(s) URLs in <a>, skipping text already inside links or code. */
function linkifyTextNodes(root: HTMLElement): void {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (HAS_URL.test(node.nodeValue || '') && !node.parentElement?.closest('a, code, pre')) {
      targets.push(node as Text);
    }
  }
  for (const node of targets) {
    const text = node.nodeValue || '';
    const fragment = doc.createDocumentFragment();
    let last = 0;
    for (const match of text.matchAll(URL_PATTERN)) {
      const url = match[0].replace(URL_TRAILING_PUNCTUATION, '');
      const start = match.index ?? 0;
      const link = doc.createElement('a');
      link.href = url;
      link.textContent = url;
      fragment.append(text.slice(last, start), link);
      last = start + url.length;
    }
    fragment.append(text.slice(last));
    node.replaceWith(fragment);
  }
}
