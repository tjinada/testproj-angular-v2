/**
 * CDB QA traffic flow — the shape of the estate, shared by every QA environment.
 *
 * Nothing here is environment-specific: hostnames, env-specific path labels and
 * per-env endpoint overrides live in qa-environments.ts. Positions are fixed
 * (curated topology, transcribed from the CDB Post-CIAM traffic flow diagram),
 * not auto-laid-out like the span-driven flow diagram.
 */

export type QaCategory = 'client' | 'edge' | 'gateway' | 'identity' | 'onprem' | 'service' | 'aws';

export interface QaCategoryStyle {
  label: string;
  fill: string;
  stroke: string;
  /** Title colour on the fill. */
  ink: string;
}

export const QA_CATEGORIES: Record<QaCategory, QaCategoryStyle> = {
  client:   { label: 'Client',            fill: '#E6F1FB', stroke: '#185FA5', ink: '#0C447C' },
  edge:     { label: 'Akamai',            fill: '#E1F5EE', stroke: '#0F6E56', ink: '#085041' },
  gateway:  { label: 'API gateway',       fill: '#FAEEDA', stroke: '#BA7517', ink: '#633806' },
  identity: { label: 'Identity / auth',   fill: '#FBEAF0', stroke: '#993556', ink: '#72243E' },
  onprem:   { label: 'On-prem web / app', fill: '#EEF1F5', stroke: '#4A5A70', ink: '#2B3647' },
  service:  { label: 'Backend services',  fill: '#EAF3DE', stroke: '#3B6D11', ink: '#27500A' },
  aws:      { label: 'AWS / DigitalCore', fill: '#EEEDFE', stroke: '#534AB7', ink: '#3C3489' }
};

export interface QaNode {
  id: string;
  label: string;
  category: QaCategory;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Containing group id, if any. */
  group?: string;
  /** New or changed for CIAM. */
  isNew?: boolean;
  /** Legacy path — drawn dashed. */
  legacy?: boolean;
  /** Short role line under the hostname. */
  sub?: string;
  /** Where the box is hosted, shown as a pill, e.g. 'NetStorage'. */
  badge?: string;
}

/** Hosting zone: a coloured outline around the boxes that live in it. */
export interface QaZone {
  label: string;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface QaGroup {
  id: string;
  label: string;
  category: QaCategory;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface QaEdge {
  from: string;
  to: string;
  /** Orthogonal polyline in canvas coordinates. */
  points: [number, number][];
  /** Default path label; an environment may override it (see edgeId). */
  label?: string;
  /** Sign-in step numbers carried on this hop, e.g. '8' or '1 3 4 5 7'. */
  steps?: string;
  /** Centre of the label pill(s). Required when label or steps is set. */
  labelAt?: [number, number];
  dashed?: boolean;
}

export interface QaEndpoint {
  method: string;
  path: string;
  notes?: string;
}

export interface QaEndpointGroup {
  title: string;
  endpoints: QaEndpoint[];
  /** QA_ROUTES id these calls travel, from a '@route-id' tag on the heading. */
  route?: string;
}

/** One step of a route: a node id, or parallel nodes such as both web servers. */
export type QaStage = string | string[];

/**
 * A real request path through the estate, SPA first. Clicking a box lights every
 * route through it; tracing an endpoint lights its whole route.
 */
export interface QaRoute {
  id: string;
  label: string;
  stages: QaStage[];
}

/** Key used by environment overrides for an edge. */
export function edgeId(e: Pick<QaEdge, 'from' | 'to'>): string {
  return `${e.from}>${e.to}`;
}

export function stageIds(stage: QaStage): string[] {
  return Array.isArray(stage) ? stage : [stage];
}

/** Bounding box of the drawing, used by Fit. */
export const QA_CANVAS = { x: 10, y: 70, width: 2790, height: 770 };

/** Drawn under the groups. Midtier sits outside every zone. */
export const QA_ZONES: QaZone[] = [
  { label: 'CWH Web', color: '#1E3A8A', x: 700,  y: 88,  width: 825, height: 740 },
  { label: 'CWH App', color: '#0F766E', x: 1545, y: 250, width: 250, height: 210 },
  { label: 'SSS V2',  color: '#B45309', x: 1830, y: 200, width: 300, height: 510 },
  { label: 'AWS',     color: '#534AB7', x: 2185, y: 100, width: 590, height: 510 }
];

/** Drawn in order, so outer groups come before the groups inside them. */
export const QA_GROUPS: QaGroup[] = [
  { id: 'akamai',   label: 'Akamai',       category: 'edge',    x: 320,  y: 140, width: 300, height: 470 },
  { id: 'cdb',      label: 'CDB web tier', category: 'onprem',  x: 1020, y: 236, width: 495, height: 276 },
  { id: 'sss',      label: 'SSS V2 APIC',  category: 'gateway', x: 1840, y: 236, width: 260, height: 300 },
  { id: 'channels', label: 'Channels AWS', category: 'aws',     x: 2195, y: 140, width: 570, height: 170 },
  { id: 'digital',  label: 'DigitalCore',  category: 'aws',     x: 2195, y: 380, width: 570, height: 200 }
];

export const QA_NODES: QaNode[] = [
  { id: 'spa',   label: 'CDB SPA',              category: 'client',   x: 40,   y: 360, width: 190, height: 92 },
  { id: 'gss',   label: 'CDB Akamai ruleset',   category: 'edge',     x: 350,  y: 190, width: 240, height: 84, group: 'akamai' },
  { id: 'mfe',   label: 'CIAM MFE rules',       category: 'edge',     x: 350,  y: 340, width: 240, height: 84, group: 'akamai', isNew: true },
  { id: 'ns',    label: 'CIAM Auth SPA',        category: 'edge',     x: 350,  y: 490, width: 240, height: 84, group: 'akamai', isNew: true,
    badge: 'NetStorage', sub: 'login · register · reset · recover' },
  { id: 'idp',   label: 'CIAM Identity Server', category: 'identity', x: 720,  y: 700, width: 220, height: 92, isNew: true, sub: 'OAuth2 / OIDC' },
  { id: 'wem',   label: 'WEM',                  category: 'onprem',   x: 1040, y: 600, width: 270, height: 78, sub: 'hosts CDB SPA' },
  { id: 'apic',  label: 'CWH APIC',             category: 'gateway',  x: 720,  y: 120, width: 240, height: 92, isNew: true },
  { id: 'isam',  label: 'Legacy ISAM',          category: 'identity', x: 720,  y: 520, width: 210, height: 84, legacy: true },
  { id: 'f5',    label: 'F5 LTM',               category: 'onprem',   x: 1040, y: 330, width: 190, height: 84, group: 'cdb' },
  { id: 'web1',  label: 'CDB web server 1',     category: 'onprem',   x: 1300, y: 262, width: 200, height: 78, group: 'cdb', sub: 'IHS' },
  { id: 'web2',  label: 'CDB web server 2',     category: 'onprem',   x: 1300, y: 410, width: 200, height: 78, group: 'cdb', sub: 'IHS' },
  { id: 'bos',   label: 'CDBBOS ×2',            category: 'onprem',   x: 1570, y: 320, width: 200, height: 110, sub: 'WAS' },
  { id: 'mid',   label: 'Midtier',              category: 'service',  x: 1570, y: 600, width: 200, height: 84 },
  // SSS V2 APIC path lanes: sss1 = /api/cdb (top, fed by CWH and CDBBOS), sss2 = /api
  { id: 'sss1',  label: 'SSS V2 · /api/cdb',    category: 'gateway',  x: 1860, y: 270, width: 220, height: 84, group: 'sss', sub: '/api/cdb/<bian>/' },
  { id: 'sss2',  label: 'SSS V2 · /api',        category: 'gateway',  x: 1860, y: 430, width: 220, height: 84, group: 'sss', sub: '/api/<bian>/' },
  { id: 'chan',  label: 'Channel Services',     category: 'service',  x: 1860, y: 600, width: 220, height: 84, sub: 'OpenShift' },
  { id: 'awsgw', label: 'AWS API Gateway',      category: 'aws',      x: 2215, y: 180, width: 240, height: 92, group: 'channels', isNew: true },
  { id: 'awsl',  label: 'AWS Lambdas',          category: 'aws',      x: 2505, y: 180, width: 240, height: 92, group: 'channels', isNew: true },
  { id: 'dcgw',  label: 'DC AWS API Gateway',   category: 'aws',      x: 2215, y: 440, width: 240, height: 84, group: 'digital' },
  { id: 'dcl',   label: 'DC AWS Lambdas',       category: 'aws',      x: 2505, y: 440, width: 240, height: 84, group: 'digital' }
];

export const QA_EDGES: QaEdge[] = [
  // Client -> Akamai
  { from: 'spa', to: 'gss', points: [[135, 360], [135, 232], [348, 232]],
    label: '/api/cdb/* · /banking/services/*', steps: '8', labelAt: [135, 296] },
  // No label: the CIAM MFE rules box already shows the host, and the hop is too short for a pill.
  { from: 'spa', to: 'mfe', points: [[230, 382], [348, 382]] },
  // Akamai internal / out
  { from: 'mfe', to: 'ns', points: [[470, 424], [470, 488]],
    label: '/login|enrollment|forgot*/cdb/*', labelAt: [470, 456] },
  { from: 'mfe', to: 'idp', points: [[350, 410], [335, 410], [335, 746], [718, 746]],
    label: '/isvaop/oauth2/* · /aac/sps/apiauthsvc/*', labelAt: [335, 660] },
  { from: 'gss', to: 'wem', points: [[590, 262], [665, 262], [665, 640], [1038, 640]],
    label: '/banking/digital/*', labelAt: [866, 640] },
  { from: 'gss', to: 'apic', points: [[590, 215], [655, 215], [655, 166], [718, 166]],
    label: '/api{n}/cdb/*', steps: '8', labelAt: [655, 190] },
  { from: 'gss', to: 'isam', points: [[590, 250], [675, 250], [675, 562], [718, 562]],
    label: '/banking/services/csgcb/session/initISAMSession', labelAt: [675, 470], dashed: true },
  // Gateways -> CDB
  { from: 'apic', to: 'f5', points: [[900, 212], [900, 372], [1038, 372]],
    label: '/banking/services/*', steps: '8', labelAt: [900, 300] },
  { from: 'isam', to: 'f5', points: [[930, 562], [985, 562], [985, 400], [1038, 400]], dashed: true },
  { from: 'f5', to: 'web1', points: [[1230, 360], [1265, 360], [1265, 301], [1298, 301]] },
  { from: 'f5', to: 'web2', points: [[1230, 385], [1265, 385], [1265, 449], [1298, 449]] },
  { from: 'web1', to: 'bos', points: [[1500, 301], [1535, 301], [1535, 355], [1568, 355]] },
  { from: 'web2', to: 'bos', points: [[1500, 449], [1535, 449], [1535, 395], [1568, 395]] },
  // CWH APIC -> SSS /api/cdb (path unchanged) -> Channels AWS
  { from: 'apic', to: 'sss1', points: [[960, 166], [1960, 166], [1960, 268]], label: '/api/cdb/*', labelAt: [1460, 166] },
  { from: 'sss1', to: 'awsgw', points: [[2080, 290], [2150, 290], [2150, 226], [2213, 226]] },
  // CDBBOS -> downstream
  { from: 'bos', to: 'sss1', points: [[1770, 335], [1858, 335]], label: '/api/cdb/*', labelAt: [1812, 335] },
  { from: 'bos', to: 'sss2', points: [[1770, 405], [1820, 405], [1820, 472], [1858, 472]],
    label: '/api/*', labelAt: [1820, 440] },
  { from: 'bos', to: 'mid', points: [[1670, 430], [1670, 598]] },
  { from: 'sss1', to: 'chan', points: [[2080, 330], [2110, 330], [2110, 642], [2082, 642]],
    label: '/api/cdb/*', labelAt: [2110, 557] },
  { from: 'chan', to: 'sss2', points: [[1970, 598], [1970, 516]], label: '/api/*', labelAt: [1970, 557] },
  // SSS /api -> DigitalCore
  { from: 'sss2', to: 'dcgw', points: [[2080, 482], [2213, 482]], label: '/api/*', labelAt: [2158, 482] },
  { from: 'awsgw', to: 'awsl', points: [[2455, 226], [2503, 226]] },
  { from: 'awsl', to: 'dcgw', points: [[2625, 272], [2625, 345], [2335, 345], [2335, 438]] },
  { from: 'dcgw', to: 'dcl', points: [[2455, 482], [2503, 482]] }
];

const TO_CDBBOS: QaStage[] = ['spa', 'gss', 'apic', 'f5', ['web1', 'web2'], 'bos'];

const TO_CHANNELS_AWS: QaStage[] = ['spa', 'gss', 'apic', 'sss1', 'awsgw', 'awsl'];

/**
 * Listed explicitly because the shared SSS lanes make plain graph reachability
 * over-highlight (e.g. CDBBOS would light up for Channels AWS). A route ends at
 * the box that serves its calls; the "-dc" routes carry on to DigitalCore so
 * clicking DigitalCore still shows everything that reaches it.
 */
export const QA_ROUTES: QaRoute[] = [
  { id: 'signin-mfe',         label: 'Sign-in · MFE bundle',                     stages: ['spa', 'mfe', 'ns'] },
  { id: 'signin-idp',         label: 'Sign-in · CIAM IdP',                       stages: ['spa', 'mfe', 'idp'] },
  { id: 'spa-wem',            label: 'CDB Akamai ruleset → WEM (CDB SPA)',       stages: ['spa', 'gss', 'wem'] },
  { id: 'legacy-isam',        label: 'Legacy ISAM → CDBBOS',                     stages: ['spa', 'gss', 'isam', 'f5', ['web1', 'web2'], 'bos'] },
  { id: 'cwh-cdbbos',         label: 'CWH → CDBBOS',                             stages: TO_CDBBOS },
  { id: 'cwh-channels-aws',   label: 'CWH → SSS /api/cdb → Channels AWS',        stages: TO_CHANNELS_AWS },
  { id: 'cwh-channel-services', label: 'CWH → SSS /api/cdb → Channel Services',  stages: ['spa', 'gss', 'apic', 'sss1', 'chan'] },
  { id: 'channels-aws-dc',    label: 'Channels AWS → DigitalCore',               stages: [...TO_CHANNELS_AWS, 'dcgw', 'dcl'] },
  { id: 'cdbbos-midtier',     label: 'CDBBOS → Midtier',                         stages: [...TO_CDBBOS, 'mid'] },
  { id: 'cdbbos-digitalcore', label: 'CDBBOS → SSS /api → DigitalCore',          stages: [...TO_CDBBOS, 'sss2', 'dcgw', 'dcl'] },
  { id: 'cdbbos-channels',    label: 'CDBBOS → SSS /api/cdb → Channel Services', stages: [...TO_CDBBOS, 'sss1', 'chan'] },
  { id: 'cdbbos-channels-aws', label: 'CDBBOS → SSS /api/cdb → Channels AWS',    stages: [...TO_CDBBOS, 'sss1', 'awsgw', 'awsl'] },
  { id: 'cdbbos-channels-dc', label: 'Channel Services → DigitalCore',           stages: [...TO_CDBBOS, 'sss1', 'chan', 'sss2', 'dcgw', 'dcl'] }
];

// Catch route typos early: every consecutive pair of stages must be a drawn edge.
const DRAWN = new Set(QA_EDGES.map(edgeId));
for (const r of QA_ROUTES) {
  r.stages.slice(1).forEach((stage, i) => {
    for (const from of stageIds(r.stages[i])) {
      for (const to of stageIds(stage)) {
        if (!DRAWN.has(edgeId({ from, to }))) console.warn(`[qa-topology] route ${r.id}: no edge ${from}>${to}`);
      }
    }
  });
}
