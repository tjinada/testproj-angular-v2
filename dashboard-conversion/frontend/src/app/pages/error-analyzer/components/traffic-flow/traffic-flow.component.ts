import { ChangeDetectionStrategy, Component, Input, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import type {
  CallKind, CallResult, Cohort, EstateOverrides, JourneyFrame, OutageType, PoolMonitor,
  RecoveryOrder, ScenarioConfig, SiteId, TrafficPath
} from '../../models/traffic-flow.model';
import { callPaths, runJourney } from '../../services/traffic-scenario-runner';
import { DEFAULT_CONFIG, buildScenario } from './traffic-scenarios';
import { buildTrafficGraph, TfNode, TfPill } from './traffic-flow-layout';
import { SITE_IDS, nodeLabel } from './traffic-topology';

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

  config = signal<ScenarioConfig>({ ...DEFAULT_CONFIG });

  /** Rail-owned estate settings. Survive every journey regeneration. */
  overrides = signal<EstateOverrides>({ down: {}, ltmMonitor: 'live', extGtmMonitor: 'live' });

  stepIndex = signal(0);
  /** Which user the diagram shows. One at a time — never overlaid. */
  cohort = signal<Cohort>('new');

  zoom = signal<'fit' | 'full'>('fit');
  linkCopied = signal(false);
  hoveredIds = signal<string[]>([]);

  scenario = computed(() => buildScenario(this.config(), this.overrides()));
  frames = computed(() => runJourney(this.scenario(), this.config()));

  /** Clamped, because changing the config can shorten the journey underfoot. */
  activeIndex = computed(() =>
    Math.min(this.stepIndex(), Math.max(0, this.frames().length - 1)));
  activeFrame = computed(() => this.frames()[this.activeIndex()]);

  results = computed<CallResult[]>(() => this.activeFrame()?.results ?? []);

  /** Every call for both cohorts at the current stage, for the cards. */
  private stageResults = computed(() => {
    const f = this.activeFrame();
    if (!f) { return []; }
    return this.frames().filter(x => x.label === f.label);
  });

  /** Two cards, always. Each lists the whole three-call sequence. */
  cards = computed(() => (['new', 'existing'] as Cohort[]).map(c => {
    const at = (call: CallKind) => this.stageResults()
      .find(f => f.call === call)?.results.find(r => r.cohort === c) ?? null;

    const signin = at('signin');
    const isam = at('isam');
    const trailing = at('trailing');
    const sr = signin?.resolution ?? null;
    const st = signin?.state ?? null;

    const fresh = !st || st.session === 'new';
    const jsInSite = fresh ? null : st!.jsessionSite ?? st!.site;

    return {
      cohort: c,
      title: c === 'new' ? 'New user' : 'Existing user',
      cookieIn: fresh ? 'none' : st!.site,
      cookieOut: sr?.stampedSite ?? (fresh ? '—' : st!.site),
      jsIn: fresh ? 'none' : `${jsInSite} #${st!.jsession}`,
      // Only sign-in issues a session, so this is the only call that can move it.
      jsOut: sr && sr.outcome.severity !== 'bad' && sr.bosSite && sr.appServer
        ? `${sr.bosSite} #${sr.appServer}`
        : (fresh ? 'none' : `${jsInSite} #${st!.jsession}`),
      // Cookie and session on different sites is what breaks the next call.
      jsSplit: !!sr?.bosSite && !!sr?.stampedSite && sr.bosSite !== sr.stampedSite,
      signin, isam, trailing,
      severity: [signin, isam, trailing]
        .some(r => r?.resolution?.outcome.severity === 'bad') ? 'bad' : 'ok'
    };
  }));

  /** The call this frame shows, for the selected cohort. */
  selected = computed<CallResult | null>(() =>
    this.results().find(r => r.cohort === this.cohort()) ?? null);

  /** Stage groups for the steps panel. */
  stages = computed(() => {
    const out: { label: string; change: string | null; frames: { f: JourneyFrame; i: number }[] }[] = [];
    this.frames().forEach((f, i) => {
      let g = out.find(x => x.label === f.label);
      if (!g) { g = { label: f.label, change: null, frames: [] }; out.push(g); }
      if (f.change) { g.change = f.change; }
      g.frames.push({ f, i });
    });
    return out;
  });

  /** The path each call takes, given where sign-in currently lives. */
  private paths = computed(() => callPaths(this.config()));

  /** Which GTM decides the pin. The whole point of the sign-in-path toggle. */
  decidingGtm = computed(() =>
    this.config().signinPath === 'api' ? 'GTM-CDB-API' : 'GTM-CDB-BOS');

  callLabel(call: CallKind): string {
    const p = this.paths()[call];
    const base = p === 'csgcb' ? 'initISAMSession'
      : p === 'api' ? '/api/cdb' : '/banking/services';
    return call === 'signin' ? `${base} SigninRequestManager` : base;
  }

  /** Short form for the step chips, which have no room for the servlet. */
  callShort(call: CallKind): string {
    const p = this.paths()[call];
    return p === 'csgcb' ? 'initISAMSession' : p === 'api' ? '/api/cdb' : '/banking/services';
  }

  setSigninPath(v: TrafficPath): void { this.setConfig(c => { c.signinPath = v; }); }

  primaryLabel = computed(() => '/api/cdb');

  graph = computed(() => {
    const frame = this.activeFrame();
    return frame ? buildTrafficGraph(frame, this.cohort()) : null;
  });

  effectiveState = computed(() => this.activeFrame()?.state ?? null);
  carried = computed(() => this.activeFrame()?.user ?? null);

  outOfService = computed(() => {
    const s = this.effectiveState();
    return s ? Object.keys(s.down).map(nodeLabel) : [];
  });

  /** Ordering only means something when both tiers went down. */
  recoveryOrderMatters = computed(() => this.config().outageType === 'unplanned');

  shareLink = computed(() => {
    const c = this.config(), o = this.overrides();
    const q = new URLSearchParams({
      tab: 'traffic', sp: c.signinPath, site: c.site, os: c.outageSite,
      ot: c.outageType, rec: c.recovery, step: String(this.activeIndex()),
      ltm: o.ltmMonitor, xgtm: o.extGtmMonitor, who: this.cohort()
    });
    const off = Object.keys(o.down);
    if (off.length) { q.set('off', off.join(',')); }
    return `/error-analyzer?${q.toString()}`;
  });

  constructor(private router: Router) {}

  ngOnInit(): void {
    if (this.sharedParams) { this.restore(this.sharedParams); }
  }

  /** Rebuilds config and overrides from a shared link. Unknown values default. */
  private restore(p: Record<string, string>): void {
    const c: ScenarioConfig = { ...DEFAULT_CONFIG };
    if (p['sp'] === 'api' || p['sp'] === 'banking') { c.signinPath = p['sp']; }
    if (p['site'] === 'BCC' || p['site'] === 'SCC') { c.site = p['site']; }
    if (p['os'] === 'BCC' || p['os'] === 'SCC') { c.outageSite = p['os']; }
    if (['none', 'planned', 'unplanned', 'apic'].includes(p['ot'])) {
      c.outageType = p['ot'] as OutageType;
    }
    if (['none', 'jvm-then-ihs', 'ihs-then-jvm'].includes(p['rec'])) {
      c.recovery = p['rec'] as RecoveryOrder;
    }
    this.config.set(c);

    const o: EstateOverrides = { down: {}, ltmMonitor: 'live', extGtmMonitor: 'live' };
    if (p['ltm'] === 'live' || p['ltm'] === 'tcp') { o.ltmMonitor = p['ltm']; }
    if (p['xgtm'] === 'live' || p['xgtm'] === 'tcp') { o.extGtmMonitor = p['xgtm']; }
    (p['off'] ?? '').split(',').filter(Boolean).forEach(id => { o.down[id] = true; });
    this.overrides.set(o);

    if (p['who'] === 'new' || p['who'] === 'existing') { this.cohort.set(p['who']); }

    const step = Number(p['step']);
    this.stepIndex.set(step >= 0 && step < this.frames().length ? step : 0);
  }

  private syncUrl(): void {
    const c = this.config(), o = this.overrides();
    const off = Object.keys(o.down);
    this.router.navigate([], {
      queryParams: {
        tab: 'traffic', sp: c.signinPath, site: c.site, os: c.outageSite,
        ot: c.outageType, rec: c.recovery, step: this.activeIndex(),
        ltm: o.ltmMonitor, xgtm: o.extGtmMonitor,
        off: off.length ? off.join(',') : null,
        who: this.cohort()
      },
      replaceUrl: true
    });
  }

  /** Config edits rebuild the journey, so playback restarts from the top. */
  private setConfig(mutate: (c: ScenarioConfig) => void): void {
    const next = { ...this.config() };
    mutate(next);
    this.config.set(next);
    this.stepIndex.set(0);
    this.syncUrl();
  }

  private setOverrides(mutate: (o: EstateOverrides) => void): void {
    const next: EstateOverrides = { ...this.overrides(), down: { ...this.overrides().down } };
    mutate(next);
    this.overrides.set(next);
    this.syncUrl();
  }

  // ---- rail controls -------------------------------------------------------

  setSite(v: SiteId): void { this.setConfig(c => { c.site = v; }); }
  setOutageSite(v: SiteId): void { this.setConfig(c => { c.outageSite = v; }); }
  setRecovery(v: RecoveryOrder): void { this.setConfig(c => { c.recovery = v; }); }

  setOutageType(v: OutageType): void {
    this.setConfig(c => {
      c.outageType = v;
      // Nothing is down, so there is nothing to recover in a chosen order.
      if (v === 'none') { c.recovery = 'none'; }
      else if (v !== 'unplanned' && c.recovery === 'ihs-then-jvm') { c.recovery = 'jvm-then-ihs'; }
    });
  }

  // Monitors stay editable during playback: comparing live.txt against a TCP
  // check on the same journey is the reason the flip exists.
  setLtmMonitor(v: PoolMonitor): void { this.setOverrides(o => { o.ltmMonitor = v; }); }
  setExtGtmMonitor(v: PoolMonitor): void { this.setOverrides(o => { o.extGtmMonitor = v; }); }

  // ---- playback ------------------------------------------------------------

  goToStep(i: number): void {
    if (i < 0 || i >= this.frames().length) { return; }
    this.stepIndex.set(i);
    this.syncUrl();
  }

  /** Selection, not a toggle — one cohort is always on the diagram. */
  setCohort(c: Cohort): void {
    this.cohort.set(c);
    this.syncUrl();
  }

  /** Clicking a box takes it out of service, or brings it back. */
  toggleNode(node: TfNode): void {
    if (!node.toggleable) { return; }
    this.setOverrides(o => {
      if (o.down[node.id]) { delete o.down[node.id]; } else { o.down[node.id] = true; }
    });
  }

  /**
   * The GTM pick is derived from the user's site, so the pills are a shortcut
   * to that control rather than an independent one.
   */
  clickPill(pill: TfPill): void {
    if (!pill.active) { return; }
    this.setSite(pill.site);
  }

  resetOutages(): void { this.setOverrides(o => { o.down = {}; }); }

  setZoom(v: 'fit' | 'full'): void { this.zoom.set(v); }

  hover(ids: string[]): void { this.hoveredIds.set(ids); }
  clearHover(): void { this.hoveredIds.set([]); }
  isHovered(id: string): boolean { return this.hoveredIds().includes(id); }
  isStepHovered(ids: string[]): boolean {
    return ids.some(id => this.hoveredIds().includes(id));
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
