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
import { SpanRecord, SpanEvent } from '../../models/trace.model';
import { buildFlowGraph, findConnectedNodeIds, FlowGraph, FlowNode, FlowEdge } from './flow-layout';
import { isSpanFailed } from '../../services/trace-analyzer';

/** A row in the per-node span timeline. */
export interface TimelineEntry {
  spanId: string;
  kind: string;        // server | client | internal | producer | consumer | ...
  name: string;        // endpoint.name or span.name
  status: string;      // http status, or '' if none
  durationNanos: number;
  isFailed: boolean;
}

/** Extracted error detail for a single failing span. */
export interface FailingSpanDetail {
  spanId: string;
  endpointName: string;
  httpMethod: string;
  httpStatus: string;
  urlPath: string;
  urlFull: string;       // only populated for POST spans
  serverAddress: string;
  exceptionType: string;
  exceptionMessage: string;
  stackTrace: string;
}

@Component({
  selector: 'app-flow-diagram',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './flow-diagram.component.html',
  styleUrls: ['./flow-diagram.component.css']
})
export class FlowDiagramComponent implements OnChanges {
  @Input() spans: SpanRecord[] = [];
  @Input() rootCauseService: string | null = null;

  @ViewChild('svgEl', { static: false }) svgEl?: ElementRef<SVGSVGElement>;
  @ViewChild('flowBarEl', { static: false }) flowBarEl?: ElementRef<HTMLDivElement>;

  // Flow bar scroll state
  flowBarOverflows = signal(false);
  flowBarScrolledEnd = signal(false);

  // View state (signals)
  graph = signal<FlowGraph>({ nodes: [], edges: [], width: 0, height: 0 });
  tx = signal(0);
  ty = signal(0);
  k = signal(1);
  selectedNodeId = signal<string | null>(null);
  isFullscreen = signal(false);

  // Pan state (not in signals — purely transient interaction state)
  private isPanning = false;
  private panStartX = 0;
  private panStartY = 0;
  private panOriginTx = 0;
  private panOriginTy = 0;

  // Constants
  private readonly MIN_K = 0.2;
  private readonly MAX_K = 3;
  private readonly ZOOM_STEP = 0.2;

  transform = computed(() => `translate(${this.tx()} ${this.ty()}) scale(${this.k()})`);

  selectedNode = computed<FlowNode | null>(() => {
    const id = this.selectedNodeId();
    if (!id) return null;
    return this.graph().nodes.find(n => n.id === id) || null;
  });

  /**
   * Timeline rows for the currently selected node, sorted by start_time.
   * Returns an empty array for external nodes (no underlying spans) or
   * when nothing is selected.
   */
  nodeTimeline = computed<TimelineEntry[]>(() => {
    const node = this.selectedNode();
    if (!node || node.isExternal || !node.spans?.length) return [];
    return [...node.spans]
      .sort((a, b) =>
        new Date(a['start_time']).getTime() - new Date(b['start_time']).getTime()
      )
      .map(s => {
        // Use server.address + url.path when endpoint name is generic
        const GENERIC_NAMES = ['invoke', 'POST', 'GET', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
        const rawName = s['endpoint.name'] || s['span.name'] || '';
        let name = rawName;
        if (!rawName || GENERIC_NAMES.includes(rawName)) {
          const addr = (s['server.address'] as string) || '';
          const path = (s['url.path'] as string) || '';
          if (addr && path) name = `${addr}${path}`;
          else if (path) name = path;
          else if (addr) name = addr;
          else name = rawName || '(unnamed)';
        }
        return {
          spanId: s['span.id'],
          kind: s['span.kind'] || 'unknown',
          name,
          status: String(s['http.response.status_code'] ?? ''),
          durationNanos: Number(s['duration']) || 0,
          isFailed: isSpanFailed(s)
        };
      });
  });

  /**
   * Set of node IDs that are "connected" to the currently selected node
   * via a server-span-to-server-span walk through the raw spans. The walk
   * hops through non-server (client/internal) intermediaries until it hits
   * the next server span at each step. See findConnectedNodeIds() in
   * flow-layout.ts for the full rule.
   *
   * Returns null when nothing is selected, which the template uses to
   * mean "no fading at all".
   */
  highlightedNodeIds = computed<Set<string> | null>(() => {
    const id = this.selectedNodeId();
    if (!id) return null;
    return findConnectedNodeIds(this.spans || [], id);
  });

  /**
   * Error details for all failing spans in the currently selected node.
   * Immediately visible on click — no expand needed.
   */
  nodeFailingSpans = computed<FailingSpanDetail[]>(() => {
    const node = this.selectedNode();
    if (!node || node.isExternal || !node.spans?.length) return [];
    return node.spans
      .filter(isSpanFailed)
      .sort((a, b) =>
        new Date(a['start_time']).getTime() - new Date(b['start_time']).getTime()
      )
      .map(s => {
        // Extract exception info from span.events
        const events = s['span.events'] || [];
        const exEvent = events.find(
          (e: SpanEvent) => e['span_event.name'] === 'exception'
        );
        const exType = exEvent?.['exception.type'] || '';
        const exMessage = exEvent?.['exception.message'] || '';
        // Stack trace: code.call_stack or exception.stack_trace from event
        const stackTrace = (s['code.call_stack'] as string) ||
          exEvent?.['exception.stack_trace'] || '';
        const method = (s['http.request.method'] as string) || '';
        // Use server.address + url.path when endpoint.name is generic
        const GENERIC = ['invoke', 'POST', 'GET', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
        const rawEp = s['endpoint.name'] || s['span.name'] || '';
        const addr = (s['server.address'] as string) || '';
        const path = (s['url.path'] as string) || '';
        let endpointName = rawEp;
        if (!rawEp || GENERIC.includes(rawEp)) {
          if (addr && path) endpointName = `${addr}${path}`;
          else if (path) endpointName = path;
          else if (addr) endpointName = addr;
          else endpointName = rawEp || '(unnamed)';
        }
        return {
          spanId: s['span.id'],
          endpointName,
          httpMethod: method,
          httpStatus: String(s['http.response.status_code'] ?? ''),
          urlPath: (s['url.path'] as string) || '',
          urlFull: method.toUpperCase() === 'POST'
            ? (s['url.full'] as string) || '' : '',
          serverAddress: (s['server.address'] as string) || '',
          exceptionType: exType,
          exceptionMessage: exMessage,
          stackTrace
        };
      });
  });

  /** Tracks which collapsible sections are expanded in the details panel. */
  expandedSections = signal<Set<string>>(new Set());

  toggleSection(sectionId: string): void {
    this.expandedSections.update(prev => {
      const next = new Set(prev);
      if (next.has(sectionId)) next.delete(sectionId);
      else next.add(sectionId);
      return next;
    });
  }

  isSectionExpanded(sectionId: string): boolean {
    return this.expandedSections().has(sectionId);
  }

  /** Number of failing spans that have a stack trace available. */
  stackTraceCount = computed<number>(() => {
    return this.nodeFailingSpans().filter(f => !!f.stackTrace).length;
  });

  /**
   * Enriched endpoint list for the drawer metadata. Shows endpoint name
   * with server.address + url.path underneath when both are available
   * and the endpoint name is not already the path.
   */
  nodeEndpoints = computed<Array<{ name: string; path: string }>>(() => {
    const node = this.selectedNode();
    if (!node || node.isExternal || !node.spans?.length) return [];
    const GENERIC = new Set(['invoke', 'POST', 'GET', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
    const seen = new Set<string>();
    const result: Array<{ name: string; path: string }> = [];
    for (const s of node.spans) {
      if (s['span.kind'] !== 'server') continue;
      const epName = s['endpoint.name'] || s['span.name'] || '';
      const addr = (s['server.address'] as string) || '';
      const urlPath = (s['url.path'] as string) || '';
      const fullPath = addr && urlPath ? `${addr}${urlPath}` : urlPath || addr;
      // Determine display name and secondary path
      let name: string;
      let path: string;
      if (!epName || GENERIC.has(epName)) {
        // Generic endpoint — use path as the name, no secondary
        name = fullPath || epName || '(unnamed)';
        path = '';
      } else {
        // Meaningful endpoint — show it with path underneath
        name = epName;
        path = fullPath;
      }
      const key = `${name}|${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ name, path });
    }
    return result;
  });

  /**
   * Upstream call chain from the trace root to the selected node.
   * Returns an ordered array of service names, e.g.:
   *   ['Apache Web Server', 'CDBBOS-BG (/banking)', 'MoneyTransferController']
   * The last entry is always the selected node itself.
   * For external/DB nodes, walks up from the client spans that target them.
   */
  endpointFlow = computed<Array<{ service: string; path: string; isFailed: boolean }>>(() => {
    const nodeId = this.selectedNodeId();
    if (!nodeId || !this.spans?.length) return [];

    const spanById = new Map<string, SpanRecord>();
    for (const s of this.spans) spanById.set(s['span.id'], s);

    const getService = (s: SpanRecord): string =>
      (s['dt.entity.service.entity.name'] as string) ||
      (s['dt.service.name'] as string) ||
      (s['dt.entity.service'] as string) ||
      'Unknown';

    // Find starting spans for the selected node
    let startSpans: SpanRecord[] = [];
    if (nodeId.startsWith('db:')) {
      const ns = nodeId.substring(3);
      startSpans = this.spans.filter(
        s => s['span.kind'] === 'client' && String(s['db.namespace'] ?? '') === ns
      );
    } else if (nodeId.startsWith('ext:')) {
      const host = nodeId.substring(4);
      startSpans = this.spans.filter(
        s => s['span.kind'] === 'client' && !s['db.namespace'] &&
             String(s['server.address'] ?? '') === host
      );
    } else {
      startSpans = this.spans.filter(s => getService(s) === nodeId);
    }

    if (startSpans.length === 0) return [{ service: nodeId, path: '', isFailed: false }];

    // Walk strictly up from the earliest start span to build the chain.
    // Pick the span with the earliest start_time for a consistent path.
    const earliest = startSpans.reduce((a, b) =>
      new Date(a['start_time']).getTime() <= new Date(b['start_time']).getTime() ? a : b
    );

    // Walk up via parent_id, collecting service + path + status
    const chain: Array<{ service: string; path: string; isFailed: boolean }> = [];
    const visited = new Set<string>();
    let current: SpanRecord | undefined = earliest;
    while (current) {
      if (visited.has(current['span.id'])) break;
      visited.add(current['span.id']);
      const svc = getService(current);
      const addr = (current['server.address'] as string) || '';
      const urlPath = (current['url.path'] as string) || '';
      const path = addr && urlPath ? `${addr}${urlPath}` : urlPath || addr;
      const failed = isSpanFailed(current);
      // Only add if different service from the last entry
      if (chain.length === 0 || chain[chain.length - 1].service !== svc) {
        chain.push({ service: svc, path, isFailed: failed });
      } else {
        // Same service - update path/failed if this span has better info
        const last = chain[chain.length - 1];
        if (!last.path && path) last.path = path;
        if (failed) last.isFailed = true;
      }
      const pid = current['span.parent_id'];
      if (!pid) break;
      current = spanById.get(pid);
    }

    // Chain is built bottom-up (selected → root), reverse it
    chain.reverse();

    // For external/DB nodes, append the synthetic node label at the end
    if (nodeId.startsWith('db:') || nodeId.startsWith('ext:')) {
      const node = this.graph().nodes.find(n => n.id === nodeId);
      if (node) chain.push({ service: node.label, path: '', isFailed: false });
    }

    return chain;
  });

  isNodeFaded(nodeId: string): boolean {
    const set = this.highlightedNodeIds();
    if (!set) return false;
    return !set.has(nodeId);
  }

  isEdgeFaded(edge: FlowEdge): boolean {
    const set = this.highlightedNodeIds();
    if (!set) return false;
    return !(set.has(edge.sourceId) && set.has(edge.targetId));
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['spans'] || changes['rootCauseService']) {
      const g = buildFlowGraph(this.spans || [], this.rootCauseService);
      this.graph.set(g);
      this.selectedNodeId.set(null);
      // Defer fit so the svg has dimensions
      queueMicrotask(() => this.fitToScreen());
    }
  }

  // --- Zoom controls ------------------------------------------------------

  zoomIn(): void {
    this.zoomAtCenter(this.k() + this.ZOOM_STEP);
  }

  zoomOut(): void {
    this.zoomAtCenter(this.k() - this.ZOOM_STEP);
  }

  resetView(): void {
    this.tx.set(0);
    this.ty.set(0);
    this.k.set(1);
  }

  // --- Fullscreen ---------------------------------------------------------

  toggleFullscreen(): void {
    this.isFullscreen.update(v => !v);
    // After the layout settles in the new container size, refit so the
    // diagram makes use of the available space.
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
    const g = this.graph();
    if (!g.nodes.length || !this.svgEl) return;
    const svg = this.svgEl.nativeElement;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const margin = 20;
    const scaleX = (rect.width - margin * 2) / g.width;
    const scaleY = (rect.height - margin * 2) / g.height;
    const k = Math.min(scaleX, scaleY, 1); // never auto-zoom past 1:1
    const clampedK = Math.max(this.MIN_K, Math.min(this.MAX_K, k));

    const tx = (rect.width - g.width * clampedK) / 2;
    const ty = (rect.height - g.height * clampedK) / 2;

    this.k.set(clampedK);
    this.tx.set(tx);
    this.ty.set(ty);
  }

  private zoomAtCenter(newK: number): void {
    if (!this.svgEl) {
      this.k.set(this.clampK(newK));
      return;
    }
    const rect = this.svgEl.nativeElement.getBoundingClientRect();
    this.zoomAtPoint(newK, rect.width / 2, rect.height / 2);
  }

  private zoomAtPoint(newK: number, px: number, py: number): void {
    const clamped = this.clampK(newK);
    const oldK = this.k();
    if (clamped === oldK) return;
    // Keep the graph coord under (px, py) stationary:
    // px = tx + gx * k  =>  gx = (px - tx) / k
    const gx = (px - this.tx()) / oldK;
    const gy = (py - this.ty()) / oldK;
    this.tx.set(px - gx * clamped);
    this.ty.set(py - gy * clamped);
    this.k.set(clamped);
  }

  private clampK(k: number): number {
    return Math.max(this.MIN_K, Math.min(this.MAX_K, k));
  }

  // --- Pan ----------------------------------------------------------------

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
    const dx = event.clientX - this.panStartX;
    const dy = event.clientY - this.panStartY;
    this.tx.set(this.panOriginTx + dx);
    this.ty.set(this.panOriginTy + dy);
  }

  onMouseUp(): void {
    this.isPanning = false;
  }

  onMouseLeave(): void {
    this.isPanning = false;
  }

  // --- Wheel zoom ---------------------------------------------------------

  onWheel(event: WheelEvent): void {
    event.preventDefault();
    if (!this.svgEl) return;
    const rect = this.svgEl.nativeElement.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const delta = event.deltaY < 0 ? this.ZOOM_STEP : -this.ZOOM_STEP;
    this.zoomAtPoint(this.k() + delta, px, py);
  }

  // --- Selection ----------------------------------------------------------

  onNodeClick(node: FlowNode, event: MouseEvent): void {
    event.stopPropagation();
    const current = this.selectedNodeId();
    this.selectedNodeId.set(current === node.id ? null : node.id);
    // Reset expanded sections when switching nodes
    this.expandedSections.set(new Set());
    // Check flow bar overflow after DOM updates
    queueMicrotask(() => this.checkFlowBarOverflow());
  }

  closeDetails(): void {
    this.selectedNodeId.set(null);
  }

  // --- Flow bar scroll detection ------------------------------------------

  checkFlowBarOverflow(): void {
    const el = this.flowBarEl?.nativeElement;
    if (!el) { this.flowBarOverflows.set(false); return; }
    const overflows = el.scrollWidth > el.clientWidth + 2;
    this.flowBarOverflows.set(overflows);
    this.flowBarScrolledEnd.set(!overflows || el.scrollLeft + el.clientWidth >= el.scrollWidth - 2);
  }

  onFlowBarScroll(): void {
    const el = this.flowBarEl?.nativeElement;
    if (!el) return;
    this.flowBarScrolledEnd.set(el.scrollLeft + el.clientWidth >= el.scrollWidth - 2);
  }

  // --- Edge geometry ------------------------------------------------------

  /** Simple straight line from source right-edge to target left-edge. */
  edgePath(edge: FlowEdge): string {
    const g = this.graph();
    const src = g.nodes.find(n => n.id === edge.sourceId);
    const tgt = g.nodes.find(n => n.id === edge.targetId);
    if (!src || !tgt) return '';
    const x1 = src.x + src.width / 2;
    const y1 = src.y;
    const x2 = tgt.x - tgt.width / 2;
    const y2 = tgt.y;
    // Bezier curve for nicer look
    const mx = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
  }

  // --- Template helpers ---------------------------------------------------

  truncate(text: string, max: number): string {
    if (!text) return '';
    return text.length > max ? text.substring(0, max - 1) + '…' : text;
  }

  formatDuration(nanos: number): string {
    if (!nanos) return '';
    if (nanos < 1_000_000) return `${Math.round(nanos / 1000)}µs`;
    if (nanos < 1_000_000_000) return `${Math.round(nanos / 1_000_000)}ms`;
    return `${(nanos / 1_000_000_000).toFixed(2)}s`;
  }

  trackTimeline = (_: number, t: TimelineEntry) => t.spanId;
  trackFailingSpan = (_: number, f: FailingSpanDetail) => f.spanId;

  trackNode = (_: number, n: FlowNode) => n.id;
  trackEdge = (_: number, e: FlowEdge) => e.id;
}
