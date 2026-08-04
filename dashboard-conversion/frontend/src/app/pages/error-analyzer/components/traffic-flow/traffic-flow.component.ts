import { ChangeDetectionStrategy, Component, Input, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import type {
  GtmId, LivenessState, PoolMonitor, Scenario, SessionKind, SimState, SiteId,
  StageScenario, TrafficPath
} from '../../models/traffic-flow.model';
import { resolveTraffic } from '../../services/traffic-resolver';
import { buildTrafficGraph, TfNode, TfPill } from './traffic-flow-layout';
import { SCENARIOS, DR_SCENARIOS } from './traffic-scenarios';
import { runScenario, runStages, toSimState } from '../../services/traffic-scenario-runner';
import { APP_SERVERS, SITE_IDS, defaultSimState, nodeLabel } from './traffic-topology';

/**
 * Interactive model of how a CDB request routes through the Akamai / APIC /
 * BOS estate. Everything is resolved client-side from a SimState — there is no
 * backend call. Boxes can be taken out of service by clicking them, and the
 * whole scenario round-trips through the URL so it can be shared.
 */
@Component({
  selector: 'app-traffic-flow',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './traffic-flow.component.html',
  styleUrls: ['./traffic-flow.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class TrafficFlowComponent implements OnInit, OnDestroy {
  /** Query params from the Error Analyzer route, used to restore a shared link. */
  @Input() sharedParams: Record<string, string> | null = null;

  readonly siteIds = SITE_IDS;
  readonly appServers = Array.from({ length: APP_SERVERS }, (_, i) => i + 1);

  state = signal<SimState>(defaultSimState());
  zoom = signal<'fit' | 'full'>('fit');
  linkCopied = signal(false);
  hoveredIds = signal<string[]>([]);

  // ── Scenario replay ──────────────────────────────────────────────
  readonly scenarios = SCENARIOS;
  scenario = signal<Scenario | null>(null);
  stepIndex = signal(0);
  playing = signal(false);
  private timer: ReturnType<typeof setInterval> | null = null;

  frames = computed(() => {
    const sc = this.scenario();
    return sc ? runScenario(sc) : [];
  });

  // ── DR stage scenarios (cohorts observed in parallel) ────────────
  readonly drScenarios = DR_SCENARIOS;
  drScenario = signal<StageScenario | null>(null);
  /** Which cohort row drives the diagram and trace. */
  cohortIndex = signal(0);

  stageFrames = computed(() => {
    const sc = this.drScenario();
    return sc ? runStages(sc) : [];
  });
  stageFrame = computed(() => this.stageFrames()[this.stepIndex()] ?? null);
  cohortFrame = computed(() => {
    const sf = this.stageFrame();
    return sf ? (sf.cohorts[this.cohortIndex()] ?? sf.cohorts[0]) : null;
  });
  cohortLabel = (i: number): string => this.drScenario()?.cohorts[i]?.label ?? '';
  frame = computed(() => this.frames()[this.stepIndex()] ?? null);
  /** True while either kind of scenario drives the estate. */
  replaying = computed(() => this.scenario() !== null || this.drScenario() !== null);
  /** True in DR mode, which renders the cohort table instead of a user strip. */
  stageMode = computed(() => this.drScenario() !== null);

  /** The state actually being rendered: the scenario's, or the free-form one. */
  activeState = computed<SimState>(() => {
    const sf = this.stageFrame();
    const cf = this.cohortFrame();
    if (sf && cf) { return toSimState(sf.env, cf.userBefore, cf.result.path); }
    const f = this.frame();
    if (!f) { return this.state(); }
    return toSimState(f.env, f.userBefore, f.shown.path);
  });

  resolution = computed(() => {
    const cf = this.cohortFrame();
    if (cf) { return cf.result; }
    const f = this.frame();
    return f ? f.shown : resolveTraffic(this.state());
  });
  graph = computed(() => buildTrafficGraph(this.activeState(), this.resolution()));

  outOfService = computed(() => Object.keys(this.activeState().down).map(nodeLabel));

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

  // ── Scenario transport ───────────────────────────────────────────

  /** Total steps in whichever scenario kind is running. */
  stepCount = computed(() =>
    this.stageMode() ? this.stageFrames().length : this.frames().length);

  startScenario(id: string): void {
    this.stopPlaying();
    this.stepIndex.set(0);
    this.cohortIndex.set(0);
    const dr = this.drScenarios.find(s => s.id === id) ?? null;
    if (dr) { this.drScenario.set(dr); this.scenario.set(null); return; }
    this.drScenario.set(null);
    this.scenario.set(this.scenarios.find(s => s.id === id) ?? null);
  }

  selectCohort(i: number): void { this.cohortIndex.set(i); }

  /** Leaves replay, handing the current estate over to the free-form rail. */
  exitScenario(): void {
    this.stopPlaying();
    this.state.set(this.activeState());
    this.scenario.set(null);
    this.drScenario.set(null);
    this.stepIndex.set(0);
    this.syncUrl(this.state());
  }

  goToStep(i: number): void {
    this.stopPlaying();
    this.stepIndex.set(i);
  }

  nextStep(): void {
    this.stopPlaying();
    if (this.stepIndex() < this.stepCount() - 1) {
      this.stepIndex.update(i => i + 1);
    }
  }

  prevStep(): void {
    this.stopPlaying();
    if (this.stepIndex() > 0) { this.stepIndex.update(i => i - 1); }
  }

  resetScenario(): void {
    this.stopPlaying();
    this.stepIndex.set(0);
  }

  togglePlay(): void {
    if (this.playing()) { this.stopPlaying(); return; }
    if (this.stepIndex() >= this.stepCount() - 1) { this.stepIndex.set(0); }
    this.playing.set(true);
    this.timer = setInterval(() => {
      if (this.stepIndex() >= this.stepCount() - 1) { this.stopPlaying(); return; }
      this.stepIndex.update(i => i + 1);
    }, 1600);
  }

  private stopPlaying(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.playing.set(false);
  }

  ngOnDestroy(): void { this.stopPlaying(); }

  /** Cookie chip text for the user strip. */
  cookieChip(u: { cookie: SiteId | null }): string | null {
    return u.cookie ? `cdbbossiteId=${u.cookie}` : null;
  }

  jsessionChip(u: { jsSite: SiteId | null; jsServer: number | null }): string | null {
    return u.jsSite ? `JSESSIONID=…${u.jsSite.toLowerCase()}app${u.jsServer}` : null;
  }
}
