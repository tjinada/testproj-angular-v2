/**
 * Owns the loaded Akamai property for the Akamai Rules tab.
 *
 * Root-provided deliberately: the tab panel is created and destroyed as
 * the user moves between Error Analyzer tabs, and re-uploading the config
 * on every switch would be miserable. The parsed index lives here for the
 * session and is cleared only on reload or an explicit replace.
 *
 * This is also the only place that knows where the config came from.
 * Everything downstream consumes a parsed ConfigIndex, so adding a PAPI
 * fetch later means adding one method here — the matcher, the models and
 * the components don't change.
 */

import { Injectable, signal, computed } from '@angular/core';
import {
  CloudletArm,
  ConfigIndex,
  MatchField,
  PapiRule,
  PropertyDoc,
  RuleNode
} from '../models/akamai-rule-tree.model';

/** Thrown shapes are kept simple — the component renders `message` inline. */
export interface ConfigLoadError {
  message: string;
}

@Injectable({ providedIn: 'root' })
export class AkamaiConfigService {
  private readonly indexSignal = signal<ConfigIndex | null>(null);
  private readonly errorSignal = signal<string>('');

  /** Parsed config, or null when nothing is loaded yet. */
  readonly index = this.indexSignal.asReadonly();
  readonly error = this.errorSignal.asReadonly();
  readonly isLoaded = computed(() => this.indexSignal() !== null);

  /**
   * Parses an uploaded PAPI rule-tree JSON.
   *
   * Returns true on success. On failure the reason is exposed via `error`
   * and any previously loaded config is left untouched — a bad upload
   * shouldn't lose the config the user was already working with.
   */
  loadFromFile(text: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.errorSignal.set('That file isn\u2019t valid JSON.');
      return false;
    }

    const doc = parsed as PropertyDoc;
    if (!doc || typeof doc !== 'object' || !doc.rules || typeof doc.rules !== 'object') {
      this.errorSignal.set('No "rules" object found. Expected a PAPI rule tree export.');
      return false;
    }
    if (typeof doc.rules.name !== 'string') {
      this.errorSignal.set('The "rules" object has no name \u2014 this doesn\u2019t look like a rule tree.');
      return false;
    }

    this.errorSignal.set('');
    this.indexSignal.set(buildIndex(doc));
    return true;
  }

  /** Drops the loaded config and returns the tab to the upload state. */
  clear(): void {
    this.indexSignal.set(null);
    this.errorSignal.set('');
  }
}

// ── Index construction ───────────────────────────────────────────────

/**
 * Flattens the tree and derives everything the tab needs up front, so the
 * per-trace and per-keystroke paths stay cheap. A 404-rule property builds
 * in a few milliseconds.
 */
export function buildIndex(doc: PropertyDoc): ConfigIndex {
  const nodes: RuleNode[] = [];

  const flatten = (rule: PapiRule, depth: number, parent: number | null, trail: string[]): void => {
    const node: RuleNode = {
      id: nodes.length,
      depth,
      parent,
      rule,
      trail,
      children: [],
      searchBlob: ''
    };
    nodes.push(node);
    if (parent !== null) nodes[parent].children.push(node.id);

    const parts: string[] = [rule.name || '', rule.comments || '', rule.uuid || ''];
    (rule.criteria || []).forEach(c => parts.push(c.name, JSON.stringify(c.options)));
    (rule.behaviors || []).forEach(b => parts.push(b.name, JSON.stringify(b.options)));
    node.searchBlob = parts.join(' ').toLowerCase();

    (rule.children || []).forEach(child => flatten(child, depth + 1, node.id, trail.concat(rule.name || '')));
  };

  flatten(doc.rules, 0, null, []);

  return {
    doc,
    nodes,
    hostnames: collectHostnames(nodes),
    cloudletArms: collectCloudletArms(nodes),
    gtmMap: buildGtmMap(nodes),
    assignedVariables: collectAssignedVariables(nodes)
  };
}

function collectHostnames(nodes: RuleNode[]): string[] {
  const found = new Set<string>();
  nodes.forEach(node =>
    (node.rule.criteria || []).forEach(c => {
      if (c.name !== 'hostname') return;
      (((c.options as Record<string, any>)['values'] as string[]) || []).forEach(value => {
        if (!String(value).includes('*')) found.add(String(value));
      });
    })
  );
  return [...found].sort();
}

/**
 * Conditional-origin arms that actually route.
 *
 * A property can declare many arms — INSHUB, REWARDS, Dory SSO — whose
 * rules carry no origin behavior at all. Selecting one of those changes
 * nothing, so they're left out rather than offered as dead options.
 *
 * Ordered with the arms that follow PMUSER_TARGET first and the ones that
 * pin a literal host last, since the former are the normal case.
 */
function collectCloudletArms(nodes: RuleNode[]): CloudletArm[] {
  const arms: CloudletArm[] = [];
  const seen = new Set<string>();

  nodes.forEach(node => {
    (node.rule.criteria || []).forEach(c => {
      if (c.name !== 'cloudletsOrigin') return;
      const originId = String((c.options as Record<string, any>)['originId'] || '');
      if (!originId || seen.has(originId)) return;

      const origin = (node.rule.behaviors || []).find(
        b => b.name === 'origin' && (b.options as Record<string, any>)['hostname']
      );
      if (!origin) return;

      const hostname = String((origin.options as Record<string, any>)['hostname']);
      seen.add(originId);
      arms.push({ originId, pinsHost: /\{\{/.test(hostname) ? null : hostname });
    });
  });

  return arms.sort((a, b) => (a.pinsHost ? 1 : 0) - (b.pinsHost ? 1 : 0) || a.originId.localeCompare(b.originId));
}

function collectAssignedVariables(nodes: RuleNode[]): Set<string> {
  const assigned = new Set<string>();
  nodes.forEach(node =>
    (node.rule.behaviors || []).forEach(b => {
      if (b.name !== 'setVariable') return;
      const name = (b.options as Record<string, any>)['variableName'];
      if (name) assigned.add(String(name));
    })
  );
  return assigned;
}

/**
 * Pairs each scope's GTM hostname with the origins its BCC and SCC cookie
 * branches assign, giving what a GTM lookup in that scope would return.
 *
 * Nothing is hardcoded: a new scope or GTM name added to the property is
 * picked up on the next upload.
 */
function buildGtmMap(nodes: RuleNode[]): Record<string, Record<string, string>> {
  // Enclosing PMUSER_GTM value per node, inherited from the nearest ancestor
  // that sets it.
  const scopeOf: (string | null)[] = [];
  nodes.forEach(node => {
    let scope = node.parent === null ? null : scopeOf[node.parent];
    (node.rule.behaviors || []).forEach(b => {
      const o = b.options as Record<string, any>;
      if (b.name === 'setVariable' && o['variableName'] === 'PMUSER_GTM') {
        scope = String(o['variableValue']);
      }
    });
    scopeOf[node.id] = scope;
  });

  const map: Record<string, Record<string, string>> = {};
  nodes.forEach(node => {
    const scope = scopeOf[node.id];
    if (!scope) return;

    (node.rule.behaviors || []).forEach(b => {
      const o = b.options as Record<string, any>;
      if (b.name !== 'setVariable' || o['variableName'] !== 'PMUSER_TARGET') return;

      const value = String(o['variableValue'] || '');
      if (!value || /\{\{/.test(value)) return;

      const label = `${node.rule.name} ${node.trail.slice(-2).join(' ')}`.toUpperCase();
      const datacentre = label.includes('BCC') ? 'BCC' : label.includes('SCC') ? 'SCC' : null;
      if (!datacentre) return;

      map[scope] = map[scope] || {};
      map[scope][datacentre] = value;
    });
  });

  return map;
}

// ── Search ───────────────────────────────────────────────────────────
//
// The read side of the index. These live here rather than in their own file
// because `searchBlob` is built above and nothing outside this module reads
// it — splitting them apart would separate the query from the thing queried.

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
 * Every field on a rule whose value contains the term, labelled by where it
 * lives (e.g. "rewriteUrl.targetUrl", "path.values", "comments").
 *
 * Without this a hit often has no visible explanation: the collapsed row
 * shows the rule name, the first two criteria and the behavior names, while
 * the match is frequently in a rewrite target or an XML blob.
 *
 * The rule name is excluded — it's already on the row and highlighted there.
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
 * Windows a value around the match so a long path list or an XML blob still
 * renders as one line.
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
