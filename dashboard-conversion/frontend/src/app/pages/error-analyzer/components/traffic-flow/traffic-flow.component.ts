import {
  ChangeDetectionStrategy, Component, ElementRef, HostListener, Input, OnInit, computed, signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import type {
  CallKind, CallResult, Cohort, JourneyFrame, OutageType, Overrides, PoolMonitor,
  RecoveryOrder, ScenarioConfig, SiteId, TrafficPath
} from '../../models/traffic-flow.model';
import { CALL_SEQUENCE } from '../../models/traffic-flow.model';
import { callPaths, runJourney } from '../../services/traffic-scenario-runner';
import {
  DEFAULT_CONFIG, OverrideItem, buildScenario, defaultOverrides, flipLiveness, flipMonitor,
  listOverrides
} from './traffic-scenarios';
import { buildTrafficGraph, TfChip, TfNode, TfPill } from './traffic-flow-layout';
import { SITE_IDS } from './traffic-topology';

const OUTAGE_TYPES: { value: OutageType; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'planned', label: 'Planned CDBBOS' },
  { value: 'unplanned', label: 'Unplanned CDBBOS' },
  { value: 'apic', label: 'APIC outage' }
];

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
  readonly outageTypes = OUTAGE_TYPES;

  config = signal<ScenarioConfig>({ ...DEFAULT_CONFIG });

  /** What the operator has changed from production. Survives every regeneration. */
  overrides = signal<Overrides>(defaultOverrides());

  stepIndex = signal(0);
  /** Which user the diagram shows. One at a time — never overlaid. */
  cohort = signal<Cohort>('new');

  traceOpen = signal(false);
  overridesOpen = signal(false);
  fullscreen = signal(false);
  linkCopied = signal(false);
  hoveredIds = signal<string[]>([]);

  scenario = computed(() => buildScenario(this.config(), this.overrides()));
  frames = computed(() => runJourney(this.scenario(), this.config()));

  /** Clamped, because changing the config can shorten the journey underfoot. */
  activeIndex = computed(() =>
    Math.min(this.stepIndex(), Math.max(0, this.frames().length - 1)));
  activeFrame = computed(() => this.frames()[this.activeIndex()]);

  /** The call this frame shows, for the selected cohort. */
  selected = computed<CallResult | null>(() =>
    this.activeFrame()?.results.find(r => r.cohort === this.cohort()) ?? null);

  /** Stage groups for the step strip. */
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

  /**
   * The selected user's cookies as of the call on screen. Read
   * off sign-in for cdbbossiteId and JSESSIONID, and off the auth call for apidc.
   * Null means the cookie has not been assigned.
   */
  cookies = computed(() => {
    const f = this.activeFrame();
    if (!f) { return null; }
    const stage = this.frames().filter(x => x.label === f.label);
    const at = (call: CallKind) =>
      stage.find(x => x.call === call)?.results.find(r => r.cohort === this.cohort()) ?? null;

    const signin = at('signin');
    const idp = at('idp');
    const sr = signin?.resolution ?? null;
    const st = signin?.state ?? null;
    const fresh = !st || st.session === 'new';
    const jsInSite = fresh ? null : st!.jsessionSite ?? st!.site;

    // A skipped auth call has no state; the cookie carried into sign-in still stands.
    const idpIn = (idp?.state ?? st)?.idpSite ?? null;
    const jsIn = fresh ? null : `${jsInSite} #${st!.jsession}`;
    return {
      site: sr?.stampedSite ?? (fresh ? null : st!.site),
      // Only sign-in issues a session, so this is the only call that can move it.
      js: sr && sr.outcome.severity !== 'bad' && sr.bosSite && sr.appServer
        ? `${sr.bosSite} #${sr.appServer}` : jsIn,
      // Cookie and session on different sites is what breaks the next call.
      jsSplit: !!sr?.bosSite && !!sr?.stampedSite && sr.bosSite !== sr.stampedSite,
      // apidc is set by the auth call, so it only changes once that call has run.
      apidc: CALL_SEQUENCE.indexOf(f.call) >= CALL_SEQUENCE.indexOf('idp')
        ? idp?.resolution?.stampedSite ?? idpIn : idpIn
    };
  });

  /** The path each call takes, given where sign-in currently lives. */
  private paths = computed(() => callPaths(this.config()));

  outageNone = computed(() => this.config().outageType === 'none');

  overrideList = computed<OverrideItem[]>(() =>
    listOverrides(this.overrides(), this.outageNone()));

  graph = computed(() => {
    const frame = this.activeFrame();
    // live.txt belongs to the outage stages whenever one is selected.
    return frame ? buildTrafficGraph(frame, this.cohort(), !this.outageNone()) : null;
  });

  /** Ordering only means something when both tiers went down. */
  recoveryOrderMatters = computed(() => this.config().outageType === 'unplanned');

  shareLink = computed(() => `/error-analyzer?${new URLSearchParams(this.queryParams()).toString()}`);

  constructor(private router: Router, private host: ElementRef<HTMLElement>) {}

  ngOnInit(): void {
    if (this.sharedParams) {
      this.restore(this.sharedParams);
      this.scrollToActive();
    }
  }

  // ---- labels --------------------------------------------------------------

  callLabel(call: CallKind): string {
    const p = this.paths()[call];
    if (p === 'idp') { return 'authentication.bmo.com/aac/*'; }
    if (p === 'spaapi') { return 'apis.bmo.com/api/*'; }
    return this.callShort(call);
  }

  /**
   * Short form for the step chips. Sign-in keeps its servlet name so the first
   * call reads as the request it is, on either path.
   */
  callShort(call: CallKind): string {
    const p = this.paths()[call];
    if (p === 'idp') { return 'authentication.bmo.com'; }
    if (p === 'spaapi') { return 'apis.bmo.com'; }
    if (p === 'csgcb') { return 'initISAMSession'; }
    const base = p === 'api' ? '/api/cdb' : '/banking/services';
    return call === 'signin' ? `${base}/SignInRequestManager` : base;
  }

  /** The site that served a call. */
  callSite(r: CallResult): SiteId | null {
    const res = r.resolution;
    if (!res) { return null; }
    if (r.call === 'idp') { return res.pinnedSite; }
    if (r.call === 'spaapi') { return res.apicSite; }
    return res.bosSite;
  }

  /** Site colour class for any text that names a data centre. */
  siteClass(v: string | null | undefined): string {
    return v?.includes('SCC') ? 'tf-s-SCC' : v?.includes('BCC') ? 'tf-s-BCC' : '';
  }

  /** Status dot for one cohort's result on a step chip. */
  dotClass(r: CallResult): string {
    return r.skipped ? 'skip' : r.resolution?.outcome.severity ?? 'ok';
  }

  /** Hover text for a step chip: both cohorts' results. */
  chipTitle(f: JourneyFrame): string {
    return f.results.map(r => {
      const who = r.cohort === 'new' ? 'New' : 'Existing';
      if (r.skipped || !r.resolution) { return `${who}: not attempted`; }
      const site = this.callSite(r);
      return `${who}: ${r.resolution.http}${site ? ' · ' + site : ''}`;
    }).join('\n');
  }

  pillTitle(p: TfPill): string {
    return p.active ? `Answer ${p.site}` : `Set the pick to ${p.site} (not in play on this call)`;
  }

  // ---- toolbar -------------------------------------------------------------

  /**
   * Selecting a sign-in path selects the whole package it belongs to.
   *
   * The proposal is not just "move sign-in": once the pin comes from a
   * BOS-health-aware decision, the internal tiers should stop failing over on
   * their own, because an independent re-route is precisely what separates the
   * cookie from the session. So both monitors move to a TCP check with it —
   * that is also the DACT-104 remediation. The monitor chips stay editable, so
   * the package can still be taken apart one piece at a time.
   */
  setSigninPath(v: TrafficPath): void {
    const monitor: PoolMonitor = v === 'banking' ? 'tcp' : 'live';
    this.setOverrides(o => { o.ltmMonitor = monitor; o.extGtmMonitor = monitor; });
    this.setConfig(c => { c.signinPath = v; });
  }

  setOutageType(v: string): void {
    this.setConfig(c => {
      c.outageType = v as OutageType;
      // Nothing is down, so there is nothing to recover in a chosen order.
      if (v === 'none') { c.recovery = 'none'; }
      else if (v !== 'unplanned' && c.recovery === 'ihs-then-jvm') { c.recovery = 'jvm-then-ihs'; }
    });
  }

  setOutageSite(v: SiteId): void { this.setConfig(c => { c.outageSite = v; }); }
  setRecovery(v: string): void { this.setConfig(c => { c.recovery = v as RecoveryOrder; }); }

  /** Selection, not a toggle — one cohort is always on the diagram. */
  setCohort(c: Cohort): void {
    this.cohort.set(c);
    this.syncUrl();
  }

  toggleTrace(): void { this.traceOpen.set(!this.traceOpen()); }
  toggleOverrides(): void { this.overridesOpen.set(!this.overridesOpen()); }

  toggleFullscreen(): void {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void this.host.nativeElement.requestFullscreen?.();
    }
  }

  @HostListener('document:fullscreenchange')
  onFullscreenChange(): void {
    this.fullscreen.set(document.fullscreenElement === this.host.nativeElement);
  }

  undoOverride(item: OverrideItem): void {
    this.setOverrides(o => {
      switch (item.kind) {
        case 'down': delete o.down[item.id]; break;
        case 'extgtm': o.extGtmMonitor = 'live'; break;
        case 'ltm': o.ltmMonitor = 'live'; break;
        case 'idplive': o.idpLive[item.site] = 'present'; break;
        case 'live': o.live[item.site] = 'present'; break;
      }
    });
    this.clearHover();
  }

  resetOverrides(): void {
    this.overrides.set(defaultOverrides());
    this.overridesOpen.set(false);
    this.syncUrl();
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

  // ---- diagram -------------------------------------------------------------

  goToStep(i: number): void {
    if (i < 0 || i >= this.frames().length) { return; }
    this.stepIndex.set(i);
    this.syncUrl();
    this.scrollToActive();
  }

  /** Outage journeys overflow the strip; keep the active call in view. */
  private scrollToActive(): void {
    setTimeout(() => this.host.nativeElement.querySelector('.tf-chip.tf-on')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  }

  /** Clicking a box takes it out of service, or brings it back. */
  toggleNode(node: TfNode): void {
    if (!node.toggleable) { return; }
    this.setOverrides(o => {
      if (o.down[node.id]) { delete o.down[node.id]; } else { o.down[node.id] = true; }
    });
  }

  /**
   * Pills set each GTM's pick. They stay clickable when that GTM is not in play
   * on the current call — they are the only control for it — and the pick
   * takes effect on the calls where it is.
   *
   * GTM picks change answers, not the frame count, so the step is kept.
   */
  clickPill(pill: TfPill): void {
    this.setConfig(c => {
      if (pill.gtm === 'isam') { c.idpSite = pill.site; }
      else if (pill.gtm === 'spa') { c.spaSite = pill.site; }
      else { c.site = pill.site; }
    }, true);
  }

  /** A chip flips the setting it sits on. Monitors are one setting for both sites. */
  toggleChip(chip: TfChip): void {
    if (chip.locked) { return; }
    this.setOverrides(o => {
      switch (chip.kind) {
        case 'extgtm': o.extGtmMonitor = flipMonitor(o.extGtmMonitor); break;
        case 'ltm': o.ltmMonitor = flipMonitor(o.ltmMonitor); break;
        case 'idplive': o.idpLive[chip.site] = flipLiveness(o.idpLive[chip.site]); break;
        case 'live': o.live[chip.site] = flipLiveness(o.live[chip.site]); break;
      }
    });
  }

  hover(ids: string[]): void { this.hoveredIds.set(ids); }
  clearHover(): void { this.hoveredIds.set([]); }
  isHovered(id: string): boolean { return this.hoveredIds().includes(id); }
  isStepHovered(ids: string[]): boolean {
    return ids.some(id => this.hoveredIds().includes(id));
  }

  // ---- state plumbing ------------------------------------------------------

  /**
   * Config edits rebuild the journey, so playback normally restarts from the
   * top. A GTM pick passes keepStep: it changes answers, not the frame count,
   * so the operator stays on the call they were looking at.
   */
  private setConfig(mutate: (c: ScenarioConfig) => void, keepStep = false): void {
    const next = { ...this.config() };
    mutate(next);
    this.config.set(next);
    if (!keepStep) { this.stepIndex.set(0); }
    this.syncUrl();
  }

  private setOverrides(mutate: (o: Overrides) => void): void {
    const cur = this.overrides();
    const next: Overrides = {
      ...cur, down: { ...cur.down }, idpLive: { ...cur.idpLive }, live: { ...cur.live }
    };
    mutate(next);
    this.overrides.set(next);
    this.syncUrl();
  }

  private queryParams(): Record<string, string> {
    const c = this.config(), o = this.overrides();
    const q: Record<string, string> = {
      tab: 'traffic', sp: c.signinPath, site: c.site, isite: c.idpSite, ssite: c.spaSite,
      os: c.outageSite, ot: c.outageType, rec: c.recovery, step: String(this.activeIndex()),
      ltm: o.ltmMonitor, xgtm: o.extGtmMonitor,
      idlb: o.idpLive.BCC, idls: o.idpLive.SCC, lb: o.live.BCC, ls: o.live.SCC,
      who: this.cohort()
    };
    const off = Object.keys(o.down);
    if (off.length) { q['off'] = off.join(','); }
    return q;
  }

  private syncUrl(): void {
    const q: Record<string, string | null> = { ...this.queryParams() };
    if (!q['off']) { q['off'] = null; }
    this.router.navigate([], { queryParams: q, replaceUrl: true });
  }

  /** Rebuilds config and overrides from a shared link. Unknown values default. */
  private restore(p: Record<string, string>): void {
    const isSite = (v: string | undefined): v is SiteId => v === 'BCC' || v === 'SCC';
    const c: ScenarioConfig = { ...DEFAULT_CONFIG };
    if (p['sp'] === 'api' || p['sp'] === 'banking') { c.signinPath = p['sp']; }
    if (isSite(p['site'])) { c.site = p['site']; }
    if (isSite(p['isite'])) { c.idpSite = p['isite']; }
    if (isSite(p['ssite'])) { c.spaSite = p['ssite']; }
    if (isSite(p['os'])) { c.outageSite = p['os']; }
    if (OUTAGE_TYPES.some(t => t.value === p['ot'])) { c.outageType = p['ot'] as OutageType; }
    if (['none', 'jvm-then-ihs', 'ihs-then-jvm'].includes(p['rec'])) {
      c.recovery = p['rec'] as RecoveryOrder;
    }
    this.config.set(c);

    const o = defaultOverrides();
    if (p['ltm'] === 'live' || p['ltm'] === 'tcp') { o.ltmMonitor = p['ltm']; }
    if (p['xgtm'] === 'live' || p['xgtm'] === 'tcp') { o.extGtmMonitor = p['xgtm']; }
    if (p['idlb'] === 'renamed') { o.idpLive.BCC = 'renamed'; }
    if (p['idls'] === 'renamed') { o.idpLive.SCC = 'renamed'; }
    if (p['lb'] === 'renamed') { o.live.BCC = 'renamed'; }
    if (p['ls'] === 'renamed') { o.live.SCC = 'renamed'; }
    (p['off'] ?? '').split(',').filter(Boolean).forEach(id => { o.down[id] = true; });
    this.overrides.set(o);

    if (p['who'] === 'new' || p['who'] === 'existing') { this.cohort.set(p['who']); }

    const step = Number(p['step']);
    this.stepIndex.set(step >= 0 && step < this.frames().length ? step : 0);
  }
}
