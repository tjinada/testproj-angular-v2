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
import { SpanRecord, SpanEvent, CapturedException } from '../../models/trace.model';
import { buildFlowGraph, findConnectedNodeIds, FlowGraph, FlowNode, FlowEdge } from './flow-layout';
import { isSpanFailed, extractCapturedExceptions } from '../../services/trace-analyzer';

/** A row in the per-node span timeline. */
export interface TimelineEntry {
  spanId: string;
  kind: string;
  name: string;
  status: string;
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
  urlFull: string;
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
  styleUrls: ['./flow-diagram.component.scss']
})
export class FlowDiagramComponent implements OnChanges {
  @Input() spans: SpanRecord[] = [];
  @Input() rootCauseService: string | null = null;

  @ViewChild('svgEl', { static: false }) svgEl?: ElementRef<SVGSVGElement>;
  @ViewChild('flowBarEl', { static: false }) flowBarEl?: ElementRef<HTMLDivElement>;

  constructor(private hostEl: ElementRef<HTMLElement>) {}

  flowBarOverflows = signal(false);
  flowBarScrolledEnd = signal(false);

  graph = signal<FlowGraph>({ nodes: [], edges: [], width: 0, height: 0 });
  tx = signal(0);
  ty = signal(0);
  k = signal(1);
  selectedNodeId = signal<string | null>(null);
  isFullscreen = signal(false);

  private isPanning = false;
  private panStartX = 0;
  private panStartY = 0;
  private panOriginTx = 0;
  private panOriginTy = 0;

  private readonly MIN_K = 0.2;
  private readonly MAX_K = 3;
  private readonly ZOOM_STEP = 0.2;

  transform = computed(() => `translate(${this.tx()} ${this.ty()}) scale(${this.k()})`);

  selectedNode = computed<FlowNode | null>(() => {
    const id = this.selectedNodeId();
    if (!id) return null;
    return this.graph().nodes.find(n => n.id === id) || null;
  });

  nodeTimeline = computed<TimelineEntry[]>(() => {
    const node = this.selectedNode();
    if (!node || node.isExternal || !node.spans?.length) return [];
    return [...node.spans]
      .sort((a, b) =>
        new Date(a['start_time']).getTime() - new Date(b['start_time']).getTime()
      )
      .map(s => {
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

  highlightedNodeIds = computed<Set<string> | null>(() => {
    const id = this.selectedNodeId();
    if (!id) return null;
    return findConnectedNodeIds(this.spans || [], id);
  });

  nodeFailingSpans = computed<FailingSpanDetail[]>(() => {
    const node = this.selectedNode();
    if (!node || node.isExternal || !node.spans?.length) return [];
    return node.spans
      .filter(isSpanFailed)
      .sort((a, b) =>
        new Date(a['start_time']).getTime() - new Date(b['start_time']).getTime()
      )
      .map(s => {
        const events = s['span.events'] || [];
        const exEvent = events.find(
          (e: SpanEvent) => e['span_event.name'] === 'exception'
        );
        const exType = exEvent?.['exception.type'] || '';
        const exMessage = exEvent?.['exception.message'] || '';
        const stackTrace = (s['code.call_stack'] as string) ||
          exEvent?.['exception.stack_trace'] || '';
        const method = (s['http.request.method'] as string) || '';
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

  stackTraceCount = computed<number>(() => {
    return this.nodeFailingSpans().filter(f => !!f.stackTrace).length;
  });

  nodeCapturedExceptions = computed<CapturedException[]>(() => {
    const node = this.selectedNode();
    if (!node || node.isExternal || !node.spans?.length) return [];
    const failingSpanIds = new Set(this.nodeFailingSpans().map(f => f.spanId));
    return extractCapturedExceptions(node.spans)
      .filter(ex => !failingSpanIds.has(ex.spanId));
  });

  nodeRequestIds = computed<string[]>(() => {
    const node = this.selectedNode();
    if (!node || node.isExternal || !node.spans?.length) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of node.spans) {
      const rid = s['http.request.header.x-request-id'] as string | undefined;
      if (!rid) continue;
      if (seen.has(rid)) continue;
      seen.add(rid);
      out.push(rid);
    }
    return out;
  });

  copiedValue = signal<string | null>(null);

  copyToClipboard(value: string): void {
    if (!value) return;
    navigator.clipboard.writeText(value).then(() => {
      this.copiedValue.set(value);
      setTimeout(() => {
        if (this.copiedValue() === value) this.copiedValue.set(null);
      }, 1500);
    }).catch(() => {});
  }

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
      let name: string;
      let path: string;
      if (!epName || GENERIC.has(epName)) {
        name = fullPath || epName || '(unnamed)';
        path = '';
      } else {
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

    const earliest = startSpans.reduce((a, b) =>
      new Date(a['start_time']).getTime() <= new Date(b['start_time']).getTime() ? a : b
    );

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
      if (chain.length === 0 || chain[chain.length - 1].service !== svc) {
        chain.push({ service: svc, path, isFailed: failed });
      } else {
        const last = chain[chain.length - 1];
        if (!last.path && path) last.path = path;
        if (failed) last.isFailed = true;
      }
      const pid = current['span.parent_id'];
      if (!pid) break;
      current = spanById.get(pid);
    }

    chain.reverse();

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
      queueMicrotask(() => this.fitToScreen());
    }
  }

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
    const g = this.graph();
    if (!g.nodes.length || !this.svgEl) return;
    const svg = this.svgEl.nativeElement;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const margin = 20;
    const scaleX = (rect.width - margin * 2) / g.width;
    const scaleY = (rect.height - margin * 2) / g.height;
    const k = Math.min(scaleX, scaleY, 1);
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

  onWheel(event: WheelEvent): void {
    event.preventDefault();
    if (!this.svgEl) return;
    const rect = this.svgEl.nativeElement.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const delta = event.deltaY < 0 ? this.ZOOM_STEP : -this.ZOOM_STEP;
    this.zoomAtPoint(this.k() + delta, px, py);
  }

  onNodeClick(node: FlowNode, event: MouseEvent): void {
    event.stopPropagation();
    const current = this.selectedNodeId();
    this.selectedNodeId.set(current === node.id ? null : node.id);
    this.expandedSections.set(new Set());
    queueMicrotask(() => this.checkFlowBarOverflow());
    // Outside fullscreen the drawer opens below the full-height canvas,
    // possibly under the fold — nudge the page so it's visible. 'nearest'
    // scrolls the minimum amount and is a no-op if already on screen.
    if (this.selectedNodeId() !== null && !this.isFullscreen()) {
      setTimeout(() => {
        this.hostEl.nativeElement.querySelector('.flow-drawer')
          ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 0);
    }
  }

  closeDetails(): void {
    this.selectedNodeId.set(null);
  }

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

  edgePath(edge: FlowEdge): string {
    const g = this.graph();
    const src = g.nodes.find(n => n.id === edge.sourceId);
    const tgt = g.nodes.find(n => n.id === edge.targetId);
    if (!src || !tgt) return '';
    const x1 = src.x + src.width / 2;
    const y1 = src.y;
    const x2 = tgt.x - tgt.width / 2;
    const y2 = tgt.y;
    const mx = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
  }

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
  trackCapturedException = (_: number, e: CapturedException) => e.spanId + '|' + e.exceptionType;

  trackNode = (_: number, n: FlowNode) => n.id;
  trackEdge = (_: number, e: FlowEdge) => e.id;
}