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

/** A node resolved against the selected environment. */
export interface QaNodeView extends QaNode {
  style: QaCategoryStyle;
  hosts: string[];
  endpointGroups: QaEndpointGroup[];
  endpointCount: number;
}

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

  envId = signal(DEFAULT_QA_ENV);
  selectedNodeId = signal<string | null>(null);
  filter = signal('');
  endpointsOpen = signal(true);
  copiedPath = signal<string | null>(null);
  isFullscreen = signal(false);

  tx = signal(0);
  ty = signal(0);
  k = signal(1);
  transform = computed(() => `translate(${this.tx()} ${this.ty()}) scale(${this.k()})`);

  env = computed<QaEnvProfile>(() =>
    QA_ENVIRONMENTS.find(e => e.id === this.envId()) ?? QA_ENVIRONMENTS[0]);

  nodes = computed<QaNodeView[]>(() => {
    const env = this.env();
    const absent = new Set(env.absent ?? []);
    return QA_NODES.filter(n => !absent.has(n.id)).map(n => {
      const endpointGroups = env.endpoints?.[n.id] ?? QA_SHARED_ENDPOINTS[n.id] ?? [];
      return {
        ...n,
        style: QA_CATEGORIES[n.category],
        hosts: env.hosts[n.id] ?? [],
        endpointGroups,
        endpointCount: endpointGroups.reduce((sum, g) => sum + g.endpoints.length, 0)
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
   * Nodes and edge ids lit for the selected node: each QA_ROUTES route through
   * it, from the SPA up to that node. Downstream callees are deliberately
   * excluded. Null when nothing is selected.
   */
  private highlight = computed<{ nodes: Set<string>; edges: Set<string> } | null>(() => {
    const id = this.selectedNodeId();
    if (!id) return null;
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
  });

  receivesFrom = computed(() => this.linkedLabels('in'));
  calls = computed(() => this.linkedLabels('out'));

  /** Endpoint groups narrowed by the filter; empty groups are dropped. */
  filteredGroups = computed<QaEndpointGroup[]>(() => {
    const node = this.selectedNode();
    if (!node) return [];
    const q = this.filter().trim().toLowerCase();
    if (!q) return node.endpointGroups;
    return node.endpointGroups
      .map(g => ({ ...g, endpoints: g.endpoints.filter(ep => this.matches(ep, q)) }))
      .filter(g => g.endpoints.length > 0);
  });

  filteredCount = computed(() =>
    this.filteredGroups().reduce((sum, g) => sum + g.endpoints.length, 0));

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
    const next = this.selectedNodeId() === node.id ? null : node.id;
    this.selectedNodeId.set(next);
    this.filter.set('');
    this.endpointsOpen.set(true);
    // Outside fullscreen the drawer opens below the canvas — nudge it into view.
    if (next && !this.isFullscreen()) {
      setTimeout(() => {
        this.hostEl.nativeElement.querySelector('.qtf-drawer')
          ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 0);
    }
  }

  closeDetails(): void {
    this.selectedNodeId.set(null);
  }

  isNodeFaded(id: string): boolean {
    const lit = this.highlight();
    return !!lit && !lit.nodes.has(id);
  }

  /** On a route into the selected node. */
  isEdgeOn(e: QaEdgeView): boolean {
    const lit = this.highlight();
    return !!lit && lit.edges.has(e.id);
  }

  isEdgeFaded(e: QaEdgeView): boolean {
    return !!this.selectedNodeId() && !this.isEdgeOn(e);
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

  private matches(ep: QaEndpoint, q: string): boolean {
    return ep.path.toLowerCase().includes(q)
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
  trackGroup = (_: number, g: QaEndpointGroup) => g.title;
  trackEndpoint = (_: number, ep: QaEndpoint) => ep.method + ' ' + ep.path;

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
