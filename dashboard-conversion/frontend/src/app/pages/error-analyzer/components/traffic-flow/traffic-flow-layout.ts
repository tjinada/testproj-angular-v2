import type {
  Cohort, CohortResult, GtmId, JourneyFrame, Resolution, Severity, SimState, SiteId
} from '../../models/traffic-flow.model';
import {
  APIC_INSTANCES, APP_SERVERS, NAME_SERVERS, SITES, SITE_COOKIE_NAME, SITE_IDS,
  TOGGLEABLE_NODE, WEB_SERVERS, WGA_INSTANCES
} from './traffic-topology';

/** A laid-out box on the diagram. */
export interface TfNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Text lines; `bold` drives the heavier first line. */
  lines: { text: string; bold: boolean }[];
  /** White fill with dark text (edge tiers) vs solid blue (infrastructure). */
  outline: boolean;
  ellipse: boolean;
  radius: number;
  /** Change-required marker carried over from the architecture diagram. */
  warn: boolean;
  toggleable: boolean;
  /** Position in the taken path, 1-based. Null when not on the path. */
  hop: number | null;
  state: Severity | null;
  outOfService: boolean;
  isBreak: boolean;
  /**
   * Which cohorts traverse this node. 'both' renders in the existing blue —
   * only genuine divergence takes a cohort colour, so a healthy estate draws
   * exactly as it always has.
   */
  cohort: CohortTag | null;
  /** True when a cohort is focused and this node belongs only to the other. */
  muted: boolean;
}

/** Cohort membership of a drawn element. */
export type CohortTag = 'both' | Cohort;

/** A laid-out edge. */
export interface TfEdge {
  d: string;
  kind: 'base' | 'taken' | 'crossover' | 'broken';
  cohort: CohortTag | null;
  muted: boolean;
}

/** A free-floating text label (swimlane titles, edge annotations). */
export interface TfLabel {
  x: number;
  y: number;
  text: string;
  kind: 'lane' | 'edge' | 'alert';
}

/** A swimlane band. */
export interface TfLane {
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
}

/** A clickable site-pick chip rendered inside a GTM oval. */
export interface TfPill {
  gtm: GtmId;
  site: SiteId;
  x: number;
  y: number;
  width: number;
  height: number;
  selected: boolean;
  /** False when a cookie bypasses the GTM, or health has overridden the pick. */
  active: boolean;
}

export interface TfGraph {
  nodes: TfNode[];
  edges: TfEdge[];
  labels: TfLabel[];
  lanes: TfLane[];
  pills: TfPill[];
  width: number;
  height: number;
}

/** Vertical rhythm, transcribed from the architecture diagram. */
const ROW = {
  gtm: 195, cloudlet: 330, apicFs: 445, apic: 545,
  extGtm: 625, ltm: 765, web: 885, app: 995
};
const SITE_X: Record<SiteId, number> = { BCC: 560, SCC: 1000 };

/**
 * ISAM columns sit outboard of the BOS columns, as on the architecture diagram.
 * The ISAM LTM shares the APIC FS row and the WGA tier shares the APIC instance
 * row, so the two authentication front doors read side by side.
 */
const ISAM_X: Record<SiteId, number> = { BCC: 200, SCC: 1360 };

/** Vertical run of the /banking/services rails, threaded between the columns. */
const RAIL_X: Record<SiteId, number> = { BCC: 371, SCC: 1188 };

/** Horizontal run of the csgcb leg to the far site, below the cloudlet. */
const CSGCB_RAIL_Y = 420;

const CANVAS = { width: 1560, height: 1105 };

type Geom = { x: number; y: number; width: number; height: number };

function line(text: string, bold = false) { return { text, bold }; }

/** Builds every box on the diagram, before any path state is applied. */
function baseNodes(res: Resolution): Record<string, any> {
  const n: Record<string, any> = {};

  n['client'] = { x: 710, y: 20, width: 140, height: 44, outline: true,
    lines: [line('CDB UI', true)] };

  n['gtm-bos'] = { x: 415, y: ROW.gtm - 85, width: 290, height: 170, outline: true, ellipse: true,
    lines: [line('GTM-CDB-BOS', true), line('www1.bmo.com/banking/services/*'),
      line('Liveness: /banking/live.txt'), line('Stickiness: cdbbossiteId'),
      line(res.gtmDistribution.bos, true)] };

  n['gtm-api'] = { x: 855, y: ROW.gtm - 85, width: 290, height: 170, outline: true, ellipse: true,
    lines: [line('GTM-CDB-API', true), line('www1.bmo.com/api/cdb'),
      line('wlb.apis.olbb.akadns.net'), line('Liveness: TCP on port 443'),
      line('Stickiness: cdbbossiteId'), line(res.gtmDistribution.api, true)] };

  n['cloudlet'] = { x: 590, y: ROW.cloudlet, width: 380, height: 66, outline: true, radius: 33,
    lines: [line('cloudlet Configuration', true), line('Set x-bmo-env=blue or Green'),
      line('Set x-api-key=pr1_key or pr2_key')] };

  // The csgcb entry point. Drawn on every path so the estate reads whole, but
  // only on the taken path when the request is actually csgcb.
  n['akamai-prop'] = { x: 60, y: ROW.cloudlet, width: 280, height: 66,
    outline: true, radius: 33,
    lines: [line('Property Configuration', true),
      line(`if ${SITE_COOKIE_NAME} = BCC/SCC`),
      line('→ ISAM origin, no GTM')] };

  return n;
}

/** Adds the per-site legacy ISAM column: ISAM LTM and its WGA instances. */
function isamNodes(all: Record<string, any>): void {
  SITE_IDS.forEach(site => {
    const cx = ISAM_X[site];

    all[`isamltm-${site}`] = { x: cx - 125, y: ROW.apicFs, width: 250, height: 66,
      lines: [line(`ISAM LTM (${site})`, true), line(SITES[site].isamLtm),
        line('monitor: TCP (no liveness)')] };

    for (let i = 1; i <= WGA_INSTANCES; i++) {
      all[`wga-${site}-${i}`] = { x: cx - 153 + (i - 1) * 52, y: ROW.apic,
        width: 46, height: 54,
        lines: [line('ISAM'), line('WGA'), line(`#${i}`)] };
    }
  });
}

/** Adds the per-site column: APIC FS, APIC instances, EXT GTM, LTM, web, app. */
function siteNodes(all: Record<string, any>, state: SimState): void {
  SITE_IDS.forEach(site => {
    const cx = SITE_X[site];
    const facts = SITES[site];

    all[`apicfs-${site}`] = { x: cx - 110, y: ROW.apicFs, width: 220, height: 66,
      lines: [line(`APIC FS (${site})`, true), line('bmonsori-'),
        line(facts.apicFs.replace('bmonsori-', ''))] };

    for (let i = 1; i <= APIC_INSTANCES; i++) {
      all[`apic-${site}-${i}`] = { x: cx - 170 + (i - 1) * 120, y: ROW.apic,
        width: 100, height: 46, warn: true, lines: [line(`APIC inst #${i}`)] };
    }

    all[`extgtm-${site}`] = { x: cx - 125, y: ROW.extGtm, width: 250, height: 116, warn: true,
      lines: [line('EXT GTM (DNS)', true), line(facts.extGtm),
        line(`monitor: ${state.extGtmMonitor === 'live' ? '/banking/live.txt' : 'httpd TCP'}`, true),
        ...NAME_SERVERS.map(s => line(s))] };

    all[`ltm-${site}`] = { x: cx - 125, y: ROW.ltm, width: 250, height: 92,
      lines: [line('BOS LTM (Local traffic', true), line(`manager) (${site})`, true),
        line('CWH-WEB'), line(facts.ltmHost), line(facts.ltmVip)] };

    for (let i = 1; i <= WEB_SERVERS; i++) {
      all[`web-${site}-${i}`] = { x: cx - 132 + (i - 1) * 145, y: ROW.web, width: 120, height: 54,
        lines: [line('BOS Web'), line(`Server ${i} (${site})`)] };
    }
    for (let i = 1; i <= APP_SERVERS; i++) {
      all[`app-${site}-${i}`] = { x: cx - 153 + (i - 1) * 52, y: ROW.app, width: 46, height: 54,
        lines: [line('BOS'), line('App'), line(`#${i}`)] };
    }
  });
}

/** Bezier from the bottom of one box to the top of another. */
function curve(a: Geom, b: Geom): string {
  const x1 = a.x + a.width / 2, y1 = a.y + a.height;
  const x2 = b.x + b.width / 2, y2 = b.y;
  const my = (y1 + y2) / 2;
  return `M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${y2}`;
}

/**
 * The /banking/services rails, which run down the outside of the canvas from
 * the cloudlet straight to the BOS LTM, bypassing APIC entirely.
 */
function railPath(all: Record<string, Geom>, site: SiteId): string {
  const c = all['cloudlet'], ltm = all[`ltm-${site}`];
  const railX = RAIL_X[site];
  const sx = site === 'BCC' ? c.x : c.x + c.width;
  const ex = site === 'BCC' ? ltm.x : ltm.x + ltm.width;
  return `M${sx} ${c.y + 40} H${railX} V${ltm.y + 46} H${ex}`;
}

/**
 * Client to the property rule. Routed over the top of the GTM ovals rather than
 * through them: a bezier between these two boxes arcs straight across
 * GTM-CDB-BOS, which would draw the csgcb path through the very GTM it bypasses.
 */
function clientPropPath(all: Record<string, Geom>): string {
  const c = all['client'], p = all['akamai-prop'];
  const sx = c.x + c.width / 2, tx = p.x + p.width / 2;
  return `M${sx} ${c.y + c.height} V88 H${tx} V${p.y}`;
}

/**
 * The csgcb leg from the property rule to an ISAM LTM. BCC drops straight down;
 * SCC runs below the cloudlet before turning, so it clears that box.
 */
function csgcbPath(all: Record<string, Geom>, site: SiteId): string {
  const p = all['akamai-prop'], t = all[`isamltm-${site}`];
  if (site === 'BCC') { return curve(p, t); }
  const sx = p.x + p.width / 2, tx = t.x + t.width / 2;
  return `M${sx} ${p.y + p.height} V${CSGCB_RAIL_Y} H${tx} V${t.y}`;
}

/**
 * The WGA junction to same-site BOS. Drawn as an orthogonal rail rather than a
 * bezier: a curve from the WGA row to the LTM would pass straight through the
 * EXT GTM box sitting between them.
 */
function wgaRail(all: Record<string, Geom>, site: SiteId): string {
  const first = all[`wga-${site}-1`];
  const last = all[`wga-${site}-${WGA_INSTANCES}`];
  const sx = (first.x + last.x + last.width) / 2;
  const ltm = all[`ltm-${site}`];
  const ex = site === 'BCC' ? ltm.x : ltm.x + ltm.width;
  return `M${sx} ${first.y + first.height} V${ltm.y + 20} H${ex}`;
}

/** Every structural edge, drawn dim underneath the taken path. */
function baseEdgePairs(): [string, string][] {
  const pairs: [string, string][] = [
    ['client', 'gtm-bos'], ['client', 'gtm-api'],
    ['gtm-bos', 'cloudlet'], ['gtm-api', 'cloudlet']
  ];
  SITE_IDS.forEach(s => {
    pairs.push(['cloudlet', `apicfs-${s}`]);
    for (let i = 1; i <= WGA_INSTANCES; i++) {
      pairs.push([`isamltm-${s}`, `wga-${s}-${i}`]);
    }
    for (let i = 1; i <= APIC_INSTANCES; i++) {
      pairs.push([`apicfs-${s}`, `apic-${s}-${i}`], [`apic-${s}-${i}`, `extgtm-${s}`]);
    }
    pairs.push([`extgtm-${s}`, `ltm-${s}`]);
    for (let w = 1; w <= WEB_SERVERS; w++) {
      pairs.push([`ltm-${s}`, `web-${s}-${w}`]);
      for (let a = 1; a <= APP_SERVERS; a++) { pairs.push([`web-${s}-${w}`, `app-${s}-${a}`]); }
    }
  });
  return pairs;
}

/** Static annotations carried over from the architecture diagram. */
function baseLabels(state: SimState, res: Resolution): TfLabel[] {
  const labels: TfLabel[] = [
    { x: RAIL_X.BCC + 6, y: ROW.cloudlet + 30, text: '/banking/services', kind: 'edge' },
    { x: RAIL_X.SCC + 6, y: ROW.cloudlet + 30, text: '/banking/services', kind: 'edge' },
    { x: 965, y: ROW.gtm + 105, text: '/api/cdb', kind: 'edge' },
    // Sits right of the CWH Web lane title and above the trap alert, in the
    // gap between the property-rule box and the ISAM LTM row.
    { x: 210, y: CSGCB_RAIL_Y - 6, text: '/banking/services/csgcb', kind: 'edge' }
  ];

  /*
   * The shared-cookie trap. On a split /api/cdb request the cookie is stamped
   * from the APIC answer, so the ISAM column that the *next* csgcb call will
   * pin is marked here — during the request that arms it, not the one that
   * springs it.
   */
  if (res.path === 'api' && res.apicSite && res.bosSite && res.apicSite !== res.bosSite) {
    labels.push({
      x: ISAM_X[res.apicSite] - 120, y: ROW.apicFs - 10,
      text: `next csgcb pins here → ${res.apicSite} BOS`, kind: 'alert'
    });
  }

  SITE_IDS.forEach(s => {
    const split = res.extGtmSplit[s];
    labels.push({
      x: SITE_X[s] + 8, y: ROW.extGtm + 118, text: split.own,
      kind: split.own === '100%' ? 'edge' : 'alert'
    });
    // Both crossover labels point inward, and the columns sit closer together
    // than they used to, so they are staggered vertically rather than relying
    // on the gap being wider than the text.
    labels.push({
      x: SITE_X[s] + (s === 'BCC' ? 150 : -210),
      y: ROW.extGtm + (s === 'BCC' ? 136 : 152),
      text: split.cross,
      kind: split.cross.startsWith('0%') ? 'edge' : 'alert'
    });
    if (state.live[s] !== 'present') {
      labels.push({
        x: SITE_X[s] - 150, y: ROW.web - 8,
        text: '/banking/live.txt → dead.txt', kind: 'alert'
      });
    }
  });
  return labels;
}

/** Site-pick chips, centred low inside each GTM oval. */
function buildPills(state: SimState, res: Resolution, geom: Record<string, Geom>): TfPill[] {
  const pills: TfPill[] = [];
  const spec: { gtm: GtmId; node: string }[] = [
    { gtm: 'bos', node: 'gtm-bos' },
    { gtm: 'api', node: 'gtm-api' }
  ];
  spec.forEach(({ gtm, node }) => {
    const g = geom[node];
    if (!g) { return; }
    // Only the GTM fronting the current path takes part in this request.
    const inPath = (gtm === 'api') === (res.path === 'api');
    const overridden = !res.gtmDistribution[gtm].startsWith('50/50');
    const answered = res.gtmAnswer[gtm];
    SITE_IDS.forEach((site, i) => {
      pills.push({
        gtm, site,
        x: g.x + g.width / 2 - 55 + i * 58,
        y: g.y + g.height - 40,
        width: 52, height: 19,
        // Show what the GTM actually answers, not a pick health has overridden.
        selected: answered ? answered === site : state.gtmPick[gtm] === site,
        active: inPath && res.gtmActive && !overridden
      });
    });
  });
  return pills;
}

const LANES: TfLane[] = [
  { x: 40, y: 100, width: 1480, height: 196, title: 'Akamai' },
  { x: 40, y: 400, width: 1480, height: 555, title: 'CWH Web' },
  { x: 40, y: 965, width: 1480, height: 120, title: 'CWH app' }
];

/**
 * The frame's headline cohort — drives labels, pills, hop numbers and the
 * outcome the diagram is annotated for. The focused cohort wins; failing beats
 * succeeding, because the failure is what the tool was opened for.
 */
function pickPrimary(results: CohortResult[], focus: Cohort | null): CohortResult {
  if (focus) {
    const f = results.find(r => r.cohort === focus);
    if (f) { return f; }
  }
  return results.find(r => r.resolution.outcome.severity === 'bad')
    ?? results.find(r => r.cohort === 'existing')
    ?? results[0];
}

type PathMap = Record<string, { hop: number; state: Severity }>;

function traversal(res: Resolution): PathMap {
  const m: PathMap = {};
  res.steps.forEach((s, i) => s.ids.forEach(id => { m[id] = { hop: i + 1, state: s.state }; }));
  return m;
}

/**
 * Lays out the traffic-flow diagram for one journey frame.
 *
 * Both cohorts are drawn at once, but only where they actually differ: a node
 * or edge travelled by both renders in the existing blue, and cohort colour
 * appears solely on the divergent tail. On a healthy estate the two cohorts
 * take the same route, so nothing is two-tone and the frame is identical to
 * what a single-path render produced.
 *
 * Pure: geometry only.
 */
export function buildTrafficGraph(frame: JourneyFrame, focus: Cohort | null = null): TfGraph {
  const state = frame.state;
  const results = frame.results;
  const primary = pickPrimary(results, focus);
  const res = primary.resolution;

  const geom = baseNodes(res);
  isamNodes(geom);
  siteNodes(geom, state);

  const paths = new Map<Cohort, PathMap>();
  results.forEach(r => paths.set(r.cohort, traversal(r.resolution)));

  const memberOf = (id: string): CohortTag | null => {
    const inNew = !!paths.get('new')?.[id];
    const inOld = !!paths.get('existing')?.[id];
    if (inNew && inOld) { return 'both'; }
    if (inNew) { return 'new'; }
    return inOld ? 'existing' : null;
  };

  /** Hop badge: the primary cohort's number, falling back to the other's. */
  const hitFor = (id: string) => {
    const p = paths.get(primary.cohort)?.[id];
    if (p) { return p; }
    for (const r of results) {
      const h = paths.get(r.cohort)?.[id];
      if (h) { return h; }
    }
    return null;
  };

  const edges: TfEdge[] = baseEdgePairs()
    .filter(([a, b]) => geom[a] && geom[b])
    .map(([a, b]) => ({
      d: curve(geom[a], geom[b]), kind: 'base' as const, cohort: null, muted: false
    }));
  const baseRail = (d: string): TfEdge => ({ d, kind: 'base', cohort: null, muted: false });
  edges.push(baseRail(clientPropPath(geom)));
  SITE_IDS.forEach(s => edges.push(
    baseRail(railPath(geom, s)), baseRail(csgcbPath(geom, s)), baseRail(wgaRail(geom, s))
  ));

  // Taken edges, per cohort, deduped by geometry so a shared hop is drawn once.
  const taken = new Map<string, { d: string; kind: TfEdge['kind']; who: Set<Cohort> }>();
  results.forEach(r => {
    const rs = r.resolution;
    const entrySite = rs.apicSite ?? rs.bosSite;
    for (let i = 0; i < rs.steps.length - 1; i++) {
      const next = rs.steps[i + 1];
      rs.steps[i].ids.forEach(a => next.ids.forEach(b => {
        if (!geom[a] || !geom[b]) { return; }
        const leavesEntry = (a.startsWith('extgtm') || a.startsWith('gtm-') || a === 'cloudlet') &&
          b.includes('-') && !!entrySite && !b.includes(`-${entrySite}`);
        const kind: TfEdge['kind'] = next.state === 'bad' ? 'broken'
          : leavesEntry ? 'crossover' : 'taken';
        // Four hops are drawn as rails rather than beziers, so the taken path
        // has to reuse the same geometry or it would peel away from the dim
        // edge underneath it.
        const d = a === 'cloudlet' && b.startsWith('ltm-') && rs.bosSite
          ? railPath(geom, rs.bosSite)
          : a === 'client' && b === 'akamai-prop'
            ? clientPropPath(geom)
            : a === 'akamai-prop' && b.startsWith('isamltm-')
              ? csgcbPath(geom, b.slice('isamltm-'.length) as SiteId)
              : a.startsWith('wga-') && b.startsWith('ltm-')
                ? wgaRail(geom, b.slice('ltm-'.length) as SiteId)
                : curve(geom[a], geom[b]);
        const key = `${kind}|${d}`;
        const e = taken.get(key) ?? { d, kind, who: new Set<Cohort>() };
        e.who.add(r.cohort);
        taken.set(key, e);
      }));
    }
  });

  taken.forEach(e => {
    const solo = e.who.size === 1 ? [...e.who][0] : null;
    edges.push({
      d: e.d, kind: e.kind,
      cohort: solo ?? 'both',
      muted: focus !== null && solo !== null && solo !== focus
    });
  });

  const nodes: TfNode[] = Object.keys(geom).map(id => {
    const g = geom[id];
    const hit = hitFor(id);
    const off = !!state.down[id];
    const cohort = off ? null : memberOf(id);
    return {
      id,
      x: g.x, y: g.y, width: g.width, height: g.height,
      lines: g.lines,
      outline: !!g.outline,
      ellipse: !!g.ellipse,
      radius: g.radius ?? 3,
      warn: !!g.warn && !off,
      toggleable: TOGGLEABLE_NODE.test(id),
      hop: hit && !off ? hit.hop : null,
      state: hit && !off ? hit.state : null,
      outOfService: off,
      isBreak: results.some(r => r.resolution.breakAt === id),
      cohort,
      muted: focus !== null && cohort !== null && cohort !== 'both' && cohort !== focus
    };
  });

  return {
    nodes,
    edges,
    labels: baseLabels(state, res),
    lanes: LANES,
    pills: buildPills(state, res, geom),
    width: CANVAS.width,
    height: CANVAS.height
  };
}
