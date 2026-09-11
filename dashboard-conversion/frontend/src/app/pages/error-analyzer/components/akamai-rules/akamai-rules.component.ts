import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import {
  CookieDrift,
  MatchField,
  Outcome,
  RuleNode,
  TraceRequest,
  TraceResult
} from '../../models/akamai-rule-tree.model';
import {
  AkamaiConfigService,
  findHits,
  matchFields,
  snippetAround
} from '../../services/akamai-config.service';
import { buildOutcome, evaluate, isResolved } from '../../services/akamai-papi';
import { RuleDetailComponent } from './rule-detail/rule-detail.component';

type Mode = 'trace' | 'browse';

/** One criterion, reduced to the parts worth showing on a collapsed row. */
interface ConditionPart {
  subject: string;
  operator: string;
  values: string;
  negated: boolean;
}

/** The whole criteria summary for a rule. */
interface ConditionSummary {
  parts: ConditionPart[];
  /** " and " or " or ", from criteriaMustSatisfy. */
  joiner: string;
  /** Criteria beyond the two shown. */
  extra: number;
}

/** A row in the browse tree. */
interface TreeRow {
  id: number;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  focused: boolean;
}

/** A clickable breadcrumb segment on a hit card. */
interface Crumb {
  id: number;
  name: string;
}

/** A search result. */
interface HitCard {
  id: number;
  crumbs: Crumb[];
  pills: string[];
  overflow: number;
  condition: ConditionSummary | null;
  matches: MatchField[];
  extraMatches: number;
}

/** A rule that acted during a trace. */
interface EvidenceRow {
  id: number;
  crumb: string;
  condition: ConditionSummary | null;
  actions: string[];
  uncertain: boolean;
  blockedBy: string;
}

// ── Cookie model ─────────────────────────────────────────────────────

/**
 * On blue./green. hosts the colour is already in the URL, so the session
 * cookie only carries the datacentre. On plain hosts it carries both.
 */
const SITE_COOKIE_VALUES = ['blue-BCC', 'blue-SCC', 'green-BCC', 'green-SCC', '-BCC', '-SCC'];
const DC_COOKIE_VALUES = ['BCC', 'SCC'];

/** Sentinel for "let the cloudlet arm and GTM answer decide this cookie". */
const DERIVED = '__derived__';

@Component({
  selector: 'app-akamai-rules',
  standalone: true,
  imports: [CommonModule, FormsModule, RuleDetailComponent],
  templateUrl: './akamai-rules.component.html',
  styleUrls: ['./akamai-rules.component.scss']
})
export class AkamaiRulesComponent {
  readonly config = inject(AkamaiConfigService);

  mode: Mode = 'trace';

  // ── Request state ──────────────────────────────────────────────────
  hostname = '';
  path = '/onlinebanking/cgi-bin/netbnx/CSPMain';
  cloudletArm = '';
  /** 'www13' (BCC), 'www12' (SCC), or '' for unknown. */
  gtmAnswer = 'www13';
  /** Cookie name → DERIVED, '' (not set), or an explicit value. */
  cookieChoice: Record<string, string> = {};

  // ── Trace results ──────────────────────────────────────────────────
  result: TraceResult | null = null;
  outcome: Outcome | null = null;
  request: TraceRequest | null = null;
  evidence: EvidenceRow[] = [];
  evidenceOpen = false;

  // ── Browse state ───────────────────────────────────────────────────
  searchTerm = '';
  hits: HitCard[] = [];
  hitCount = 0;
  private expanded = new Set<number>([0]);
  openDetailId: number | null = null;
  focusId: number | null = null;
  /** Remembers the search you jumped out of, so you can get back to it. */
  lastTerm = '';
  lastHitCount = 0;

  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Upload ─────────────────────────────────────────────────────────

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files && input.files[0];
    if (file) this.readFile(file);
    // Allow re-selecting the same file after a failed parse.
    input.value = '';
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) this.readFile(file);
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
  }

  private readFile(file: File): void {
    const reader = new FileReader();
    reader.onload = () => {
      if (this.config.loadFromFile(String(reader.result || ''))) this.onConfigLoaded();
    };
    reader.onerror = () => this.config.loadFromFile('');
    reader.readAsText(file);
  }

  /** Picks sensible defaults from the freshly parsed property and traces. */
  private onConfigLoaded(): void {
    const index = this.config.index();
    if (!index) return;

    this.hostname = index.hostnames.includes('www1.bmo.com') ? 'www1.bmo.com' : index.hostnames[0] || '';
    this.cloudletArm = index.cloudletArms.some(a => a.originId === 'blue') ? 'blue' : '';
    this.cookieChoice = {};
    this.expanded = new Set<number>([0]);
    index.nodes.filter(n => n.depth === 1).forEach(n => this.expanded.add(n.id));
    this.runTrace();
  }

  replaceConfig(): void {
    this.config.clear();
    this.result = null;
    this.outcome = null;
    this.evidence = [];
    this.hits = [];
    this.searchTerm = '';
  }

  // ── Cookies ────────────────────────────────────────────────────────

  /** Colour carried by the URL itself, on blue./green. hosts. */
  private hostColour(host: string): string | null {
    if (/^blue\./.test(host)) return 'blue';
    if (/^green\./.test(host)) return 'green';
    return null;
  }

  /** Colour the selected arm would apply. Only meaningful on plain hosts. */
  private armColour(): string | null {
    if (/blue/i.test(this.cloudletArm)) return 'blue';
    if (/green/i.test(this.cloudletArm)) return 'green';
    return null;
  }

  /** The cookie pair the current host actually gates on. */
  get activeCookies(): string[] {
    return this.hostColour(this.hostname) ? ['cdbbosdc', 'cdbspadc'] : ['cdbbossiteId', 'cdbspasiteId'];
  }

  /** The cloudlet arm only supplies colour where the URL doesn't. */
  get showCloudletArm(): boolean {
    return !this.hostColour(this.hostname);
  }

  valuesFor(cookie: string): string[] {
    return cookie.endsWith('dc') ? DC_COOKIE_VALUES : SITE_COOKIE_VALUES;
  }

  /** What the estate would stamp right now, or null if it can't say. */
  derivedValue(cookie: string): string | null {
    const datacentre = this.gtmAnswer === 'www13' ? 'BCC' : this.gtmAnswer === 'www12' ? 'SCC' : null;
    if (!datacentre) return null;
    if (cookie.endsWith('dc')) return datacentre;

    const colour = this.hostColour(this.hostname) || this.armColour();
    return colour ? `${colour}-${datacentre}` : null;
  }

  choiceFor(cookie: string): string {
    return this.cookieChoice[cookie] === undefined ? DERIVED : this.cookieChoice[cookie];
  }

  onCookieChange(cookie: string, value: string): void {
    this.cookieChoice[cookie] = value;
    this.runTrace();
  }

  onHostChange(): void {
    // The live cookie pair changes with the host, so pinned values from the
    // previous pair no longer apply.
    this.cookieChoice = {};
    this.runTrace();
  }

  readonly derivedSentinel = DERIVED;

  // ── Trace ──────────────────────────────────────────────────────────

  private buildRequest(): TraceRequest {
    const cookies: Record<string, string> = {};
    const drift: CookieDrift[] = [];

    this.activeCookies.forEach(name => {
      const derived = this.derivedValue(name);
      const choice = this.choiceFor(name);
      if (choice === DERIVED) {
        if (derived !== null) cookies[name] = derived;
      } else {
        cookies[name] = choice;
        if (choice && derived && choice !== derived) drift.push({ name, has: choice, would: derived });
      }
    });

    const raw = this.path.trim() || '/';
    const queryAt = raw.indexOf('?');
    const path = queryAt < 0 ? raw : raw.slice(0, queryAt);
    const query = queryAt < 0 ? '' : raw.slice(queryAt + 1);
    const lastSegment = path.split('/').pop() || '';
    const dot = lastSegment.lastIndexOf('.');

    return {
      hostname: this.hostname,
      path,
      query,
      fileExtension: dot > 0 ? lastSegment.slice(dot + 1).toLowerCase() : '',
      cookies,
      cloudletArm: this.cloudletArm,
      gtmAnswer: this.gtmAnswer,
      drift
    };
  }

  runTrace(): void {
    const index = this.config.index();
    if (!index) return;

    const request = this.buildRequest();
    const result = evaluate(index, request);
    const outcome = buildOutcome(index, request, result);

    this.request = request;
    this.result = result;
    this.outcome = outcome;
    this.openDetailId = null;

    // Only rules that changed where the request goes. Header injection,
    // caching and cpCode all matched here too, and listing them buried the
    // handful that mattered.
    this.evidence = result.matched
      .filter(match => outcome.actions[match.id])
      .map(match => {
        const node = index.nodes[match.id];
        return {
          id: match.id,
          crumb: node.trail.slice(1).join('  \u203a  '),
          condition: this.conditionOf(node),
          actions: outcome.actions[match.id],
          uncertain: match.status === 'partial',
          blockedBy: match.unknown.join(', ')
        };
      });
  }

  get matchedCount(): number {
    return this.result ? this.result.matched.length : 0;
  }

  get undecidedCount(): number {
    return this.result ? this.result.matched.filter(m => m.status === 'partial').length : 0;
  }

  /** Cookies present on the request, which make the estate switches moot. */
  get stickyCookies(): string[] {
    if (!this.request) return [];
    return Object.keys(this.request.cookies).filter(name => this.request!.cookies[name]);
  }

  get drift(): CookieDrift[] {
    return this.request ? this.request.drift : [];
  }

  get originResolved(): boolean {
    return !!(this.outcome && this.outcome.origin && this.outcome.origin.resolved);
  }

  // ── Browse and search ──────────────────────────────────────────────

  setMode(mode: Mode): void {
    this.mode = mode;
    this.openDetailId = null;
    if (mode === 'browse') return;
    this.runTrace();
  }

  onSearchInput(value: string): void {
    this.searchTerm = value;
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.applySearch(), 150);
  }

  private applySearch(): void {
    const index = this.config.index();
    if (!index) return;

    this.focusId = null;
    this.openDetailId = null;
    if (this.searchTerm.trim()) this.lastTerm = '';

    const ids = findHits(index.nodes, this.searchTerm);
    this.hitCount = ids.length;
    this.hits = ids.map(id => this.buildHitCard(index.nodes[id]));
  }

  private buildHitCard(node: RuleNode): HitCard {
    const crumbs: Crumb[] = [];
    const index = this.config.index()!;
    for (let cursor = node.parent; cursor !== null; cursor = index.nodes[cursor].parent) {
      crumbs.unshift({ id: cursor, name: index.nodes[cursor].rule.name });
    }

    const counts: Record<string, number> = {};
    (node.rule.behaviors || []).forEach(b => {
      counts[b.name] = (counts[b.name] || 0) + 1;
    });
    const names = Object.keys(counts);

    const fields = matchFields(node, this.searchTerm);
    return {
      id: node.id,
      // Drop the root rule — every breadcrumb starts there.
      crumbs: crumbs.slice(1),
      pills: names.slice(0, 4).map(n => (counts[n] > 1 ? `${n} \u00d7${counts[n]}` : n)),
      overflow: Math.max(0, names.length - 4),
      condition: this.conditionOf(node),
      matches: fields.slice(0, 3).map(f => ({ label: f.label, text: snippetAround(f.text, this.searchTerm) })),
      extraMatches: Math.max(0, fields.length - 3)
    };
  }

  /**
   * Opens the full tree at a rule, so the user can look at its siblings and
   * parents. Search results are flat by design, which is the right shape for
   * scanning but the wrong one for working out why a rule sits where it does.
   */
  showInTree(id: number): void {
    const index = this.config.index();
    if (!index) return;

    this.lastTerm = this.searchTerm;
    this.lastHitCount = this.hitCount;
    this.searchTerm = '';
    this.hits = [];
    this.hitCount = 0;

    for (let cursor = index.nodes[id].parent; cursor !== null; cursor = index.nodes[cursor].parent) {
      this.expanded.add(cursor);
    }
    this.expanded.add(id);
    this.focusId = id;
    this.openDetailId = id;

    setTimeout(() => {
      document.querySelector(`[data-rule-id="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  backToResults(): void {
    this.searchTerm = this.lastTerm;
    this.lastTerm = '';
    this.focusId = null;
    this.applySearch();
  }

  toggleExpanded(id: number): void {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
  }

  toggleDetail(id: number): void {
    this.openDetailId = this.openDetailId === id ? null : id;
  }

  /** Visible tree rows, flattened so the template can render one @for. */
  get treeRows(): TreeRow[] {
    const index = this.config.index();
    if (!index) return [];

    const rows: TreeRow[] = [];
    const walk = (id: number): void => {
      const node = index.nodes[id];
      rows.push({
        id,
        depth: node.depth,
        hasChildren: node.children.length > 0,
        expanded: this.expanded.has(id),
        focused: this.focusId === id
      });
      if (this.expanded.has(id)) node.children.forEach(walk);
    };
    walk(0);
    return rows;
  }

  indentFor(depth: number): string {
    return `${8 + depth * 18}px`;
  }

  // ── Shared rendering helpers ───────────────────────────────────────

  nodeById(id: number): RuleNode {
    return this.config.index()!.nodes[id];
  }

  ruleName(id: number): string {
    return this.nodeById(id).rule.name || '(unnamed)';
  }

  behaviorPills(id: number): string[] {
    const counts: Record<string, number> = {};
    (this.nodeById(id).rule.behaviors || []).forEach(b => {
      counts[b.name] = (counts[b.name] || 0) + 1;
    });
    return Object.keys(counts)
      .slice(0, 4)
      .map(n => (counts[n] > 1 ? `${n} \u00d7${counts[n]}` : n));
  }

  /**
   * Reduces a rule's criteria to the two most useful, with the operator kept
   * intact. Dropping the operator would render an IS_NOT chain as its own
   * opposite, which is the single easiest way to misread this config.
   */
  conditionOf(node: RuleNode): ConditionSummary | null {
    const criteria = node.rule.criteria || [];
    if (!criteria.length) return null;

    const subjectKeys = ['cookieName', 'variableName', 'headerName', 'parameterName', 'characteristic', 'originId'];
    const valueKeys = ['values', 'variableValues', 'value'];

    const parts = criteria.slice(0, 2).map(criterion => {
      const o = (criterion.options || {}) as Record<string, any>;

      let subject = criterion.name;
      for (const key of subjectKeys) {
        if (o[key] !== undefined && o[key] !== null) {
          subject = `${criterion.name} ${o[key]}`;
          break;
        }
      }

      let values = '';
      for (const key of valueKeys) {
        if (o[key] !== undefined && o[key] !== null) {
          values = Array.isArray(o[key]) ? o[key].join(', ') : String(o[key]);
          break;
        }
      }
      if (values.length > 52) values = `${values.slice(0, 51)}\u2026`;

      return {
        subject,
        operator: String(o['matchOperator'] || '').toLowerCase().replace(/_/g, ' '),
        values,
        negated: /NOT|DOES_NOT/.test(String(o['matchOperator'] || ''))
      };
    });

    return {
      parts,
      joiner: node.rule.criteriaMustSatisfy === 'any' ? ' or ' : ' and ',
      extra: Math.max(0, criteria.length - 2)
    };
  }

  /** Variables and their resolved values, for the collapsed panel. */
  get variableRows(): { name: string; value: string; source: string; resolved: boolean }[] {
    if (!this.result) return [];
    return Object.keys(this.result.prov)
      .sort()
      .map(name => {
        const entry = this.result!.prov[name];
        const ok = isResolved(entry.value);
        return {
          name,
          value: ok ? entry.value || '(empty)' : `unresolved \u2014 ${entry.raw}`,
          source: entry.ruleName,
          resolved: ok
        };
      });
  }

  get resolvedVariableCount(): number {
    return this.variableRows.filter(row => row.resolved).length;
  }

  trackById(_index: number, item: { id: number }): number {
    return item.id;
  }

  trackByIndex(index: number): number {
    return index;
  }
}
