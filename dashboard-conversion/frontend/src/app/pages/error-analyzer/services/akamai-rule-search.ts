/**
 * Search over a loaded rule tree.
 *
 * Two jobs: find the matching rules, and work out which field matched. The
 * second matters because a hit is often on something the collapsed row
 * never renders — a rewriteUrl target, a cookie value, an advanced XML
 * blob — leaving no visible reason for the match.
 *
 * Pure module: no Angular, no state.
 */

import { MatchField, RuleNode } from '../models/akamai-rule-tree.model';

/** Rules whose indexed content contains the term, in document order. */
export function findHits(nodes: RuleNode[], term: string): number[] {
  const needle = term.trim().toLowerCase();
  if (!needle) return [];
  return nodes.filter(node => node.searchBlob.includes(needle)).map(node => node.id);
}

/** Flattens an option value to the single line a user would read. */
function flattenValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
}

/**
 * Every field on a rule whose value contains the term, labelled by where
 * it lives (e.g. "rewriteUrl.targetUrl", "path.values", "comments").
 *
 * The rule name is excluded — it's already rendered and highlighted on the
 * row itself, so repeating it below would be noise.
 */
export function matchFields(node: RuleNode, term: string): MatchField[] {
  const needle = term.trim().toLowerCase();
  if (!needle) return [];

  const found: MatchField[] = [];
  const push = (label: string, value: unknown) => {
    const text = flattenValue(value);
    if (text.toLowerCase().indexOf(needle) >= 0) found.push({ label, text });
  };

  const rule = node.rule;
  if (rule.comments) push('comments', rule.comments);
  if (rule.uuid) push('uuid', rule.uuid);

  (rule.criteria || []).forEach(c =>
    Object.keys(c.options || {}).forEach(key => push(`${c.name}.${key}`, (c.options as Record<string, unknown>)[key]))
  );
  (rule.behaviors || []).forEach(b =>
    Object.keys(b.options || {}).forEach(key => push(`${b.name}.${key}`, (b.options as Record<string, unknown>)[key]))
  );

  return found;
}

/**
 * Windows a value around the match so a long path list or an XML blob
 * still renders as one line.
 */
export function snippetAround(text: string, term: string): string {
  const needle = term.trim().toLowerCase();
  const at = text.toLowerCase().indexOf(needle);
  if (at < 0) return text;

  const from = Math.max(0, at - 28);
  const to = Math.min(text.length, at + needle.length + 44);
  return (
    (from > 0 ? '\u2026' : '') +
    text.slice(from, to).replace(/\s+/g, ' ') +
    (to < text.length ? '\u2026' : '')
  );
}
