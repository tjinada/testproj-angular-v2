import { ChangeDetectionStrategy, Component, Input, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import type {
  GtmId, LivenessState, PoolMonitor, SessionKind, SimState, SiteId, TrafficPath
} from '../../models/traffic-flow.model';
import { resolveTraffic } from '../../services/traffic-resolver';
import { buildTrafficGraph, TfNode, TfPill } from './traffic-flow-layout';
import { APP_SERVERS, SITE_IDS, defaultSimState, nodeLabel } from './traffic-topology';

@Component({
  selector: 'app-traffic-flow',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './traffic-flow.component.html',
  styleUrls: ['./traffic-flow.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class TrafficFlowComponent implements OnInit {
  /** Query params from the Error Analyzer route, used to restore a shared link. */
  @Input() sharedParams: Record<string, string> | null = null;

  readonly siteIds = SITE_IDS;
  readonly appServers = Array.from({ length: APP_SERVERS }, (_, i) => i + 1);

  state = signal<SimState>(defaultSimState());
  zoom = signal<'fit' | 'full'>('fit');
  linkCopied = signal(false);
  hoveredIds = signal<string[]>([]);

  resolution = computed(() => resolveTraffic(this.state()));
  graph = computed(() => buildTrafficGraph(this.state(), this.resolution()));

  outOfService = computed(() => Object.keys(this.state().down).map(nodeLabel));

  shareLink = computed(() => {
    const s = this.state();
    const q = new URLSearchParams({
      tab: 'traffic', path: s.path, sess: s.session, site: s.site,
      js: String(s.jsession), ltm: s.ltmMonitor, xgtm: s.extGtmMonitor,
      gtm: `bos:${s.gtmPick.bos},api:${s.gtmPick.api}`,
      live: `BCC:${s.live.BCC},SCC:${s.live.SCC}`
    });
    const off = Object.keys(s.down);
    if (off.length) { q.set('off', off.join(',')); }
    return `/error-analyzer?${q.toString()}`;
  });

  constructor(private router: Router) {}

  ngOnInit(): void {
    if (this.sharedParams) { this.restore(this.sharedParams); }
  }

  /** Rebuilds state from a shared link. Unknown values fall back to defaults. */
  private restore(p: Record<string, string>): void {
    const next = defaultSimState();
    if (p['path'] === 'banking' || p['path'] === 'api') { next.path = p['path']; }
    if (p['sess'] === 'new' || p['sess'] === 'existing') { next.session = p['sess']; }
    if (p['site'] === 'BCC' || p['site'] === 'SCC') { next.site = p['site']; }
    if (p['ltm'] === 'live' || p['ltm'] === 'tcp') { next.ltmMonitor = p['ltm']; }
    if (p['xgtm'] === 'live' || p['xgtm'] === 'tcp') { next.extGtmMonitor = p['xgtm']; }

    const js = Number(p['js']);
    if (js >= 1 && js <= APP_SERVERS) { next.jsession = js; }

    (p['gtm'] ?? '').split(',').forEach(pair => {
      const [gtm, value] = pair.split(':');
      if ((gtm === 'bos' || gtm === 'api') && (value === 'BCC' || value === 'SCC')) {
        next.gtmPick[gtm] = value;
      }
    });

    (p['live'] ?? '').split(',').forEach(pair => {
      const [site, value] = pair.split(':');
      if ((site === 'BCC' || site === 'SCC') && (value === 'present' || value === 'renamed')) {
        next.live[site] = value;
      }
    });

    (p['off'] ?? '').split(',').filter(Boolean).forEach(id => { next.down[id] = true; });

    this.state.set(next);
  }

  /** Writes the current scenario back to the URL without stacking history. */
  private syncUrl(s: SimState): void {
    const off = Object.keys(s.down);
    this.router.navigate([], {
      queryParams: {
        tab: 'traffic', path: s.path, sess: s.session, site: s.site,
        js: s.jsession, ltm: s.ltmMonitor, xgtm: s.extGtmMonitor,
        gtm: `bos:${s.gtmPick.bos},api:${s.gtmPick.api}`,
        live: `BCC:${s.live.BCC},SCC:${s.live.SCC}`,
        off: off.length ? off.join(',') : null
      },
      replaceUrl: true
    });
  }

  private update(mutate: (s: SimState) => void): void {
    const next: SimState = {
      ...this.state(),
      live: { ...this.state().live },
      down: { ...this.state().down }
    };
    mutate(next);
    this.state.set(next);
    this.syncUrl(next);
  }

  setPath(v: TrafficPath): void { this.update(s => { s.path = v; }); }
  setSession(v: SessionKind): void { this.update(s => { s.session = v; }); }
  setSite(v: SiteId): void { this.update(s => { s.site = v; }); }
  setGtmPick(gtm: GtmId, v: SiteId): void {
    this.update(s => { s.gtmPick = { ...s.gtmPick, [gtm]: v }; });
  }
  setJsession(v: number): void { this.update(s => { s.jsession = v; }); }
  setLtmMonitor(v: PoolMonitor): void { this.update(s => { s.ltmMonitor = v; }); }
  setExtGtmMonitor(v: PoolMonitor): void { this.update(s => { s.extGtmMonitor = v; }); }
  setLive(site: SiteId, v: LivenessState): void { this.update(s => { s.live[site] = v; }); }

  /** Clicking a pill only does something when the GTM pick is in play. */
  clickPill(pill: TfPill): void {
    if (!pill.active) { return; }
    this.setGtmPick(pill.gtm, pill.site);
  }

  /** Clicking a box takes it out of service, or brings it back. */
  toggleNode(node: TfNode): void {
    if (!node.toggleable) { return; }
    this.update(s => {
      if (s.down[node.id]) { delete s.down[node.id]; } else { s.down[node.id] = true; }
    });
  }

  resetOutages(): void { this.update(s => { s.down = {}; }); }

  setZoom(v: 'fit' | 'full'): void { this.zoom.set(v); }

  /** Hovering a node or trace row highlights its counterpart. */
  hover(ids: string[]): void { this.hoveredIds.set(ids); }
  clearHover(): void { this.hoveredIds.set([]); }
  isHovered(id: string): boolean { return this.hoveredIds().includes(id); }
  isStepHovered(ids: string[]): boolean {
    const hot = this.hoveredIds();
    return ids.some(id => hot.includes(id));
  }

  async copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(window.location.origin + this.shareLink());
      this.linkCopied.set(true);
      setTimeout(() => this.linkCopied.set(false), 1400);
    } catch {
      this.linkCopied.set(false);
    }
  }
}