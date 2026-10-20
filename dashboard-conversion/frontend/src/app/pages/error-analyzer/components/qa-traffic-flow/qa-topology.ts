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
}

/** Key used by environment overrides for an edge. */
export function edgeId(e: Pick<QaEdge, 'from' | 'to'>): string {
  return `${e.from}>${e.to}`;
}

/** Bounding box of the drawing, used by Fit. */
export const QA_CANVAS = { x: 20, y: 70, width: 3160, height: 770 };

export const QA_GROUPS: QaGroup[] = [
  { id: 'akamai',  label: 'Akamai',            category: 'edge',   x: 320,  y: 140, width: 300, height: 470 },
  { id: 'cdb',     label: 'CDB',               category: 'onprem', x: 1010, y: 236, width: 790, height: 276 },
  { id: 'cwh',     label: 'AWS (CWH)',         category: 'aws',    x: 1540, y: 86,  width: 650, height: 144 },
  { id: 'digital', label: 'DigitalCore (AWS)', category: 'aws',    x: 2640, y: 296, width: 520, height: 156 }
];

export const QA_NODES: QaNode[] = [
  { id: 'spa',   label: 'CDB SPA',              category: 'client',   x: 40,   y: 360, width: 190, height: 92 },
  { id: 'gss',   label: 'GSS rules',            category: 'edge',     x: 350,  y: 190, width: 240, height: 84, group: 'akamai' },
  { id: 'mfe',   label: 'CIAM MFE rules',       category: 'edge',     x: 350,  y: 340, width: 240, height: 84, group: 'akamai', isNew: true },
  { id: 'ns',    label: 'NetStorage',           category: 'edge',     x: 350,  y: 490, width: 240, height: 84, group: 'akamai', isNew: true, sub: 'Authenticator MFE' },
  { id: 'idp',   label: 'CIAM Identity Server', category: 'identity', x: 370,  y: 720, width: 220, height: 92, isNew: true, sub: 'OAuth2 / OIDC' },
  { id: 'apic',  label: 'CWH APIC',             category: 'gateway',  x: 720,  y: 120, width: 240, height: 92, isNew: true, sub: 'rewrites to /banking/services' },
  { id: 'isam',  label: 'Legacy ISAM',          category: 'identity', x: 720,  y: 520, width: 210, height: 84, legacy: true },
  { id: 'f5',    label: 'F5 LTM',               category: 'onprem',   x: 1040, y: 330, width: 190, height: 84, group: 'cdb' },
  { id: 'web1',  label: 'CDB web server 1',     category: 'onprem',   x: 1300, y: 262, width: 200, height: 78, group: 'cdb', sub: 'IHS' },
  { id: 'web2',  label: 'CDB web server 2',     category: 'onprem',   x: 1300, y: 410, width: 200, height: 78, group: 'cdb', sub: 'IHS' },
  { id: 'bos',   label: 'CDBBOS ×2',            category: 'onprem',   x: 1570, y: 320, width: 200, height: 110, group: 'cdb', sub: 'WAS' },
  { id: 'sss1',  label: 'SSS V2 APIC',          category: 'gateway',  x: 1830, y: 333, width: 210, height: 84, sub: '/api/cdb/<bian>/' },
  { id: 'mid',   label: 'Midtier',              category: 'service',  x: 1830, y: 560, width: 210, height: 84 },
  { id: 'chan',  label: 'Channel Services',     category: 'service',  x: 2110, y: 333, width: 210, height: 84, sub: 'OpenShift' },
  { id: 'sss2',  label: 'SSS V2 APIC',          category: 'gateway',  x: 2390, y: 333, width: 210, height: 84, sub: '/api/<bian>/' },
  { id: 'dcgw',  label: 'DC AWS API Gateway',   category: 'aws',      x: 2670, y: 333, width: 210, height: 84, group: 'digital' },
  { id: 'dcl',   label: 'DC AWS Lambdas',       category: 'aws',      x: 2930, y: 333, width: 200, height: 84, group: 'digital' },
  { id: 'awsgw', label: 'AWS API Gateway',      category: 'aws',      x: 1570, y: 120, width: 240, height: 90, group: 'cwh', isNew: true },
  { id: 'awsl',  label: 'AWS Lambdas',          category: 'aws',      x: 1920, y: 120, width: 240, height: 90, group: 'cwh', isNew: true }
];

export const QA_EDGES: QaEdge[] = [
  // Client -> Akamai
  { from: 'spa', to: 'gss', points: [[135, 360], [135, 232], [348, 232]],
    label: '/api/cdb/* · /banking/services/*', steps: '8', labelAt: [242, 232] },
  { from: 'spa', to: 'mfe', points: [[230, 382], [348, 382]], label: 'CIAM host', labelAt: [289, 382] },
  // Akamai internal / out
  { from: 'mfe', to: 'ns', points: [[470, 424], [470, 488]],
    label: 'GET /login/cdb/ciam_mfe.js', steps: '2', labelAt: [470, 456] },
  { from: 'mfe', to: 'idp', points: [[350, 410], [335, 410], [335, 766], [368, 766]],
    label: '/isvaop/oauth2/* · /aac/sps/apiauthsvc/*', steps: '1 3 4 5 7', labelAt: [335, 660] },
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
  // CDBBOS -> downstream
  { from: 'bos', to: 'sss1', points: [[1770, 375], [1828, 375]], label: '/api/cdb/*', labelAt: [1799, 375] },
  { from: 'bos', to: 'mid', points: [[1710, 430], [1710, 602], [1828, 602]] },
  { from: 'bos', to: 'sss2', points: [[1710, 320], [1710, 262], [2495, 262], [2495, 331]],
    label: '/api/*', labelAt: [2100, 262] },
  { from: 'sss1', to: 'chan', points: [[2040, 375], [2108, 375]], label: '/api/cdb/*', labelAt: [2074, 375] },
  { from: 'chan', to: 'sss2', points: [[2320, 375], [2388, 375]], label: '/api/*', labelAt: [2354, 375] },
  { from: 'sss2', to: 'dcgw', points: [[2600, 375], [2668, 375]], label: '/api/*', labelAt: [2634, 375] },
  { from: 'dcgw', to: 'dcl', points: [[2880, 375], [2928, 375]] },
  // CWH AWS branch
  { from: 'apic', to: 'awsgw', points: [[960, 166], [1568, 166]] },
  { from: 'awsgw', to: 'awsl', points: [[1810, 166], [1918, 166]] },
  { from: 'awsl', to: 'dcgw', points: [[2160, 166], [2775, 166], [2775, 331]] }
];
