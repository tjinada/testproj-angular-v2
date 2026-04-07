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
import { SpanRecord } from '../../models/trace.model';
import { buildFlowGraph, FlowGraph, FlowNode, FlowEdge } from './flow-layout';
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
      .map(s => ({
        spanId: s['span.id'],
        kind: s['span.kind'] || 'unknown',
        name: s['endpoint.name'] || s['span.name'] || '(unnamed)',
        status: String(s['http.response.status_code'] ?? ''),
        durationNanos: Number(s['duration']) || 0,
        isFailed: isSpanFailed(s)
      }));
  });

  /**
   * Set of node IDs that are "connected" to the currently selected node:
   * the selected node itself plus everything reachable from it via edges
   * in either direction (full bidirectional reachable subgraph).
   *
   * Returns null when nothing is selected, which the template uses to
   * mean "no fading at all".
   */
  highlightedNodeIds = computed<Set<string> | null>(() => {
    const id = this.selectedNodeId();
    if (!id) return null;

    const g = this.graph();
    const reachable = new Set<string>([id]);
    const queue: string[] = [id];

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of g.edges) {
        if (edge.sourceId === current && !reachable.has(edge.targetId)) {
          reachable.add(edge.targetId);
          queue.push(edge.targetId);
        }
        if (edge.targetId === current && !reachable.has(edge.sourceId)) {
          reachable.add(edge.sourceId);
          queue.push(edge.sourceId);
        }
      }
    }
    return reachable;
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
  }

  closeDetails(): void {
    this.selectedNodeId.set(null);
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

  trackNode = (_: number, n: FlowNode) => n.id;
  trackEdge = (_: number, e: FlowEdge) => e.id;
}
