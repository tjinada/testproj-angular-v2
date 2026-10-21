import {
  Component,
  ElementRef,
  HostListener,
  Input,
  OnChanges,
  SimpleChanges,
  ViewChild,
  computed,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import {
  QA_CANVAS, QA_CATEGORIES, QA_EDGES, QA_GROUPS, QA_NODES, QA_ROUTES,
  QaCategoryStyle, QaEdge, QaEndpoint, QaEndpointGroup, QaNode, edgeId, stageIds
} from './qa-topology';
import { QA_SHARED_ENDPOINTS } from './qa-endpoints';
import { DEFAULT_QA_ENV, QA_ENVIRONMENTS, QaEnvProfile } from './qa-environments';
import { CWH_NODE, CWH_PASSTHROUGH_NODE, CWH_REWRITES, CWH_ROUTES, cwhRoute, normalizePath } from './qa-rewrites';

/**
 * One catalogued call and how it travels. Drawer rows, search hits and the
 * traced endpoint are all this.
 */
export interface QaTrace {
  /** Node whose list it is in. */
  owner: string;
  group: string;
  endpoint: QaEndpoint;
  /** Normalised path, for matching. */
  key: string;
  /** QA_ROUTES id; null traces the owner box only. */
  route: string | null;
  /** Path after the CWH rewrite, when there is one. */
  to?: string;
  /** Box that serves it (last stage of the route). */
  dest: { label: string; style: QaCategoryStyle } | null;
}

export interface QaGroupView {
  title: string;
  rows: QaTrace[];
}

/** A node resolved against the selected environment. */
export interface QaNodeView extends QaNode {
  style: QaCategoryStyle;
  hosts: string[];
  endpointGroups: QaGroupView[];
  endpointCount: number;
}

interface TraceHop { label: string; path?: string; note?: string; }

/** An edge resolved against the selected environment. */
export interface QaEdgeView extends QaEdge {
  id: string;
  d: string;
}

/** Text split for filter highlighting, so no [innerHTML] is needed. */
interface TextPart { text: string; hit: boolean; }

@Component({
  selector: 'app-qa-traffic-flow',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './qa-traffic-flow.component.html',
  styleUrls: ['./qa-traffic-flow.component.scss']
})
export class QaTrafficFlowComponent implements OnChanges {
  /** Query params from the Error Analyzer route (reads ?qaenv=). */
  @Input() sharedParams: Record<string, string> | null = null;

  /**
   * True while this view is on screen. Fit needs real dimensions, and the
   * component is created hidden (tab panels use [hidden]), so it re-fits on show.
   */
  @Input() active = false;

  @ViewChild('svgEl', { static: false }) svgEl?: ElementRef<SVGSVGElement>;

  readonly environments = QA_ENVIRONMENTS;
  readonly groups = QA_GROUPS.map(g => ({ ...g, style: QA_CATEGORIES[g.category] }));
  readonly legend = Object.values(QA_CATEGORIES);
  readonly cwhNode = CWH_NODE;

  envId = signal(DEFAULT_QA_ENV);
  selectedNodeId = signal<string | null>(null);
  filter = signal('');
  endpointsOpen = signal(true);
  copiedPath = signal<string | null>(null);
  isFullscreen = signal(false);
  query = signal('');
  searchOpen = signal(false);
  /** The endpoint being traced; its whole route is lit. */
  trace = signal<QaTrace | null>(null);

  tx = signal(0);
  ty = signal(0);
  k = signal(1);
  transform = computed(() => `translate(${this.tx()} ${this.ty()}) scale(${this.k()})`);

  env = computed<QaEnvProfile>(() =>
    QA_ENVIRONMENTS.find(e => e.id === this.envId()) ?? QA_ENVIRONMENTS[0]);

  /** Each box's own endpoint lists for the selected environment. */
  private ownGroups = computed(() => {
    const env = this.env();
    return new Map(QA_NODES.map(n => [n.id, env.endpoints?.[n.id] ?? QA_SHARED_ENDPOINTS[n.id] ?? []]));
  });

  /**
   * Every catalogued call once (a list shared by two boxes counts under the first),
   * plus CWH rewrites whose caller isn't catalogued. This is what search looks in.
   */
  private catalogue = computed<QaTrace[]>(() => {
    const seen = new Set<QaEndpointGroup>();
    const out: QaTrace[] = [];
    for (const n of QA_NODES) {
      for (const g of this.ownGroups().get(n.id) ?? []) {
        if (seen.has(g)) continue;
        seen.add(g);
        g.endpoints.forEach(ep => out.push(this.toTrace(n, g, ep)));
      }
    }
    const known = new Set(out.map(t => t.key));
    for (const r of CWH_REWRITES) {
      if (known.has(r.from)) continue;
      const ep = { method: 'ANY', path: r.from, notes: 'Caller not catalogued' };
      out.push(this.makeTrace(CWH_NODE, 'CWH → CDBBOS', ep, CWH_ROUTES.cdbbos, r.to));
    }
    return out;
  });

  /** What CWH APIC receives, grouped by where it sends it. */
  private cwhGroups = computed<QaGroupView[]>(() => {
    const viaCwh = this.catalogue().filter(t => t.route === CWH_ROUTES.cdbbos || t.route === CWH_ROUTES.passThrough);
    const byKey = new Map(viaCwh.map(t => [t.key, t]));
    const byBase = new Map<string, QaTrace[]>();
    for (const r of CWH_REWRITES) {
      const t = byKey.get(r.from);
      if (t) byBase.set(r.base, [...(byBase.get(r.base) ?? []), t]);
    }
    return [
      ...[...byBase].map(([base, rows]) => ({ title: `→ CDBBOS · ${base}`, rows })),
      { title: '→ SSS /api/cdb → Channels AWS · path unchanged', rows: this.passThrough() }
    ];
  });

  /** Client calls CWH passes on unchanged to SSS /api/cdb. */
  private passThrough = computed(() => this.catalogue().filter(t => t.route === CWH_ROUTES.passThrough));

  nodes = computed<QaNodeView[]>(() => {
    const env = this.env();
    const absent = new Set(env.absent ?? []);
    return QA_NODES.filter(n => !absent.has(n.id)).map(n => {
      const own = (this.ownGroups().get(n.id) ?? [])
        .map(g => ({ title: g.title, rows: g.endpoints.map(ep => this.toTrace(n, g, ep)) }));
      const derived: QaGroupView[] =
        n.id === CWH_NODE ? this.cwhGroups()
        : n.id === CWH_PASSTHROUGH_NODE ? [{ title: 'From CWH APIC · path unchanged', rows: this.passThrough() }]
        : [];
      const endpointGroups = [...own, ...derived].filter(g => g.rows.length > 0);
      return {
        ...n,
        style: QA_CATEGORIES[n.category],
        hosts: env.hosts[n.id] ?? [],
        endpointGroups,
        endpointCount: endpointGroups.reduce((sum, g) => sum + g.rows.length, 0)
      };
    });
  });

  edges = computed<QaEdgeView[]>(() => {
    const env = this.env();
    const present = new Set(this.nodes().map(n => n.id));
    return QA_EDGES
      .filter(e => present.has(e.from) && present.has(e.to))
      .map(e => {
        const id = edgeId(e);
        return {
          ...e,
          id,
          label: env.edgeLabels?.[id] ?? e.label,
          d: 'M ' + e.points.map(p => `${p[0]} ${p[1]}`).join(' L ')
        };
      });
  });

  selectedNode = computed<QaNodeView | null>(() => {
    const id = this.selectedNodeId();
    return id ? this.nodes().find(n => n.id === id) ?? null : null;
  });

  /**
   * Nodes and edge ids to light. A traced endpoint lights its whole route;
   * otherwise a selected box lights every route into it (upstream only).
   */
  private lit = computed<{ nodes: Set<string>; edges: Set<string> } | null>(() => {
    const t = this.trace();
    if (t) return this.wholeRoute(t);
    const id = this.selectedNodeId();
    return id ? this.routesInto(id) : null;
  });

  receivesFrom = computed(() => this.linkedLabels('in'));
  calls = computed(() => this.linkedLabels('out'));

  /** Endpoint groups narrowed by the filter; empty groups are dropped. */
  filteredGroups = computed<QaGroupView[]>(() => {
    const node = this.selectedNode();
    if (!node) return [];
    const q = this.filter().trim().toLowerCase();
    if (!q) return node.endpointGroups;
    return node.endpointGroups
      .map(g => ({ ...g, rows: g.rows.filter(t => this.matches(t, q)) }))
      .filter(g => g.rows.length > 0);
  });

  filteredCount = computed(() =>
    this.filteredGroups().reduce((sum, g) => sum + g.rows.length, 0));

  /**
   * Search hits, best first: exact path; then a catalogued path that a longer pasted
   * one starts with (most specific wins); then anything containing the text.
   */
  results = computed<QaTrace[]>(() => {
    const raw = this.query().trim().toLowerCase();
    if (raw.length < 3) return [];
    const q = normalizePath(raw);
    const scored: [number, QaTrace][] = [];
    for (const t of this.catalogue()) {
      const key = t.key.toLowerCase();
      const to = (t.to ?? '').toLowerCase();
      let score = 0;
      if (key === q || to === q) score = 3;
      else if ((key.split('/').length > 3 && q.startsWith(key + '/')) || (to && q.startsWith(to + '/'))) {
        score = 2 + Math.max(key.length, to.length) / 1e4;
      } else if (key.includes(q) || to.includes(q) || (t.endpoint.notes ?? '').toLowerCase().includes(raw)) {
        score = 1;
      }
      if (score) scored.push([score, t]);
    }
    return scored
      .sort((a, b) => b[0] - a[0] || a[1].key.length - b[1].key.length)
      .slice(0, 40)
      .map(([, t]) => t);
  });

  /** The trace bar: boxes along the route and the path at each gateway. */
  traceView = computed(() => {
    const t = this.trace();
    if (!t) return null;
    const route = QA_ROUTES.find(r => r.id === t.route);
    const label = (id: string) => QA_NODES.find(n => n.id === id)?.label ?? id;
    const chain = route
      ? route.stages.map(s => stageIds(s).map(label).join(' / '))
      : [label(t.owner)];

    const hops: TraceHop[] = [{ label: t.owner === CWH_NODE ? 'CWH APIC receives' : `${label(t.owner)} sends`, path: t.key }];
    const viaCwh = t.route === CWH_ROUTES.cdbbos || t.route === CWH_ROUTES.passThrough;
    // What Akamai forwards to CWH, from the environment's label on that edge (e.g. /api5/cdb/*).
    const akamai = this.edges().find(e => e.to === CWH_NODE)?.label?.replace(/\/\*$/, '');
    if (viaCwh && t.owner !== CWH_NODE && akamai && !akamai.includes('{') && t.key.startsWith('/api/cdb/')) {
      hops.push({ label: 'Akamai → CWH', path: akamai + t.key.slice('/api/cdb'.length) });
    }
    if (t.to && t.to !== t.key) hops.push({ label: 'CWH → CDBBOS', path: t.to });
    if (t.route === CWH_ROUTES.passThrough) {
      hops.push({ label: 'CWH → SSS /api/cdb', path: t.key, note: 'unchanged' },
                { label: 'SSS → Channels AWS', note: 'target not mapped' });
    }
    return { trace: t, chain, routeLabel: route?.label, hops };
  });

  constructor(private router: Router, private hostEl: ElementRef<HTMLElement>) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['sharedParams'] && this.sharedParams) {
      const linked = this.sharedParams['qaenv'];
      if (QA_ENVIRONMENTS.some(e => e.id === linked)) this.envId.set(linked);
    }
    if (changes['active'] && this.active) {
      setTimeout(() => this.fitToScreen(), 0);
    }
  }

  // ── Environment ────────────────────────────────────────────────

  /** Selection and filter survive the switch, so the same box can be compared. */
  setEnv(id: string): void {
    this.envId.set(id);
    if (this.selectedNodeId() && !this.nodes().some(n => n.id === this.selectedNodeId())) {
      this.selectedNodeId.set(null);
    }
    this.router.navigate([], {
      queryParams: { tab: 'traffic', view: 'qa', qaenv: id },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }

  // ── Selection / highlighting ───────────────────────────────────

  onNodeClick(node: QaNodeView, event: MouseEvent): void {
    event.stopPropagation();
    this.trace.set(null);
    const next = this.selectedNodeId() === node.id ? null : node.id;
    this.selectedNodeId.set(next);
    this.filter.set('');
    this.endpointsOpen.set(true);
    if (next) this.scrollDrawerIntoView();
  }

  closeDetails(): void {
    this.selectedNodeId.set(null);
    this.trace.set(null);
  }

  isNodeFaded(id: string): boolean {
    const lit = this.lit();
    return !!lit && !lit.nodes.has(id);
  }

  isEdgeOn(e: QaEdgeView): boolean {
    const lit = this.lit();
    return !!lit && lit.edges.has(e.id);
  }

  isEdgeFaded(e: QaEdgeView): boolean {
    return !!this.lit() && !this.isEdgeOn(e);
  }

  /** Every QA_ROUTES route through the box, from the SPA up to it. */
  private routesInto(id: string): { nodes: Set<string>; edges: Set<string> } {
    const nodes = new Set([id]);
    const edges = new Set<string>();
    for (const route of QA_ROUTES) {
      const at = route.stages.findIndex(s => stageIds(s).includes(id));
      for (let i = 0; i < at; i++) {
        const next = i + 1 === at ? [id] : stageIds(route.stages[i + 1]);
        for (const from of stageIds(route.stages[i])) {
          nodes.add(from);
          next.forEach(to => edges.add(edgeId({ from, to })));
        }
      }
    }
    return { nodes, edges };
  }

  /** A traced endpoint's route end to end, plus the box that lists it. */
  private wholeRoute(t: QaTrace): { nodes: Set<string>; edges: Set<string> } {
    const nodes = new Set([t.owner]);
    const edges = new Set<string>();
    const stages = QA_ROUTES.find(r => r.id === t.route)?.stages ?? [];
    stages.forEach((stage, i) => stageIds(stage).forEach(from => {
      nodes.add(from);
      if (i + 1 < stages.length) stageIds(stages[i + 1]).forEach(to => edges.add(edgeId({ from, to })));
    }));
    return { nodes, edges };
  }

  // ── Tracing an endpoint ────────────────────────────────────────

  /**
   * Lights the endpoint's route. From search it also opens the box that lists it,
   * filtered to that path; from a drawer row the drawer stays as it is.
   */
  traceEndpoint(t: QaTrace, fromDrawer = false): void {
    this.trace.set(t);
    this.query.set(t.endpoint.path);
    this.searchOpen.set(false);
    if (!fromDrawer) {
      this.selectedNodeId.set(t.owner);
      this.filter.set(t.endpoint.path);
      this.endpointsOpen.set(true);
      this.scrollDrawerIntoView();
    }
  }

  clearTrace(): void {
    this.trace.set(null);
    this.query.set('');
  }

  isTraced(t: QaTrace): boolean {
    const current = this.trace();
    return !!current && current.key === t.key && current.route === t.route;
  }

  onSearchInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    this.searchOpen.set(true);
  }

  onSearchKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' && this.results().length) this.traceEndpoint(this.results()[0]);
    if (event.key === 'Escape') this.searchOpen.set(false);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!(event.target as HTMLElement).closest?.('.qtf-search')) this.searchOpen.set(false);
  }

  nodeLabel(id: string): string {
    return QA_NODES.find(n => n.id === id)?.label ?? id;
  }

  private toTrace(n: QaNode, g: QaEndpointGroup, ep: QaEndpoint): QaTrace {
    if (g.route) return this.makeTrace(n.id, g.title, ep, g.route);
    // Client calls go through CWH APIC, which decides from the path where they go.
    const cwh = n.category === 'client' ? cwhRoute(ep.path) : null;
    return this.makeTrace(n.id, g.title, ep, cwh?.route ?? null, cwh?.to);
  }

  private makeTrace(owner: string, group: string, endpoint: QaEndpoint, route: string | null, to?: string): QaTrace {
    const r = route ? QA_ROUTES.find(x => x.id === route) : undefined;
    const destId = r ? stageIds(r.stages[r.stages.length - 1])[0] : owner;
    const dest = QA_NODES.find(n => n.id === destId);
    return {
      owner, group, endpoint, to,
      key: normalizePath(endpoint.path),
      route: r ? r.id : null,
      dest: dest ? { label: dest.label, style: QA_CATEGORIES[dest.category] } : null
    };
  }

  /** Outside fullscreen the drawer opens below the canvas — nudge it into view. */
  private scrollDrawerIntoView(): void {
    if (this.isFullscreen()) return;
    setTimeout(() => {
      this.hostEl.nativeElement.querySelector('.qtf-drawer')
        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 0);
  }

  private linkedLabels(dir: 'in' | 'out'): string[] {
    const id = this.selectedNodeId();
    if (!id) return [];
    const byId = new Map(this.nodes().map(n => [n.id, n.label]));
    return this.edges()
      .filter(e => (dir === 'in' ? e.to : e.from) === id)
      .map(e => byId.get(dir === 'in' ? e.from : e.to) ?? '');
  }

  // ── Endpoints ──────────────────────────────────────────────────

  toggleEndpoints(): void {
    this.endpointsOpen.update(v => !v);
  }

  onFilterInput(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
  }

  private matches(t: QaTrace, q: string): boolean {
    const ep = t.endpoint;
    return ep.path.toLowerCase().includes(q)
      || (t.to ?? '').toLowerCase().includes(q)
      || (ep.notes ?? '').toLowerCase().includes(q)
      || ep.method.toLowerCase() === q;
  }

  /** Splits text around the first filter match for <mark> rendering. */
  highlight(text: string | undefined): TextPart[] {
    const t = text ?? '';
    const q = this.filter().trim().toLowerCase();
    const i = q ? t.toLowerCase().indexOf(q) : -1;
    if (i < 0) return [{ text: t, hit: false }];
    return [
      { text: t.substring(0, i), hit: false },
      { text: t.substring(i, i + q.length), hit: true },
      { text: t.substring(i + q.length), hit: false }
    ];
  }

  copyPath(path: string): void {
    navigator.clipboard.writeText(path).then(() => {
      this.copiedPath.set(path);
      setTimeout(() => {
        if (this.copiedPath() === path) this.copiedPath.set(null);
      }, 1200);
    }).catch(() => {});
  }

  // ── Node text helpers ──────────────────────────────────────────

  /** Host line on the box: one host truncated, or "app051 / 052" for pairs. */
  hostLine(node: QaNodeView): string {
    if (!node.hosts.length) return 'not set';
    if (node.hosts.length === 1) return this.truncate(node.hosts[0], 32);
    const first = node.hosts[0].split('.')[0];
    return `${first} / ${node.hosts[1].split('.')[0].slice(-3)}`;
  }

  subLine(node: QaNodeView): string {
    const n = node.endpointCount;
    const parts = [node.sub, n ? `${n} endpoint${n === 1 ? '' : 's'} ▸` : '']
      .filter(Boolean);
    return parts.join(' · ');
  }

  pillWidth(text: string): number {
    return text.length * 6.1 + 14;
  }

  stepWidth(steps: string): number {
    return Math.max(20, steps.length * 6 + 12);
  }

  /** Left x of the step badge; the label pill follows it, centred as a pair. */
  pillStartX(e: QaEdgeView): number {
    const total = (e.label ? this.pillWidth(e.label) : 0) + (e.steps ? this.stepWidth(e.steps) + 4 : 0);
    return (e.labelAt?.[0] ?? 0) - total / 2;
  }

  truncate(text: string, max: number): string {
    return text.length > max ? text.substring(0, max - 1) + '…' : text;
  }

  trackNode = (_: number, n: QaNodeView) => n.id;
  trackEdge = (_: number, e: QaEdgeView) => e.id;
  trackGroup = (_: number, g: QaGroupView) => g.title;
  trackEndpoint = (_: number, t: QaTrace) => t.endpoint.method + ' ' + t.endpoint.path;

  // ── Pan / zoom (same behaviour as flow-diagram) ────────────────

  private isPanning = false;
  private panStartX = 0;
  private panStartY = 0;
  private panOriginTx = 0;
  private panOriginTy = 0;

  private readonly MIN_K = 0.2;
  private readonly MAX_K = 3;
  private readonly ZOOM_STEP = 0.2;

  zoomIn(): void { this.zoomAtCenter(this.k() + this.ZOOM_STEP); }
  zoomOut(): void { this.zoomAtCenter(this.k() - this.ZOOM_STEP); }

  resetView(): void {
    this.tx.set(0);
    this.ty.set(0);
    this.k.set(1);
  }

  toggleFullscreen(): void {
    this.isFullscreen.update(v => !v);
    setTimeout(() => this.fitToScreen(), 0);
  }

  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    if (this.isFullscreen()) {
      this.isFullscreen.set(false);
      setTimeout(() => this.fitToScreen(), 0);
    }
  }

  fitToScreen(): void {
    if (!this.svgEl) return;
    const rect = this.svgEl.nativeElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const margin = 20;
    const k = this.clampK(Math.min(
      (rect.width - margin * 2) / QA_CANVAS.width,
      (rect.height - margin * 2) / QA_CANVAS.height,
      1
    ));
    this.k.set(k);
    this.tx.set((rect.width - QA_CANVAS.width * k) / 2 - QA_CANVAS.x * k);
    this.ty.set((rect.height - QA_CANVAS.height * k) / 2 - QA_CANVAS.y * k);
  }

  private zoomAtCenter(newK: number): void {
    if (!this.svgEl) { this.k.set(this.clampK(newK)); return; }
    const rect = this.svgEl.nativeElement.getBoundingClientRect();
    this.zoomAtPoint(newK, rect.width / 2, rect.height / 2);
  }

  private zoomAtPoint(newK: number, px: number, py: number): void {
    const clamped = this.clampK(newK);
    const oldK = this.k();
    if (clamped === oldK) return;
    const gx = (px - this.tx()) / oldK;
    const gy = (py - this.ty()) / oldK;
    this.tx.set(px - gx * clamped);
    this.ty.set(py - gy * clamped);
    this.k.set(clamped);
  }

  private clampK(k: number): number {
    return Math.max(this.MIN_K, Math.min(this.MAX_K, k));
  }

  onMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return;
    this.isPanning = true;
    this.panStartX = event.clientX;
    this.panStartY = event.clientY;
    this.panOriginTx = this.tx();
    this.panOriginTy = this.ty();
    event.preventDefault();
  }

  onMouseMove(event: MouseEvent): void {
    if (!this.isPanning) return;
    this.tx.set(this.panOriginTx + event.clientX - this.panStartX);
    this.ty.set(this.panOriginTy + event.clientY - this.panStartY);
  }

  onMouseUp(): void { this.isPanning = false; }
  onMouseLeave(): void { this.isPanning = false; }

  onWheel(event: WheelEvent): void {
    event.preventDefault();
    if (!this.svgEl) return;
    const rect = this.svgEl.nativeElement.getBoundingClientRect();
    const delta = event.deltaY < 0 ? this.ZOOM_STEP : -this.ZOOM_STEP;
    this.zoomAtPoint(this.k() + delta, event.clientX - rect.left, event.clientY - rect.top);
  }
}
