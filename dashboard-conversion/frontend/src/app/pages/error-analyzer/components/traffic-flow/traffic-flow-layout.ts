import type {
  GtmId, Resolution, Severity, SimState, SiteId
} from '../../models/traffic-flow.model';
import {
  APIC_INSTANCES, APP_SERVERS, NAME_SERVERS, SITES, SITE_IDS,
  TOGGLEABLE_NODE, WEB_SERVERS
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
}

/** A laid-out edge. */
export interface TfEdge {
  d: string;
  kind: 'base' | 'taken' | 'crossover' | 'broken';
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
const SITE_X: Record<SiteId, number> = { BCC: 290, SCC: 910 };
const CANVAS = { width: 1200, height: 1105 };

type Geom = { x: number; y: number; width: number; height: number };

function line(text: string, bold = false) { return { text, bold }; }

/** Builds every box on the diagram, before any path state is applied. */
function baseNodes(res: Resolution): Record<string, any> {
  const n: Record<string, any> = {};

  n['client'] = { x: 530, y: 20, width: 140, height: 44, outline: true,
    lines: [line('CDB UI', true)] };

  n['gtm-bos'] = { x: 190, y: ROW.gtm - 85, width: 290, height: 170, outline: true, ellipse: true,
    lines: [line('GTM-CDB-BOS', true), line('www1.bmo.com/banking/services/*'),
      line('Liveness: /banking/live.txt'), line('Stickiness: cdbbossiteId'),
      line(res.gtmDistribution.bos, true)] };

  n['gtm-api'] = { x: 700, y: ROW.gtm - 85, width: 290, height: 170, outline: true, ellipse: true,
    lines: [line('GTM-CDB-API', true), line('www1.bmo.com/api/cdb'),
      line('wlb.apis.olbb.akadns.net'), line('Liveness: TCP on port 443'),
      line('Stickiness: cdbbossiteId'), line(res.gtmDistribution.api, true)] };

  n['cloudlet'] = { x: 410, y: ROW.cloudlet, width: 380, height: 66, outline: true, radius: 33,
    lines: [line('cloudlet Configuration', true), line('Set x-bmo-env=blue or Green'),
      line('Set x-api-key=pr1_key or pr2_key')] };

  return n;
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
  const railX = site === 'BCC' ? 70 : 1130;
  const sx = site === 'BCC' ? c.x : c.x + c.width;
  const ex = site === 'BCC' ? ltm.x : ltm.x + ltm.width;
  return `M${sx} ${c.y + 40} H${railX} V${ltm.y + 46} H${ex}`;
}

/** Every structural edge, drawn dim underneath the taken path. */
function baseEdgePairs(): [string, string][] {
  const pairs: [string, string][] = [
    ['client', 'gtm-bos'], ['client', 'gtm-api'],
    ['gtm-bos', 'cloudlet'], ['gtm-api', 'cloudlet']
  ];
  SITE_IDS.forEach(s => {
    pairs.push(['cloudlet', `apicfs-${s}`]);
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
    { x: 150, y: ROW.cloudlet + 34, text: '/banking/services', kind: 'edge' },
    { x: 960, y: ROW.cloudlet + 34, text: '/banking/services', kind: 'edge' },
    { x: 810, y: ROW.gtm + 105, text: '/api/cdb', kind: 'edge' }
  ];
  SITE_IDS.forEach(s => {
    const split = res.extGtmSplit[s];
    labels.push({
      x: SITE_X[s] + 8, y: ROW.extGtm + 118, text: split.own,
      kind: split.own === '100%' ? 'edge' : 'alert'
    });
    labels.push({
      x: SITE_X[s] + (s === 'BCC' ? 150 : -210), y: ROW.extGtm + 136,
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
  { x: 40, y: 100, width: 1120, height: 196, title: 'Akamai' },
  { x: 40, y: 400, width: 1120, height: 555, title: 'CWH Web' },
  { x: 40, y: 965, width: 1120, height: 120, title: 'CWH app' }
];

/**
 * Lays out the traffic-flow diagram for a given state and resolution.
 * Pure: geometry only. Nodes on the taken path carry their hop number so the
 * order of traversal is readable without animation.
 */
export function buildTrafficGraph(state: SimState, res: Resolution): TfGraph {
  const geom = baseNodes(res);
  siteNodes(geom, state);
  const entrySite = res.apicSite ?? res.bosSite;

  // Map node id -> position in the taken path.
  const onPath: Record<string, { hop: number; state: Severity }> = {};
  res.steps.forEach((s, i) => s.ids.forEach(id => { onPath[id] = { hop: i + 1, state: s.state }; }));

  const edges: TfEdge[] = baseEdgePairs()
    .filter(([a, b]) => geom[a] && geom[b])
    .map(([a, b]) => ({ d: curve(geom[a], geom[b]), kind: 'base' as const }));
  SITE_IDS.forEach(s => edges.push({ d: railPath(geom, s), kind: 'base' }));

  // The taken path, drawn over the top.
  for (let i = 0; i < res.steps.length - 1; i++) {
    const next = res.steps[i + 1];
    res.steps[i].ids.forEach(a => next.ids.forEach(b => {
      if (!geom[a] || !geom[b]) { return; }
      const leavesEntry = (a.startsWith('extgtm') || a.startsWith('gtm-') || a === 'cloudlet') &&
        b.includes('-') && !!entrySite && !b.includes(`-${entrySite}`);
      const kind: TfEdge['kind'] = next.state === 'bad' ? 'broken'
        : leavesEntry ? 'crossover' : 'taken';
      const d = a === 'cloudlet' && b.startsWith('ltm-') && res.bosSite
        ? railPath(geom, res.bosSite)
        : curve(geom[a], geom[b]);
      edges.push({ d, kind });
    }));
  }

  const nodes: TfNode[] = Object.keys(geom).map(id => {
    const g = geom[id];
    const hit = onPath[id];
    const off = !!state.down[id];
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
      isBreak: res.breakAt === id
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
