import { ChangeDetectionStrategy, Component, Input, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import type {
  GtmId, LivenessState, PoolMonitor, SessionKind, SimState, SiteId, TrafficPath
} from '../../models/traffic-flow.model';
import { resolveTraffic } from '../../services/traffic-resolver';
import { runJourney } from '../../services/traffic-scenario-runner';
import { SCENARIOS } from './traffic-scenarios';
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
  readonly scenarios = SCENARIOS;

  state = signal<SimState>(defaultSimState());
  zoom = signal<'fit' | 'full'>('fit');
  linkCopied = signal(false);
  hoveredIds = signal<string[]>([]);

  /** Null in manual mode. Set while a scenario is being replayed. */
  scenarioId = signal<string | null>(null);
  stepIndex = signal(0);

  /** True while a scenario owns the estate and the manual rail is locked. */
  playing = computed(() => this.scenarioId() !== null);

  frames = computed(() => {
    const sc = this.scenarios.find(s => s.id === this.scenarioId());
    return sc ? runJourney(sc) : [];
  });

  /** The frame currently on screen, or null when driving manually. */
  activeFrame = computed(() => this.frames()[this.stepIndex()] ?? null);

  /** Scenario frames drive the diagram when playing; the rail drives it otherwise. */
  effectiveState = computed(() => this.activeFrame()?.state ?? this.state());

  resolution = computed(() => this.activeFrame()?.resolution ?? resolveTraffic(this.state()));
  graph = computed(() => buildTrafficGraph(this.effectiveState(), this.resolution()));

  outOfService = computed(() => Object.keys(this.effectiveState().down).map(nodeLabel));

  shareLink = computed(() => {
    const sc = this.scenarioId();
    if (sc) {
      return `/error-analyzer?tab=traffic&sc=${sc}&step=${this.stepIndex()}`;
    }
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
    // A scenario link replays the journey instead of restoring a manual state.
    if (p['sc'] && this.scenarios.some(s => s.id === p['sc'])) {
      this.scenarioId.set(p['sc']);
      const step = Number(p['step']);
      const max = this.frames().length - 1;
      this.stepIndex.set(step >= 0 && step <= max ? step : 0);
      return;
    }

    const next = defaultSimState();
    if (p['path'] === 'banking' || p['path'] === 'api' || p['path'] === 'csgcb') {
      next.path = p['path'];
    }
    if (p['sess'] === 'new' || p['sess'] === 'existing') { next.session = p['sess']; }
    // csgcb is post-auth, so a link claiming a new session is not a real state.
    if (next.path === 'csgcb') { next.session = 'existing'; }
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

  /** csgcb is post-auth, so selecting it locks the session to Existing. */
  setPath(v: TrafficPath): void {
    this.update(s => {
      s.path = v;
      if (v === 'csgcb') { s.session = 'existing'; }
    });
  }

  // ---- scenario playback ---------------------------------------------------

  playScenario(id: string): void {
    this.scenarioId.set(id);
    this.stepIndex.set(0);
    this.syncScenarioUrl();
  }

  /** Leaves playback and hands the estate back to the rail as it stood. */
  exitScenario(): void {
    const frame = this.activeFrame();
    if (frame) { this.state.set(frame.state); }
    this.scenarioId.set(null);
    this.stepIndex.set(0);
    if (frame) { this.syncUrl(frame.state); }
  }

  goToStep(i: number): void {
    if (i < 0 || i >= this.frames().length) { return; }
    this.stepIndex.set(i);
    this.syncScenarioUrl();
  }

  private syncScenarioUrl(): void {
    this.router.navigate([], {
      queryParams: { tab: 'traffic', sc: this.scenarioId(), step: this.stepIndex() },
      replaceUrl: true
    });
  }

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
    if (!pill.active || this.scenarioId()) { return; }
    this.setGtmPick(pill.gtm, pill.site);
  }

  /** Clicking a box takes it out of service, or brings it back. */
  toggleNode(node: TfNode): void {
    // Scenario frames are a rebuilt fold, so a toggle here would be silently
    // discarded on the next step. Playback owns the estate.
    if (!node.toggleable || this.scenarioId()) { return; }
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