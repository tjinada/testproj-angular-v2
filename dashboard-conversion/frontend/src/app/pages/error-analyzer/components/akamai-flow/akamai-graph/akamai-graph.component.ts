import {
  Component,
  ElementRef,
  HostListener,
  Input,
  OnChanges,
  ViewChild,
  computed,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import type { FlowHop } from '../../../models/akamai.model';
import { buildAkamaiFlowGraph, AkGraph, AkNode, AkEdge } from './akamai-flow-layout';

/**
 * Renders the Akamai request-to-origin flow as a pan/zoom SVG, matching
 * the Dynatrace flow-diagram interaction model. Labelled nodes + edges
 * only — no click-to-expand detail panel.
 */
@Component({
  selector: 'app-akamai-graph',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './akamai-graph.component.html',
  styleUrls: ['./akamai-graph.component.scss']
})
export class AkamaiGraphComponent implements OnChanges {
  @Input() flow: FlowHop[] = [];

  @ViewChild('svgEl', { static: false }) svgEl?: ElementRef<SVGSVGElement>;

  graph = signal<AkGraph>({ nodes: [], edges: [], width: 0, height: 0 });
  tx = signal(0);
  ty = signal(0);
  k = signal(1);
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

  ngOnChanges(): void {
    this.graph.set(buildAkamaiFlowGraph(this.flow || []));
    queueMicrotask(() => this.fitToScreen());
  }

  // ── Edge geometry ──────────────────────────────────────────────

  private node(id: string): AkNode | undefined {
    return this.graph().nodes.find(n => n.id === id);
  }

  private isVertical(s: AkNode, t: AkNode): boolean {
    return t.y - s.y > s.height / 2 + 10;
  }

  edgePath(edge: AkEdge): string {
    const s = this.node(edge.sourceId);
    const t = this.node(edge.targetId);
    if (!s || !t) return '';
    if (this.isVertical(s, t)) {
      const x1 = s.x, y1 = s.y + s.height / 2;
      const x2 = t.x, y2 = t.y - t.height / 2;
      const my = (y1 + y2) / 2;
      return `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
    }
    const x1 = s.x + s.width / 2, y1 = s.y;
    const x2 = t.x - t.width / 2, y2 = t.y;
    const mx = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
  }

  edgeLabelX(edge: AkEdge): number {
    const s = this.node(edge.sourceId);
    const t = this.node(edge.targetId);
    if (!s || !t) return 0;
    return this.isVertical(s, t)
      ? (s.x + t.x) / 2
      : (s.x + s.width / 2 + (t.x - t.width / 2)) / 2;
  }

  edgeLabelY(edge: AkEdge): number {
    const s = this.node(edge.sourceId);
    const t = this.node(edge.targetId);
    if (!s || !t) return 0;
    return this.isVertical(s, t)
      ? (s.y + s.height / 2 + (t.y - t.height / 2)) / 2
      : s.y - 8;
  }

  // ── Node text line positions ───────────────────────────────────

  nodeTop(node: AkNode): number {
    return node.y - node.height / 2;
  }

  titleY(node: AkNode): number {
    return this.nodeTop(node) + 22;
  }

  detailY(node: AkNode): number {
    return this.titleY(node) + 18;
  }

  annotationY(node: AkNode, index: number): number {
    return this.detailY(node) + 16 * (index + 1);
  }

  truncate(text: string, max: number): string {
    if (!text) return '';
    return text.length > max ? text.substring(0, max - 1) + '\u2026' : text;
  }

  // ── Pan / zoom / fit ───────────────────────────────────────────

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
    const g = this.graph();
    if (!g.nodes.length || !this.svgEl) return;
    const rect = this.svgEl.nativeElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const margin = 20;
    const k = Math.min((rect.width - margin * 2) / g.width, (rect.height - margin * 2) / g.height, 1);
    const clampedK = this.clampK(k);
    this.k.set(clampedK);
    this.tx.set((rect.width - g.width * clampedK) / 2);
    this.ty.set((rect.height - g.height * clampedK) / 2);
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
    this.tx.set(this.panOriginTx + (event.clientX - this.panStartX));
    this.ty.set(this.panOriginTy + (event.clientY - this.panStartY));
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

  trackNode = (_: number, n: AkNode) => n.id;
  trackEdge = (_: number, e: AkEdge) => e.id;
}
