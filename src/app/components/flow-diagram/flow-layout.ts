import { SpanRecord } from '../../models/trace.model';
import { isSpanFailed } from '../../services/trace-analyzer';

/** A node in the flow diagram (real service or synthetic external system) */
export interface FlowNode {
  id: string;              // unique node id
  label: string;           // display label (short name)
  hostname: string;        // hostname line (may be empty)
  sublabel: string;        // third line (e.g. "N spans" or "external")
  x: number;
  y: number;
  width: number;
  height: number;
  isFailed: boolean;
  isRootCause: boolean;    // true for the node identified as the root cause
  isExternal: boolean;     // true for synthetic upstream/downstream nodes
  isDb: boolean;           // true for synthetic database nodes (subset of external)
  isLambda: boolean;       // true if otel.scope.name is dt.agent.nodejs.Lambda
  isWebSphere: boolean;    // true if websphere.server.name is present
  websphereServer: string; // websphere.server.name value (empty if not WAS)
  spanCount: number;
  endpoints: string[];
  spans: SpanRecord[];     // spans grouped into this node (empty for synthetic)
  fullHostname: string;    // full hostname for details panel
}

/** An edge between two nodes */
export interface FlowEdge {
  id: string;
  sourceId: string;
  targetId: string;
  isFailed: boolean;
  callCount: number;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
  width: number;
  height: number;
}

// Layout constants
const NODE_WIDTH = 210;
const NODE_HEIGHT = 92;
const H_GAP = 120;
const V_GAP = 32;
const PAD = 40;

/** Extract the service name for a span. */
function getServiceName(span: SpanRecord): string {
  return (
    span['dt.entity.service.entity.name'] ||
    span['dt.service.name'] ||
    (span['dt.entity.service'] as string) ||
    'Unknown'
  );
}

/** First DNS segment of a hostname (cgsg-sit.company.net -> cgsg-sit). */
function firstSegment(host: string): string {
  if (!host) return '';
  const noPort = host.split(':')[0];
  const firstDot = noPort.indexOf('.');
  return firstDot === -1 ? noPort : noPort.substring(0, firstDot);
}

/** Returns true if a span represents a database call (db.namespace is set). */
function isDbSpan(span: SpanRecord): boolean {
  return !!(span['db.namespace'] as string | undefined);
}

// isSpanFailed is imported from trace-analyzer to keep a single source of
// truth. Previously this file had its own copy with bugs (verdict !== 'OK'
// instead of === 'failure', plus trusting span.status_code and exception
// events) which lit up the diagram red on traces that succeeded.

/**
 * Build a service-level flow graph from raw spans.
 * - Real nodes: one per unique service name
 * - Downstream synthetic nodes: from server.address on client spans
 * - Upstream synthetic nodes: from process_group name on root/server spans
 *   when it differs from the span's own service
 *
 * If rootCauseService is supplied, the matching real node will be flagged
 * with isRootCause: true so the view can highlight it distinctly.
 */
export function buildFlowGraph(
  spans: SpanRecord[],
  rootCauseService: string | null = null
): FlowGraph {
  if (!spans || spans.length === 0) {
    return { nodes: [], edges: [], width: 0, height: 0 };
  }

  const spanById = new Map<string, SpanRecord>();
  for (const s of spans) spanById.set(s['span.id'], s);

  // --- Build REAL service nodes (grouped by service name) ---
  const realGroups = new Map<string, SpanRecord[]>();
  for (const s of spans) {
    const name = getServiceName(s);
    const list = realGroups.get(name);
    if (list) list.push(s);
    else realGroups.set(name, [s]);
  }

  const nodes: FlowNode[] = [];
  const nodeById = new Map<string, FlowNode>();

  for (const [name, grp] of realGroups.entries()) {
    // Build meaningful endpoint labels from server-kind spans.
    // If endpoint.name is generic (invoke, POST, GET, etc.), prefer
    // server.address + url.path which is more descriptive.
    const GENERIC_ENDPOINTS = new Set(['invoke', 'POST', 'GET', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
    const endpoints = Array.from(
      new Set(
        grp
          .filter(s => s['span.kind'] === 'server')
          .map(s => {
            const epName = s['endpoint.name'] || s['span.name'] || '';
            if (!epName || GENERIC_ENDPOINTS.has(epName)) {
              // Fall back to server.address + url.path
              const addr = (s['server.address'] as string) || '';
              const path = (s['url.path'] as string) || '';
              if (addr && path) return `${addr}${path}`;
              if (path) return path;
              if (addr) return addr;
            }
            return epName;
          })
          .filter(Boolean) as string[]
      )
    );
    // Pick a host name from any span in the group.
    // Priority: websphere.server.name > k8s.container.name > host.name > dt.entity.host.entity.name
    const k8sContainer = (grp.find(s => s['k8s.container.name'])?.[
      'k8s.container.name'
    ] as string) || '';
    const internalHost = (grp.find(s => s['host.name'])?.[
      'host.name'
    ] as string) || '';
    const entityHost = (grp.find(s => s['dt.entity.host.entity.name'])?.[
      'dt.entity.host.entity.name'
    ] as string) || '';

    // WebSphere detection: if any span has websphere.server.name
    const wasServerName = (grp.find(s => s['websphere.server.name'])?.[
      'websphere.server.name'
    ] as string) || '';
    const isWebSphere = !!wasServerName;

    // Lambda detection: otel.scope.name === 'dt.agent.nodejs.Lambda'
    const isLambda = grp.some(
      s => (s['otel.scope.name'] as string) === 'dt.agent.nodejs.Lambda'
    );

    // Determine the hostname to display on the node box.
    // WebSphere server name takes top priority when present.
    let hostFull: string;
    if (isWebSphere) {
      hostFull = wasServerName;
    } else if (k8sContainer) {
      hostFull = k8sContainer;
    } else if (internalHost) {
      hostFull = internalHost;
    } else {
      hostFull = entityHost;
    }

    // Sublabel override for Lambda nodes
    const sublabel = isLambda
      ? `lambda \u00b7 ${grp.length} span${grp.length === 1 ? '' : 's'}`
      : `${grp.length} span${grp.length === 1 ? '' : 's'}`;

    const node: FlowNode = {
      id: name,
      label: name,
      hostname: firstSegment(hostFull) || hostFull,
      sublabel,
      x: 0,
      y: 0,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      isFailed: grp.some(isSpanFailed),
      isRootCause: rootCauseService !== null && name === rootCauseService,
      isExternal: false,
      isDb: false,
      isLambda,
      isWebSphere,
      websphereServer: wasServerName,
      spanCount: grp.length,
      endpoints,
      spans: grp,
      fullHostname: hostFull
    };
    nodes.push(node);
    nodeById.set(name, node);
  }

  // --- Build edges between real services ---
  const edgeMap = new Map<string, FlowEdge>();
  const addEdge = (sourceId: string, targetId: string, failed: boolean) => {
    if (sourceId === targetId) return;
    const key = `${sourceId}->${targetId}`;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.callCount += 1;
      if (failed) existing.isFailed = true;
    } else {
      edgeMap.set(key, {
        id: key,
        sourceId,
        targetId,
        isFailed: failed,
        callCount: 1
      });
    }
  };

  for (const s of spans) {
    const parentId = s['span.parent_id'];
    if (!parentId) continue;
    const parent = spanById.get(parentId);
    if (!parent) continue;
    const childService = getServiceName(s);
    const parentService = getServiceName(parent);
    addEdge(parentService, childService, isSpanFailed(s));
  }

  // --- Build DB synthetic nodes from client spans with db.namespace ---
  // Must run BEFORE the HTTP external pass so we don't double-create a node
  // for the same DB span (once as a DB node, once as an HTTP external by
  // server.address).
  for (const s of spans) {
    if (s['span.kind'] !== 'client') continue;
    if (!isDbSpan(s)) continue;

    const dbNamespace = String(s['db.namespace']);
    const dbHost = (s['server.address'] as string) || '';
    const nodeId = `db:${dbNamespace}`;

    let node = nodeById.get(nodeId);
    if (!node) {
      node = {
        id: nodeId,
        label: dbNamespace,
        hostname: dbHost,
        sublabel: 'database',
        x: 0,
        y: 0,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        isFailed: false,
        isRootCause: false,
        isExternal: true,
        isDb: true,
        isLambda: false,
        isWebSphere: false,
        websphereServer: '',
        spanCount: 0,
        endpoints: [],
        spans: [],
        fullHostname: dbHost
      };
      nodes.push(node);
      nodeById.set(nodeId, node);
    }

    const callerService = getServiceName(s);
    addEdge(callerService, nodeId, isSpanFailed(s));
  }

  // --- Build DOWNSTREAM synthetic nodes from client-kind spans ---
  const downstreamNodeIds = new Set<string>();
  for (const s of spans) {
    if (s['span.kind'] !== 'client') continue;
    if (isDbSpan(s)) continue; // already handled by the DB pass above
    const host = (s['server.address'] as string) || '';
    if (!host) continue;

    // If this client call already has an in-trace child span, the callee is
    // already represented as a real node — skip to avoid duplication.
    const hasInstrumentedChild = spans.some(
      other => other['span.parent_id'] === s['span.id']
    );
    if (hasInstrumentedChild) continue;

    const short = firstSegment(host) || host;
    const nodeId = `ext:${host}`; // unique per full hostname

    let node = nodeById.get(nodeId);
    if (!node) {
      node = {
        id: nodeId,
        label: short,
        hostname: host,
        sublabel: 'external',
        x: 0,
        y: 0,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        isFailed: false,
        isRootCause: false,
        isExternal: true,
        isDb: false,
        isLambda: false,
        isWebSphere: false,
        websphereServer: '',
        spanCount: 0,
        endpoints: [],
        spans: [],
        fullHostname: host
      };
      nodes.push(node);
      nodeById.set(nodeId, node);
      downstreamNodeIds.add(nodeId);
    }

    const callerService = getServiceName(s);
    // Failing external edge: don't flag the external node itself — only the edge.
    addEdge(callerService, nodeId, isSpanFailed(s));
  }

  // NOTE: We intentionally do NOT create upstream synthetic nodes from
  // dt.entity.process_group.entity.name. The process group is just a cluster
  // label on the service itself (e.g. CDBBOS-cluster is the cluster hosting
  // the CDBBOS (/banking) service), not a separate upstream system.

  const edges = Array.from(edgeMap.values());

  // --- Layer assignment via BFS ---
  const layerOf = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const n of nodes) incoming.set(n.id, 0);
  for (const e of edges) incoming.set(e.targetId, (incoming.get(e.targetId) || 0) + 1);

  // Seed layer 0 with any node that has no incoming edges (upstream synthetics,
  // real root services without an upstream, orphans).
  const queue: string[] = [];
  for (const n of nodes) {
    if ((incoming.get(n.id) || 0) === 0) {
      layerOf.set(n.id, 0);
      queue.push(n.id);
    }
  }

  // Adjacency
  const outEdges = new Map<string, string[]>();
  for (const e of edges) {
    const list = outEdges.get(e.sourceId);
    if (list) list.push(e.targetId);
    else outEdges.set(e.sourceId, [e.targetId]);
  }

  while (queue.length > 0) {
    const id = queue.shift()!;
    const currentLayer = layerOf.get(id)!;
    const children = outEdges.get(id) || [];
    for (const childId of children) {
      const existing = layerOf.get(childId);
      const candidate = currentLayer + 1;
      if (existing === undefined || candidate > existing) {
        layerOf.set(childId, candidate);
        queue.push(childId);
      }
    }
  }

  for (const n of nodes) {
    if (!layerOf.has(n.id)) layerOf.set(n.id, 0);
  }

  // --- Position nodes by layer ---
  const byLayer = new Map<number, FlowNode[]>();
  for (const n of nodes) {
    const l = layerOf.get(n.id)!;
    const list = byLayer.get(l);
    if (list) list.push(n);
    else byLayer.set(l, [n]);
  }

  const sortedLayers = Array.from(byLayer.keys()).sort((a, b) => a - b);
  const maxLayerCount = Math.max(...Array.from(byLayer.values()).map(l => l.length));
  const totalHeight = PAD * 2 + maxLayerCount * NODE_HEIGHT + (maxLayerCount - 1) * V_GAP;

  sortedLayers.forEach((layer, layerIdx) => {
    const layerNodes = byLayer.get(layer)!;
    layerNodes.sort((a, b) => a.label.localeCompare(b.label));
    const layerHeight = layerNodes.length * NODE_HEIGHT + (layerNodes.length - 1) * V_GAP;
    const startY = (totalHeight - layerHeight) / 2;
    layerNodes.forEach((n, i) => {
      n.x = PAD + layerIdx * (NODE_WIDTH + H_GAP) + NODE_WIDTH / 2;
      n.y = startY + i * (NODE_HEIGHT + V_GAP) + NODE_HEIGHT / 2;
    });
  });

  const totalWidth =
    PAD * 2 + sortedLayers.length * NODE_WIDTH + (sortedLayers.length - 1) * H_GAP;

  return { nodes, edges, width: totalWidth, height: totalHeight };
}

/**
 * Computes the set of node IDs "connected" to a starting node using
 * strictly-up and strictly-down walks through the span tree.
 *
 * The rule:
 *   - Walking UP from a clicked span only collects ancestors (parents,
 *     grandparents, ...) up to the trace root. We do NOT then walk back
 *     down from those ancestors — their other children are not on the
 *     call path that involves the clicked node.
 *   - Walking DOWN from a clicked span collects the entire subtree
 *     beneath it (children, grandchildren, ...). External/DB synthetic
 *     nodes encountered during the downward walk are also included.
 *
 * The clicked node sits at the boundary between the two directions.
 *
 * For real service nodes, the "clicked spans" are all spans belonging
 * to that service. For external/DB nodes, the "clicked spans" are the
 * client spans that target the external/DB — we walk strictly up from
 * those (downward is empty because externals are leaves).
 */
export function findConnectedNodeIds(
  spans: SpanRecord[],
  startNodeId: string
): Set<string> {
  const result = new Set<string>([startNodeId]);
  if (!spans || spans.length === 0) return result;

  // Build span lookup tables once
  const spanById = new Map<string, SpanRecord>();
  const childrenByParent = new Map<string, SpanRecord[]>();
  for (const s of spans) {
    spanById.set(s['span.id'], s);
    const pid = s['span.parent_id'];
    if (pid) {
      const list = childrenByParent.get(pid);
      if (list) list.push(s);
      else childrenByParent.set(pid, [s]);
    }
  }

  // --- Determine the starting set of spans for the click ---
  // For real services: every span in the service.
  // For DB/external: every client span targeting that DB/host. These spans
  // become the upward-walk seeds; downward walks are empty for externals
  // because the click target itself has no real spans of its own.
  const startSpans: SpanRecord[] = [];
  let downwardEnabled = true;

  if (startNodeId.startsWith('db:')) {
    const dbNamespace = startNodeId.substring(3);
    downwardEnabled = false;
    for (const s of spans) {
      if (s['span.kind'] !== 'client') continue;
      if (String(s['db.namespace'] ?? '') !== dbNamespace) continue;
      startSpans.push(s);
    }
  } else if (startNodeId.startsWith('ext:')) {
    const host = startNodeId.substring(4);
    downwardEnabled = false;
    for (const s of spans) {
      if (s['span.kind'] !== 'client') continue;
      if (s['db.namespace']) continue;
      if (String(s['server.address'] ?? '') !== host) continue;
      startSpans.push(s);
    }
  } else {
    for (const s of spans) {
      if (getServiceName(s) === startNodeId) {
        startSpans.push(s);
      }
    }
  }

  // --- Strictly-UP walk from each start span ---
  // Collect every service name encountered along the parent chain. We do
  // NOT collect external/DB neighbors of ancestors — those are siblings,
  // not on the path. We do NOT walk back downward from any ancestor.
  for (const startSpan of startSpans) {
    const pid = startSpan['span.parent_id'];
    if (!pid) continue;
    walkStrictlyUp(spanById.get(pid), spanById, result);
  }

  // --- Strictly-DOWN walk from each start span ---
  // Collect every service name in the entire subtree below the start span,
  // plus any external/DB synthetic nodes encountered.
  if (downwardEnabled) {
    for (const startSpan of startSpans) {
      walkStrictlyDown(startSpan, childrenByParent, result);
    }
  }

  console.log(
    `[highlight] "${startNodeId}" → ${result.size} nodes:`,
    Array.from(result)
  );
  return result;
}

/**
 * Walks strictly UP via parent_id, adding every service name encountered
 * to the result set. Stops at the trace root or at a span we've already
 * seen (cycle protection). Never branches sideways or downward.
 */
function walkStrictlyUp(
  start: SpanRecord | undefined,
  spanById: Map<string, SpanRecord>,
  result: Set<string>
): void {
  let current = start;
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current['span.id'])) return;
    visited.add(current['span.id']);
    const svc = getServiceName(current);
    if (svc) result.add(svc);
    const pid = current['span.parent_id'];
    if (!pid) return;
    current = spanById.get(pid);
  }
}

/**
 * Walks strictly DOWN through the entire descendant subtree of `start`,
 * adding every service name and every external/DB synthetic node ID
 * encountered to the result set. The clicked span itself contributes its
 * own service (already in the result, but harmless to re-add).
 */
function walkStrictlyDown(
  start: SpanRecord,
  childrenByParent: Map<string, SpanRecord[]>,
  result: Set<string>
): void {
  const stack: SpanRecord[] = [start];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (visited.has(node['span.id'])) continue;
    visited.add(node['span.id']);

    const svc = getServiceName(node);
    if (svc) result.add(svc);

    // If this is a client span hitting an external/DB, add the synthetic id
    if (node['span.kind'] === 'client') {
      const dbNs = node['db.namespace'];
      if (dbNs) {
        result.add(`db:${String(dbNs)}`);
      } else {
        const host = node['server.address'] as string | undefined;
        if (host) {
          // Only an external if no instrumented child server span exists
          const hasInstrumentedChild = (childrenByParent.get(node['span.id']) || [])
            .some(c => c['span.kind'] === 'server');
          if (!hasInstrumentedChild) {
            result.add(`ext:${host}`);
          }
        }
      }
    }

    const children = childrenByParent.get(node['span.id']) || [];
    for (const c of children) stack.push(c);
  }
}
