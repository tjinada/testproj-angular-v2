import type {
  Cohort, GtmId, JourneyFrame, Resolution, Severity, SimState, SiteId, WeightedGtm
} from '../../models/traffic-flow.model';
import {
  APIC_INSTANCES, APP_SERVERS, AUTH_SPA_API_HOSTNAME, AWS_API_GW, IDP_COOKIE_NAME, IDP_LIVENESS,
  IDP_WGA_INSTANCES,
  ISAM_GTM_HOSTNAME, LAMBDAS, NAME_SERVERS,
  SITES, SITE_COOKIE_NAME, SITE_IDS, SSS_GSS_HOSTNAME, TOGGLEABLE_NODE, WEB_SERVERS, WGA_INSTANCES
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
  /** Height reserved at the bottom for an in-box switch; text centres above it. */
  footer: number;
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
  /** Which call travels here, for the cohort on the diagram. */
  flow: FlowTag | null;
  /** Data centre the box belongs to. Null for shared tiers. */
  site: SiteId | null;
  /**
   * Tier head (APIC FS, EXT GTM, BOS LTM, ISAM LTMs): carries the site as a pill
   * on its top edge instead of "(BCC)" in the title. Instance boxes under it get
   * a colour strip only.
   */
  head: boolean;
  /**
   * Lit by the current call's downstream fan-out. Fan-out hops have no order,
   * so these carry a state but no hop badge.
   */
  fanout: boolean;
}

/**
 * What a drawn element represents. 'current' is the call the frame is showing;
 * 'context' is the sign-in that pinned the cookie, drawn faintly underneath so
 * you can see where the current call's routing came from.
 */
export type FlowTag = 'current' | 'context';

/** A laid-out edge. */
export interface TfEdge {
  d: string;
  /** 'failover' is a per-site GSS leg used only when the site's own SSS is down. */
  kind: 'base' | 'taken' | 'crossover' | 'broken' | 'failover';
  flow: FlowTag | null;
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
  /**
   * Row caption, on the first pill of a row only. Set where one GTM carries
   * more than one hostname, each with its own pick.
   */
  row?: string;
}

/** Which override a chip flips. Monitors are one setting across both sites. */
export type ChipKind = 'extgtm' | 'ltm' | 'idplive' | 'live' | 'gtmw';

/**
 * A setting toggle drawn on the box it configures. Rendered above the nodes so
 * it stays clickable at full opacity even when its box is dimmed.
 */
export interface TfChip {
  kind: ChipKind;
  site: SiteId;
  x: number;
  y: number;
  width: number;
  label: string;
  value: string;
  /** Differs from the production default. */
  changed: boolean;
  /** Owned by the outage scenario, so not editable here. */
  locked: boolean;
  /** The values the switch offers, in display order. */
  options: string[];
  /** Which GTM a weighting switch sets. */
  gtm?: WeightedGtm;
}

export interface TfGraph {
  nodes: TfNode[];
  edges: TfEdge[];
  labels: TfLabel[];
  lanes: TfLane[];
  pills: TfPill[];
  chips: TfChip[];
  width: number;
  height: number;
}

/** Vertical rhythm, transcribed from the architecture diagram. */
const ROW = {
  gtm: 195, cloudlet: 330, apicFs: 445, apic: 545,
  extGtm: 625, ltm: 785, web: 925, app: 1065
};
const SITE_X: Record<SiteId, number> = { BCC: 860, SCC: 1300 };

/**
 * Legacy ISAM columns sit outboard of the BOS columns, as on the architecture
 * diagram. The ISAM Legacy LTM shares the APIC FS row and the WGA tier shares
 * the APIC instance row, so the two authentication front doors read side by side.
 */
const ISAM_X: Record<SiteId, number> = { BCC: 500, SCC: 1660 };

/**
 * ISAM IdP columns sit outboard of the legacy ISAM columns, on the same rows.
 * Reached from GTM-ISAM by the authentication.bmo.com call.
 */
const IDP_X: Record<SiteId, number> = { BCC: 200, SCC: 1960 };

/** Vertical run of the /banking/services rails, threaded between the columns. */
const RAIL_X: Record<SiteId, number> = { BCC: 671, SCC: 1488 };

/** Horizontal run of the csgcb leg to the far site, below the cloudlet. */
const CSGCB_RAIL_Y = 420;

/** Horizontal run of the GTM-ISAM legs, just below the Akamai lane. */
const ISAM_GTM_RAIL_Y = 310;

/**
 * Horizontal run of the apis.bmo.com legs, in the gap just above the APIC
 * FS row. Lower than the GTM-ISAM rail so the two never run alongside.
 */
const SPA_RAIL_Y = 436;

/** Where the SPA rail drops into an APIC FS box, offset from the cloudlet edge. */
const SPA_RAIL_DROP = 40;

/**
 * SSS V2 and AWS rows, below CWH app. Lit by the downstream calls CDBBOS and
 * CWH APIC make once a request is served.
 */
const SSS_ROW = { gss: 1200, f5: 1350, apic: 1470, ocp: 1620, aws: 1775 };

/** AWS: one gateway, with its Lambdas stacked to its right. */
const AWS_GW_X = 930;
const LAMBDA_X = 1330;

/** SSS columns sit outboard of the BOS columns so the CDBBOS legs fan out. */
const SSS_X: Record<SiteId, number> = { BCC: 600, SCC: 1560 };

/** Half-width of an SSS V2 APIC box; /api/cdb enters left of centre, /api right. */
const SSS_APIC_HALF = 230;
const SSS_PATH_DX = 115;

const CANVAS = { width: 2500, height: 1930 };

type Geom = { x: number; y: number; width: number; height: number };

function line(text: string, bold = false) { return { text, bold }; }

/** Builds every box on the diagram, before any path state is applied. */
function baseNodes(res: Resolution): Record<string, any> {
  const n: Record<string, any> = {};

  // The SPA makes every call, including the CIAM login ones (authentication
  // and apis.bmo.com). Centred over GTM-APIC so its three edges fan out
  // left, down and right without crossing.
  n['client'] = { x: 1230, y: 20, width: 140, height: 44, outline: true,
    lines: [line('CDB UI', true)] };

  // Each Akamai GTM's distribution is its weighting switch, drawn above the pills.
  n['gtm-bos'] = { x: 715, y: ROW.gtm - 85, width: 290, height: 170, footer: 66, outline: true, ellipse: true,
    lines: [line('GTM-CDB-BOS', true), line('www1.bmo.com/banking/services/*'),
      line('Liveness: /banking/live.txt'), line('Stickiness: cdbbossiteId')] };

  // One GTM property for both hostnames: shared TCP:443 health, but each
  // hostname is resolved on its own, so each keeps its own pick (two pill rows).
  n['gtm-api'] = { x: 1145, y: ROW.gtm - 97, width: 310, height: 194, footer: 90,
    outline: true, ellipse: true,
    lines: [line('GTM-APIC', true), line('www1.bmo.com/api/cdb'), line('apis.bmo.com/api/*'),
      line(AUTH_SPA_API_HOSTNAME), line('Liveness: TCP on port 443')] };

  n['gtm-isam'] = { x: 1595, y: ROW.gtm - 85, width: 290, height: 170, footer: 66, outline: true, ellipse: true,
    lines: [line('GTM-ISAM', true), line('authentication.bmo.com/aac/*'),
      line(ISAM_GTM_HOSTNAME), line(`Liveness: ${IDP_LIVENESS}`),
      line(`Stickiness: ${IDP_COOKIE_NAME}`)] };

  n['cloudlet'] = { x: 890, y: ROW.cloudlet, width: 380, height: 66, outline: true, radius: 33,
    lines: [line('cloudlet Configuration', true), line('Set x-bmo-env=blue or Green'),
      line('Set x-api-key=pr1_key or pr2_key')] };

  // The csgcb entry point. Drawn on every path so the estate reads whole, but
  // only on the taken path when the request is actually csgcb.
  n['akamai-prop'] = { x: 360, y: ROW.cloudlet, width: 280, height: 66,
    outline: true, radius: 33,
    lines: [line('Property Configuration', true),
      line(`if ${SITE_COOKIE_NAME} = BCC/SCC`),
      line('→ ISAM origin, no GTM')] };

  return n;
}

/** Adds the per-site ISAM IdP column: IdP LTM and its WGA instances. */
function idpNodes(all: Record<string, any>): void {
  SITE_IDS.forEach(site => {
    const cx = IDP_X[site];

    // Taller than its neighbours to hold the mobileidp.gif switch in its footer.
    all[`idpltm-${site}`] = { x: cx - 125, y: ROW.apicFs, width: 250, height: 96, footer: 30,
      lines: [line(`ISAM IdP LTM (${site})`, true), line('bmonsori-'),
        line(SITES[site].idpLtm.replace('bmonsori-', ''))] };

    // A row lower than the other WGA tiers, below the taller IdP LTM.
    for (let i = 1; i <= IDP_WGA_INSTANCES; i++) {
      all[`idpwga-${site}-${i}`] = { x: cx - 101 + (i - 1) * 52, y: ROW.apic + 30,
        width: 46, height: 54,
        lines: [line('ISAM'), line('WGA'), line(`#${i}`)] };
    }
  });
}

/** Adds the per-site legacy ISAM column: ISAM Legacy LTM and its WGA instances. */
function isamNodes(all: Record<string, any>): void {
  SITE_IDS.forEach(site => {
    const cx = ISAM_X[site];

    all[`isamltm-${site}`] = { x: cx - 125, y: ROW.apicFs, width: 250, height: 66,
      lines: [line(`ISAM Legacy LTM (${site})`, true), line(SITES[site].isamLtm),
        line('no health check — cookie bound')] };

    for (let i = 1; i <= WGA_INSTANCES; i++) {
      all[`wga-${site}-${i}`] = { x: cx - 153 + (i - 1) * 52, y: ROW.apic,
        width: 46, height: 54,
        lines: [line('ISAM'), line('WGA'), line(`#${i}`)] };
    }
  });
}

/** Adds the per-site column: APIC FS, APIC instances, EXT GTM, LTM, web, app. */
function siteNodes(all: Record<string, any>): void {
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

    // The monitor is shown and set by the chip on this box, not a text line.
    all[`extgtm-${site}`] = { x: cx - 125, y: ROW.extGtm, width: 250, height: 140, footer: 30, warn: true,
      lines: [line('EXT GTM (DNS)', true), line(facts.extGtm),
        ...NAME_SERVERS.map(s => line(s))] };

    all[`ltm-${site}`] = { x: cx - 125, y: ROW.ltm, width: 250, height: 116, footer: 30,
      lines: [line('BOS LTM (Local traffic', true), line(`manager) (${site})`, true),
        line('CWH-WEB'), line(facts.ltmHost), line(facts.ltmVip)] };

    for (let i = 1; i <= WEB_SERVERS; i++) {
      // Footer holds the site's live.txt switch.
      all[`web-${site}-${i}`] = { x: cx - 132 + (i - 1) * 145, y: ROW.web, width: 120, height: 84, footer: 30,
        lines: [line('BOS Web'), line(`Server ${i} (${site})`)] };
    }
    for (let i = 1; i <= APP_SERVERS; i++) {
      all[`app-${site}-${i}`] = { x: cx - 153 + (i - 1) * 52, y: ROW.app, width: 46, height: 54,
        lines: [line('BOS'), line('App'), line(`#${i}`)] };
    }
  });
}

/** Adds the SSS V2 and AWS tiers. */
function sssNodes(all: Record<string, any>, res: Resolution): void {
  const gss = (cx: number, lines: { text: string; bold: boolean }[]) =>
    ({ x: cx - 155, y: SSS_ROW.gss, width: 310, height: 110, footer: 30, outline: true, ellipse: true, lines });

  all['gss-BCC'] = gss(260, [line(SITES.BCC.sssGss, true), line('Per-site GSS'), line('BCC 100% · SCC 0%', true)]);
  all['gss-es'] = gss(1080, [line(SSS_GSS_HOSTNAME, true), line('GSS'), line(res.gtmDistribution.sss, true)]);
  all['gss-SCC'] = gss(1900, [line(SITES.SCC.sssGss, true), line('Per-site GSS'), line('BCC 0% · SCC 100%', true)]);

  SITE_IDS.forEach(site => {
    const cx = SSS_X[site];
    const f = SITES[site];
    all[`sssf5-${site}`] = { x: cx - 190, y: SSS_ROW.f5, width: 380, height: 66,
      lines: [line(`SSS F5 (${site})`, true), line(f.sssEsApi), line(f.sssApiSvc)] };
    all[`sssapic-${site}`] = { x: cx - SSS_APIC_HALF, y: SSS_ROW.apic, width: SSS_APIC_HALF * 2, height: 80,
      lines: [line(`SSS V2 APIC (${site})`, true), line('host TBD')] };
    all[`ocp-${site}`] = { x: cx - SSS_PATH_DX - 100, y: SSS_ROW.ocp, width: 200, height: 66,
      lines: [line('Channel Services', true), line(`OpenShift · ${f.ocpCluster}`),
        line(`*.apps.${f.ocpCluster}.ocp4-pr`)] };
  });

  all['awsgw'] = { x: AWS_GW_X, y: SSS_ROW.aws + 28, width: 300, height: 66,
    lines: [line('AWS API Gateway', true), line(AWS_API_GW.replace('.hcloud.bmogc.net', ''))] };
  for (let i = 1; i <= LAMBDAS; i++) {
    all[`lambda-${i}`] = { x: LAMBDA_X, y: SSS_ROW.aws + 10 + (i - 1) * 44, width: 170, height: 34,
      lines: [line(`Lambda ${i}`, true)] };
  }
}

/** Bezier between two points, vertical at both ends. */
function bez(x1: number, y1: number, x2: number, y2: number): string {
  const my = (y1 + y2) / 2;
  return `M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${y2}`;
}

const inwardOf = (s: SiteId) => (s === 'BCC' ? 1 : -1);
const siteOf = (id: string) => id.slice(id.lastIndexOf('-') + 1).replace(/#.*$/, '') as SiteId;

/**
 * Geometry of one downstream hop. Shared by the dim structure and the lit path
 * so the two always overlay exactly.
 *
 * `cdbbos-<SITE>` is the BOS App row as a whole; `cwhapic-<SITE>` is the CWH
 * APIC instance group; `sssapic-<SITE>#cdb` / `#api` are the two halves of an
 * SSS V2 APIC box. Returns null for a pair that is not a drawn hop.
 */
function sssLeg(all: Record<string, Geom>, a: string, b: string): string | null {
  const bottom = (g: Geom, dx = 0): [number, number] => [g.x + g.width / 2 + dx, g.y + g.height];
  const top = (g: Geom, dx = 0): [number, number] => [g.x + g.width / 2 + dx, g.y];
  const link = (p: [number, number], q: [number, number]) => bez(p[0], p[1], q[0], q[1]);
  const half = (id: string) => (id.endsWith('#cdb') ? -SSS_PATH_DX : SSS_PATH_DX);

  if (a.startsWith('cdbbos-')) {
    const s = siteOf(a), first = all[`app-${s}-1`], last = all[`app-${s}-${APP_SERVERS}`];
    const span = last.x + last.width - first.x;
    // Legs leave from the outer, centre and inner thirds of the App row.
    const at = (f: number): [number, number] => [first.x + span * f, first.y + first.height];
    const outer = s === 'BCC' ? 0.15 : 0.85, inner = s === 'BCC' ? 0.85 : 0.15;
    if (b === `gss-${s}`) { return link(at(outer), top(all[b])); }
    if (b === 'gss-es') { return link(at(inner), top(all[b], -30 * inwardOf(s))); }
    if (b === `sssf5-${s}`) { return link(at(0.5), top(all[b], 60 * inwardOf(s))); }
    return null;
  }
  if (a.startsWith('cwhapic-') && b === 'gss-es') {
    // Down the gap between the two BOS columns, clear of every box in them.
    const s = siteOf(a), i1 = all[`apic-${s}-1`], iN = all[`apic-${s}-${APIC_INSTANCES}`];
    const g = all['gss-es'];
    const sx = (i1.x + iN.x + iN.width) / 2, cx = g.x + g.width / 2;
    return `M${sx} ${i1.y + i1.height} V${i1.y + i1.height + 14} H${cx} V${g.y}`;
  }
  if (a.startsWith('gss-') && b.startsWith('sssf5-')) {
    const t = siteOf(b), g = all[a], f5 = all[b];
    if (a === 'gss-es') { return link(bottom(g, -40 * inwardOf(t)), top(f5, 120 * inwardOf(t))); }
    // Per-site GSS: own site, or the failover leg across to the other site.
    return siteOf(a) === t
      ? link(bottom(g), top(f5, -80 * inwardOf(t)))
      : link(bottom(g, -60 * inwardOf(t)), top(f5, -150 * inwardOf(t)));
  }
  if (a.startsWith('sssf5-') && b.startsWith('sssapic-')) {
    return link(bottom(all[a], half(b) > 0 ? 60 : -60), top(all[b.replace(/#.*$/, '')], half(b)));
  }
  if (a.endsWith('#cdb') && b.startsWith('ocp-')) {
    return link(bottom(all[a.replace('#cdb', '')], -SSS_PATH_DX), top(all[b]));
  }
  if (a.startsWith('ocp-') && b.endsWith('#api')) {
    // Channel Services calls back into the same site's APIC /api.
    const o = all[a], ap = all[b.replace('#api', '')];
    return `M${o.x + o.width} ${o.y + o.height / 2} H${ap.x + ap.width / 2 + SSS_PATH_DX} V${ap.y + ap.height}`;
  }
  if (a.endsWith('#api') && b === 'awsgw') {
    const s = siteOf(a);
    return link(bottom(all[a.replace('#api', '')], SSS_PATH_DX), top(all[b], -40 * inwardOf(s)));
  }
  if (a === 'awsgw' && b.startsWith('lambda-')) {
    const g = all[a], l = all[b], y = g.y + g.height / 2, ly = l.y + l.height / 2;
    return `M${g.x + g.width} ${y} H${l.x - 30} V${ly} H${l.x}`;
  }
  return null;
}

/** Every downstream hop that exists, for the dim structure underneath. */
function sssBaseLegs(): { a: string; b: string; kind: TfEdge['kind'] }[] {
  const legs: { a: string; b: string; kind: TfEdge['kind'] }[] = [];
  const add = (a: string, b: string, kind: TfEdge['kind'] = 'base') => legs.push({ a, b, kind });
  SITE_IDS.forEach(s => {
    const o: SiteId = s === 'BCC' ? 'SCC' : 'BCC';
    add(`cdbbos-${s}`, `gss-${s}`);
    add(`cdbbos-${s}`, 'gss-es');
    add(`cdbbos-${s}`, `sssf5-${s}`);
    add(`cwhapic-${s}`, 'gss-es');
    add(`gss-${s}`, `sssf5-${s}`);
    add(`gss-${s}`, `sssf5-${o}`, 'failover');
    add('gss-es', `sssf5-${s}`);
    add(`sssf5-${s}`, `sssapic-${s}#cdb`);
    add(`sssf5-${s}`, `sssapic-${s}#api`);
    add(`sssapic-${s}#cdb`, `ocp-${s}`);
    add(`ocp-${s}`, `sssapic-${s}#api`);
    add(`sssapic-${s}#api`, 'awsgw');
  });
  for (let i = 1; i <= LAMBDAS; i++) { add('awsgw', `lambda-${i}`); }
  return legs;
}

/** SSS V2 annotations. */
function sssLabels(): TfLabel[] {
  const labels: TfLabel[] = [
    { x: 1030, y: SSS_ROW.f5 - 6, text: 'per-site GSS fails over only if its own F5 or APIC is down', kind: 'edge' }
  ];
  SITE_IDS.forEach(s => {
    const cx = SSS_X[s];
    labels.push(
      { x: cx + (s === 'BCC' ? 70 : -170), y: SSS_ROW.f5 - 34, text: 'direct · no failover', kind: 'edge' },
      { x: cx - 175, y: SSS_ROW.apic - 14, text: '/api/cdb · Channels', kind: 'edge' },
      { x: cx + 70, y: SSS_ROW.apic - 14, text: '/api · DigitalCore', kind: 'edge' },
      { x: cx + SSS_PATH_DX + 6, y: SSS_ROW.ocp + 28, text: '/api · same site', kind: 'edge' }
    );
  });
  return labels;
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
  // Leaves the side of CDB UI, so it never runs under the edges fanning out below.
  const c = all['client'], p = all['akamai-prop'];
  const tx = p.x + p.width / 2;
  return `M${c.x} ${c.y + c.height / 2} H${tx} V${p.y}`;
}

/**
 * CDB UI to GTM-ISAM. Leaves the right side of CDB UI and drops onto the oval,
 * mirroring the csgcb rail on the left, so it stays clear of the /api/cdb edge
 * and its label below the box.
 */
function clientIsamPath(all: Record<string, Geom>): string {
  const c = all['client'], g = all['gtm-isam'];
  return `M${c.x + c.width} ${c.y + c.height / 2} H${g.x + g.width / 2} V${g.y}`;
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

/**
 * GTM-ISAM to a site's IdP LTM. Orthogonal, running just below the Akamai lane
 * and outboard of every other column, so it clears the cloudlet and property
 * boxes.
 */
function isamGtmRail(all: Record<string, Geom>, site: SiteId): string {
  const g = all['gtm-isam'], t = all[`idpltm-${site}`];
  const sx = g.x + g.width / 2, tx = t.x + t.width / 2;
  return `M${sx} ${g.y + g.height} V${ISAM_GTM_RAIL_Y} H${tx} V${t.y}`;
}

/**
 * GTM-APIC to a site's APIC FS for apis.bmo.com. Runs just above the APIC FS row and
 * drops in right of centre, so it stays distinct from the cloudlet's /api/cdb
 * curve arriving at the same box.
 */
function spaRail(all: Record<string, Geom>, site: SiteId): string {
  // Leaves GTM-APIC right of centre, clear of its /api/cdb edge to the cloudlet.
  const g = all['gtm-api'], t = all[`apicfs-${site}`];
  const sx = g.x + g.width / 2 + 60, tx = t.x + t.width / 2 + SPA_RAIL_DROP;
  return `M${sx} ${g.y + g.height} V${SPA_RAIL_Y} H${tx} V${t.y}`;
}

/** Every structural edge, drawn dim underneath the taken path. */
function baseEdgePairs(): [string, string][] {
  const pairs: [string, string][] = [
    ['client', 'gtm-bos'], ['client', 'gtm-api'],
    ['gtm-bos', 'cloudlet'], ['gtm-api', 'cloudlet']
  ];
  SITE_IDS.forEach(s => {
    pairs.push(['cloudlet', `apicfs-${s}`]);
    for (let i = 1; i <= IDP_WGA_INSTANCES; i++) {
      pairs.push([`idpltm-${s}`, `idpwga-${s}-${i}`]);
    }
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
function baseLabels(res: Resolution): TfLabel[] {
  const labels: TfLabel[] = [
    { x: RAIL_X.BCC + 6, y: ROW.cloudlet + 30, text: '/banking/services', kind: 'edge' },
    { x: RAIL_X.SCC + 6, y: ROW.cloudlet + 30, text: '/banking/services', kind: 'edge' },
    { x: 1265, y: ROW.gtm + 105, text: '/api/cdb', kind: 'edge' },
    // Sits right of the CWH Web lane title and above the trap alert, in the
    // gap between the property-rule box and the ISAM Legacy LTM row.
    { x: 510, y: CSGCB_RAIL_Y - 6, text: '/banking/services/csgcb', kind: 'edge' },
    // One label per CDB UI edge, each beside its own line.
    { x: 1308, y: 86, text: '/api/cdb · apis.bmo.com/api/*', kind: 'edge' },
    { x: 1420, y: 36, text: 'authentication.bmo.com/aac/*', kind: 'edge' }
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
    // In the gap between the EXT GTM and the BOS LTM.
    labels.push({
      x: SITE_X[s] + 26, y: ROW.extGtm + 154, text: split.own,
      kind: split.own === '100%' ? 'edge' : 'alert'
    });
    // Both crossover labels point inward, and the columns sit closer together
    // than they used to, so they are staggered vertically rather than relying
    // on the gap being wider than the text.
    labels.push({
      x: SITE_X[s] + (s === 'BCC' ? 150 : -210),
      y: ROW.extGtm + (s === 'BCC' ? 154 : 170),
      text: split.cross,
      kind: split.cross.startsWith('0%') ? 'edge' : 'alert'
    });
  });
  return labels;
}

/** Tier heads, which carry a site pill. */
const HEAD_NODE = /^(apicfs|extgtm|ltm|isamltm|idpltm|sssf5|sssapic)-/;

/**
 * Setting switches, drawn on the box they configure with both options visible.
 * Each sits in its box's footer. live.txt appears on both web boxes of a site.
 * Values come from the frame's state, so a live.txt rename made by an outage
 * stage shows up here as the journey plays, locked.
 */
function buildChips(state: SimState, geom: Record<string, Geom>, liveLocked: boolean): TfChip[] {
  const chips: TfChip[] = [];
  const mon = (m: SimState['ltmMonitor']) => (m === 'tcp' ? 'TCP' : 'live.txt');
  // A switch sits in the box's footer; its label is drawn to the left of x.
  const inBox = (g: Geom, width = 120) => ({ x: g.x + g.width / 2 - 14, y: g.y + g.height - 25, width });
  const monitor = { options: ['live.txt', 'TCP'], locked: false };

  // GTM weighting, above the pick pills. GTM-APIC has two pill rows.
  WEIGHT_SWITCHES.forEach(({ gtm, node, pillRows }) => {
    const g = geom[node];
    const w = state.gtmWeight[gtm];
    chips.push({ kind: 'gtmw', gtm, site: 'BCC', label: '', locked: false,
      x: g.x + g.width / 2 - 75, y: g.y + g.height - 40 - (pillRows - 1) * 24 - 26, width: 150,
      options: ['50/50', 'BCC', 'SCC'], value: w === 'split' ? '50/50' : w, changed: w !== 'split' });
  });

  SITE_IDS.forEach(site => {
    chips.push({ kind: 'extgtm', site, ...inBox(geom[`extgtm-${site}`]), ...monitor,
      label: 'monitor', value: mon(state.extGtmMonitor), changed: state.extGtmMonitor !== 'live' });

    chips.push({ kind: 'ltm', site, ...inBox(geom[`ltm-${site}`]), ...monitor,
      label: 'pool monitor', value: mon(state.ltmMonitor), changed: state.ltmMonitor !== 'live' });

    chips.push({ kind: 'idplive', site, ...inBox(geom[`idpltm-${site}`], 130),
      options: ['present', 'renamed'], label: 'mobileidp.gif', value: state.idpLive[site],
      changed: state.idpLive[site] !== 'present', locked: false });

    // live.txt is one setting per site, served by both IHS servers. Each web box
    // shows it, and flipping either flips the site, so the pair always agree.
    // No label: the options name the file.
    for (let i = 1; i <= WEB_SERVERS; i++) {
      const w = geom[`web-${site}-${i}`];
      // Starts right of the site colour strip on the box's left edge.
      chips.push({ kind: 'live', site, ...inBox(w, 104), x: w.x + 11,
        options: ['live.txt', 'dead.txt'], label: '', value: state.live[site] === 'present' ? 'live.txt' : 'dead.txt',
        changed: state.live[site] !== 'present', locked: liveLocked });
    }
  });
  return chips;
}

/** The weighted GTMs, with how many pick rows sit below each switch. */
const WEIGHT_SWITCHES: { gtm: WeightedGtm; node: string; pillRows: number }[] = [
  { gtm: 'bos', node: 'gtm-bos', pillRows: 1 },
  { gtm: 'api', node: 'gtm-api', pillRows: 2 },
  { gtm: 'isam', node: 'gtm-isam', pillRows: 1 }
];

/**
 * When health overrides what a GTM's switch says (a weighted or 50/50 site
 * failing its check), say what it is actually answering, under the oval.
 */
function weightNotes(state: SimState, res: Resolution, geom: Record<string, Geom>): TfLabel[] {
  return WEIGHT_SWITCHES.flatMap(({ gtm, node }) => {
    const w = state.gtmWeight[gtm];
    const said = w === 'split' ? '50/50' : `100% → ${w} (weighted)`;
    const dist = res.gtmDistribution[gtm];
    if (dist === said) { return []; }
    const g = geom[node];
    // Lower right of the oval, clear of the edges leaving its bottom.
    return [{ x: g.x + g.width - 40, y: g.y + g.height - 2, text: `answering ${dist}`, kind: 'alert' as const }];
  });
}

/** Site-pick chips, centred low inside each GTM oval. */
function buildPills(state: SimState, res: Resolution, geom: Record<string, Geom>): TfPill[] {
  const pills: TfPill[] = [];
  // `row` puts a pick on its own line with a caption. GTM-APIC carries two
  // hostnames, so it gets two rows: www1 (cookie-pinned) and apis (never pinned).
  const spec: { gtm: GtmId; node: string; row?: { caption: string; up: number } }[] = [
    { gtm: 'bos', node: 'gtm-bos' },
    { gtm: 'api', node: 'gtm-api', row: { caption: 'www1', up: 24 } },
    { gtm: 'isam', node: 'gtm-isam' },
    { gtm: 'spa', node: 'gtm-api', row: { caption: 'apis', up: 0 } },
    { gtm: 'sss', node: 'gss-es' }
  ];
  const fronts: Record<GtmId, Resolution['path'][]> = {
    bos: ['banking', 'csgcb'], api: ['api'], isam: ['idp'], spa: ['spaapi'], sss: []
  };
  spec.forEach(({ gtm, node, row }) => {
    const g = geom[node];
    if (!g) { return; }
    // Only the GTM fronting the current path takes part in this request.
    // The es-api GSS is in play whenever a downstream call goes through it.
    const inPath = gtm === 'sss'
      ? res.downstream.some(d => d.kind === 'gss')
      : fronts[gtm].includes(res.path);
    const overridden = !res.gtmDistribution[gtm].startsWith('50/50');
    const answered = res.gtmAnswer[gtm];
    SITE_IDS.forEach((site, i) => {
      pills.push({
        gtm, site,
        x: g.x + g.width / 2 - (row ? 38 : 55) + i * 58,
        y: g.y + g.height - 40 - (row?.up ?? 0),
        width: 52, height: 19,
        row: row && i === 0 ? row.caption : undefined,
        // Show what the GTM actually answers, not a pick health has overridden.
        selected: answered ? answered === site : state.gtmPick[gtm] === site,
        active: inPath && res.gtmActive && !overridden
      });
    });
  });
  return pills;
}

const LANES: TfLane[] = [
  { x: 40, y: 100, width: 2420, height: 196, title: 'Akamai' },
  { x: 40, y: 400, width: 2420, height: 625, title: 'CWH Web' },
  { x: 40, y: 1035, width: 2420, height: 120, title: 'CWH app' },
  { x: 40, y: 1170, width: 2420, height: 580, title: 'SSS V2' },
  { x: 40, y: 1765, width: 2420, height: 145, title: 'AWS' }
];

type PathMap = Record<string, { hop: number; state: Severity }>;

function traversal(res: Resolution): PathMap {
  const m: PathMap = {};
  res.steps.forEach((s, i) => s.ids.forEach(id => { m[id] = { hop: i + 1, state: s.state }; }));
  return m;
}

/**
 * Lays out the diagram for one frame, for one cohort.
 *
 * Two paths are drawn: the call this frame is showing, and — faintly — the
 * sign-in that pinned the cookie it followed. Only one cohort at a time;
 * overlaying both made the divergence harder to read, not easier.
 *
 * When a call was skipped because sign-in failed, there is no current path and
 * only the sign-in context renders.
 *
 * `liveLocked` marks the live.txt chips read-only while an outage scenario
 * owns live.txt.
 *
 * Pure: geometry only.
 */
export function buildTrafficGraph(
  frame: JourneyFrame, cohort: Cohort = 'new', liveLocked = false
): TfGraph {
  const state = frame.state;
  const mine = frame.results.find(r => r.cohort === cohort) ?? null;
  const currentRes = mine && !mine.skipped ? mine.resolution : null;
  const contextRes = frame.context[cohort] ?? null;

  // Labels, pills and node geometry key off whichever resolution is real.
  const res = currentRes ?? contextRes;
  if (!res) { throw new Error('buildTrafficGraph: frame has no resolution to render'); }

  const geom = baseNodes(res);
  idpNodes(geom);
  isamNodes(geom);
  siteNodes(geom);
  sssNodes(geom, res);

  const currentPath = currentRes ? traversal(currentRes) : {};
  // The sign-in trace is context only when it is not itself the current call.
  const contextPath = contextRes && contextRes !== currentRes ? traversal(contextRes) : {};

  const tagAt = (id: string): FlowTag | null =>
    currentPath[id] ? 'current' : contextPath[id] ? 'context' : null;

  /** Hop badges belong to the current call only — context is not a sequence. */
  const hitFor = (id: string) => currentPath[id] ?? null;

  const edges: TfEdge[] = baseEdgePairs()
    .filter(([a, b]) => geom[a] && geom[b])
    .map(([a, b]) => ({
      d: curve(geom[a], geom[b]), kind: 'base' as const, flow: null
    }));
  const baseRail = (d: string): TfEdge => ({ d, kind: 'base', flow: null });
  edges.push(baseRail(clientPropPath(geom)), baseRail(clientIsamPath(geom)));
  sssBaseLegs().forEach(({ a, b, kind }) => {
    const d = sssLeg(geom, a, b);
    if (d) { edges.push({ d, kind, flow: null }); }
  });
  SITE_IDS.forEach(s => edges.push(
    baseRail(railPath(geom, s)), baseRail(csgcbPath(geom, s)), baseRail(wgaRail(geom, s)),
    baseRail(isamGtmRail(geom, s)), baseRail(spaRail(geom, s))
  ));

  // Taken edges, deduped by geometry. The context pass runs first so that any
  // hop shared with the current call is overwritten by it — the live path wins.
  const taken = new Map<string, { d: string; kind: TfEdge['kind']; flow: FlowTag }>();
  const walk = (rs: Resolution | null, flow: FlowTag) => {
    if (!rs) { return; }
    const entrySite = rs.apicSite ?? rs.bosSite;
    for (let i = 0; i < rs.steps.length - 1; i++) {
      const next = rs.steps[i + 1];
      rs.steps[i].ids.forEach(a => next.ids.forEach(b => {
        if (!geom[a] || !geom[b]) { return; }
        const leavesEntry = (a.startsWith('extgtm') || a.startsWith('gtm-') || a === 'cloudlet') &&
          b.includes('-') && !!entrySite && !b.includes(`-${entrySite}`);
        const kind: TfEdge['kind'] = flow === 'context' ? 'base'
          : next.state === 'bad' ? 'broken'
            : leavesEntry ? 'crossover' : 'taken';
        // Several hops are drawn as rails rather than beziers, so the taken path
        // has to reuse the same geometry or it would peel away from the dim
        // edge underneath it.
        const d = a === 'cloudlet' && b.startsWith('ltm-') && rs.bosSite
          ? railPath(geom, rs.bosSite)
          : a === 'client' && b === 'akamai-prop'
            ? clientPropPath(geom)
            : a === 'client' && b === 'gtm-isam'
              ? clientIsamPath(geom)
              : a === 'akamai-prop' && b.startsWith('isamltm-')
                ? csgcbPath(geom, b.slice('isamltm-'.length) as SiteId)
                : a.startsWith('wga-') && b.startsWith('ltm-')
                  ? wgaRail(geom, b.slice('ltm-'.length) as SiteId)
                  : a === 'gtm-isam' && b.startsWith('idpltm-')
                    ? isamGtmRail(geom, b.slice('idpltm-'.length) as SiteId)
                    : a === 'gtm-api' && b.startsWith('apicfs-')
                      ? spaRail(geom, b.slice('apicfs-'.length) as SiteId)
                      : curve(geom[a], geom[b]);
        taken.set(d, { d, kind, flow });
      }));
    }
  };
  walk(contextRes && contextRes !== currentRes ? contextRes : null, 'context');
  walk(currentRes, 'current');

  // Downstream fan-out. Every route is lit at once; a hop shared by several
  // routes takes the worst of their states, so a break is never hidden behind
  // a healthy route drawn over it.
  const rank: Record<TfEdge['kind'], number> = {
    base: 0, failover: 0, taken: 1, crossover: 2, broken: 3
  };
  const sevRank: Record<Severity, number> = { ok: 0, warn: 1, bad: 2 };
  const fan: Record<string, Severity> = {};
  const breaks = new Set<string>();
  const mark = (id: string, sev: Severity) => {
    const n = id.replace(/#.*$/, '');
    if (!geom[n]) { return; }
    if (!fan[n] || sevRank[sev] > sevRank[fan[n]]) { fan[n] = sev; }
  };
  (currentRes?.downstream ?? []).forEach(r => {
    if (r.breakAt) { breaks.add(r.breakAt); }
    r.legs.forEach(([a, b]) => {
      const d = sssLeg(geom, a, b);
      if (!d) { return; }
      const into = b.replace(/#.*$/, '');
      const isBreak = into === r.breakAt;
      const isFailover = r.status === 'failover' && a.startsWith('gss-');
      const kind: TfEdge['kind'] = isBreak ? 'broken' : isFailover ? 'crossover' : 'taken';
      const prev = taken.get(d);
      if (!prev || rank[kind] > rank[prev.kind]) { taken.set(d, { d, kind, flow: 'current' }); }
      mark(a, 'ok');
      mark(b, isBreak ? 'bad' : isFailover ? 'warn' : 'ok');
    });
  });

  taken.forEach(e => {
    edges.push({ d: e.d, kind: e.kind, flow: e.flow });
  });

  const nodes: TfNode[] = Object.keys(geom).map(id => {
    const g = geom[id];
    const hit = hitFor(id);
    const off = !!state.down[id];
    const tag = off ? null : tagAt(id);
    const site = (id.match(/-(BCC|SCC)(?:-|$)/)?.[1] as SiteId | undefined) ?? null;
    const head = !!site && HEAD_NODE.test(id);
    return {
      id,
      x: g.x, y: g.y, width: g.width, height: g.height,
      // The pill names the site, so the title does not repeat it.
      lines: head
        ? g.lines.map((l: { text: string; bold: boolean }) => ({ ...l, text: l.text.replace(` (${site})`, '') }))
        : g.lines,
      outline: !!g.outline,
      ellipse: !!g.ellipse,
      radius: g.radius ?? 3,
      footer: g.footer ?? 0,
      warn: !!g.warn && !off,
      toggleable: TOGGLEABLE_NODE.test(id),
      hop: hit && !off ? hit.hop : null,
      state: off ? null : hit ? hit.state : fan[id] ?? null,
      outOfService: off,
      isBreak: currentRes?.breakAt === id || breaks.has(id),
      flow: tag ?? (fan[id] && !off ? 'current' : null),
      site,
      head,
      fanout: !!fan[id] && !off
    };
  });

  return {
    nodes,
    edges,
    labels: [...baseLabels(res), ...sssLabels(), ...weightNotes(state, res, geom)],
    lanes: LANES,
    pills: buildPills(state, res, geom),
    chips: buildChips(state, geom, liveLocked),
    width: CANVAS.width,
    height: CANVAS.height
  };
}
