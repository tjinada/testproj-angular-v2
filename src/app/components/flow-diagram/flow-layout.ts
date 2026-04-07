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
    // Only count endpoints from server-kind spans — client/internal spans
    // surface things like outbound HTTP calls, DB connection lifecycle
    // events, and Java method-level traces, none of which are "endpoints"
    // in any meaningful sense.
    const endpoints = Array.from(
      new Set(
        grp
          .filter(s => s['span.kind'] === 'server')
          .map(s => s['endpoint.name'] || s['span.name'])
          .filter(Boolean) as string[]
      )
    );
    // Pick a host name from any span in the group
    const hostFull = (grp.find(s => s['dt.entity.host.entity.name'])?.[
      'dt.entity.host.entity.name'
    ] as string) || '';
    const node: FlowNode = {
      id: name,
      label: name,
      hostname: firstSegment(hostFull) || hostFull,
      sublabel: `${grp.length} span${grp.length === 1 ? '' : 's'}`,
      x: 0,
      y: 0,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      isFailed: grp.some(isSpanFailed),
      isRootCause: rootCauseService !== null && name === rootCauseService,
      isExternal: false,
      isDb: false,
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
 * Computes the set of node IDs "connected" to a starting node via a
 * server-span-to-server-span walk.
 *
 * The rule: two services are directly connected if there is a span chain
 * between them where every intermediate span is non-server (client or
 * internal). The walk hops from one server span, down or up through any
 * number of non-server spans, until it reaches the next server span.
 * That next server span's service is added to the set, and the walk
 * continues from there.
 *
 * For external/DB nodes (which have no real spans), the starting frontier
 * is built from the client spans that target them — i.e. "highlight every
 * service that calls this external" — and the walk proceeds from those
 * services' server spans normally.
 *
 * Returns a set of node IDs (matching FlowNode.id) including the starting
 * node itself.
 */
export function findConnectedNodeIds(
  spans: SpanRecord[],
  startNodeId: string
): Set<string> {
  console.group(`[highlight] findConnectedNodeIds("${startNodeId}")`);
  console.log('total spans:', spans?.length || 0);

  const result = new Set<string>([startNodeId]);
  if (!spans || spans.length === 0) {
    console.warn('[highlight] no spans, returning just the start node');
    console.groupEnd();
    return result;
  }

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
  console.log('built spanById:', spanById.size, 'entries');
  console.log('built childrenByParent:', childrenByParent.size, 'entries');

  const isServer = (s: SpanRecord) => s['span.kind'] === 'server';

  // --- Determine the starting set of server spans ---
  const frontier: SpanRecord[] = [];
  const visitedSpanIds = new Set<string>();

  if (startNodeId.startsWith('db:')) {
    const dbNamespace = startNodeId.substring(3);
    console.log('[highlight] start type: DB node, namespace=', dbNamespace);
    for (const s of spans) {
      if (s['span.kind'] !== 'client') continue;
      if (String(s['db.namespace'] ?? '') !== dbNamespace) continue;
      const ancestorServer = walkUpToServerSpan(s, spanById);
      if (ancestorServer) {
        const svc = getServiceName(ancestorServer);
        if (svc) result.add(svc);
        if (!visitedSpanIds.has(ancestorServer['span.id'])) {
          visitedSpanIds.add(ancestorServer['span.id']);
          frontier.push(ancestorServer);
        }
      }
    }
  } else if (startNodeId.startsWith('ext:')) {
    const host = startNodeId.substring(4);
    console.log('[highlight] start type: external node, host=', host);
    for (const s of spans) {
      if (s['span.kind'] !== 'client') continue;
      if (s['db.namespace']) continue;
      if (String(s['server.address'] ?? '') !== host) continue;
      const ancestorServer = walkUpToServerSpan(s, spanById);
      if (ancestorServer) {
        const svc = getServiceName(ancestorServer);
        if (svc) result.add(svc);
        if (!visitedSpanIds.has(ancestorServer['span.id'])) {
          visitedSpanIds.add(ancestorServer['span.id']);
          frontier.push(ancestorServer);
        }
      }
    }
  } else {
    console.log('[highlight] start type: real service node, name=', startNodeId);
    // Sanity-check: how many server spans match by service name?
    const matchedByServiceName = spans.filter(s =>
      isServer(s) && getServiceName(s) === startNodeId
    );
    console.log('[highlight] matching server spans by service name:', matchedByServiceName.length);
    if (matchedByServiceName.length === 0) {
      // Show what service names we DO see for server spans, in case there's
      // a label mismatch (e.g. graph uses one form, spans use another)
      const allServerServiceNames = new Set(
        spans.filter(isServer).map(s => getServiceName(s))
      );
      console.warn(
        '[highlight] NO server spans matched! Available server-span service names:',
        Array.from(allServerServiceNames)
      );
    }
    for (const s of matchedByServiceName) {
      visitedSpanIds.add(s['span.id']);
      frontier.push(s);
    }
  }

  console.log('[highlight] starting frontier size:', frontier.length);
  if (frontier.length === 0) {
    console.warn('[highlight] frontier is empty — nothing to walk, fading will not happen');
  }

  // --- BFS over server spans in both directions ---
  let iterations = 0;
  while (frontier.length > 0) {
    iterations++;
    const current = frontier.shift()!;
    const currentSvc = getServiceName(current);
    console.log(
      `[highlight] iter ${iterations}: visiting span`,
      current['span.id'].substring(0, 8),
      'service=', currentSvc
    );

    const downServers = collectDownstreamServerSpans(current, childrenByParent);
    if (downServers.length > 0) {
      console.log(`  ↓ found ${downServers.length} downstream server span(s):`,
        downServers.map(d => `${getServiceName(d)} (${d['span.id'].substring(0, 8)})`)
      );
    }
    for (const ds of downServers) {
      const svc = getServiceName(ds);
      if (svc) result.add(svc);
      if (!visitedSpanIds.has(ds['span.id'])) {
        visitedSpanIds.add(ds['span.id']);
        frontier.push(ds);
      }
      collectExternalNeighborIds(ds, childrenByParent).forEach(id => result.add(id));
    }

    const upServer = walkUpToServerSpanFromParent(current, spanById);
    if (upServer) {
      const upSvc = getServiceName(upServer);
      console.log(`  ↑ found upstream server span:`, upSvc, `(${upServer['span.id'].substring(0, 8)})`);
      if (upSvc) result.add(upSvc);
      if (!visitedSpanIds.has(upServer['span.id'])) {
        visitedSpanIds.add(upServer['span.id']);
        frontier.push(upServer);
      }
    }

    const externals = collectExternalNeighborIds(current, childrenByParent);
    if (externals.length > 0) {
      console.log(`  → external/db neighbors:`, externals);
      externals.forEach(id => result.add(id));
    }
  }

  console.log('[highlight] BFS done after', iterations, 'iterations');
  console.log('[highlight] final highlighted set:', Array.from(result));
  console.groupEnd();
  return result;
}

/**
 * Walks DOWN from a server span, descending through non-server children
 * (client/internal), and returns every server span found at the boundaries.
 * The walk stops at each server span (it doesn't recurse into them — that's
 * the BFS caller's job).
 */
function collectDownstreamServerSpans(
  start: SpanRecord,
  childrenByParent: Map<string, SpanRecord[]>
): SpanRecord[] {
  const found: SpanRecord[] = [];
  const stack: SpanRecord[] = [];
  const initialChildren = childrenByParent.get(start['span.id']) || [];
  stack.push(...initialChildren);

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node['span.kind'] === 'server') {
      found.push(node);
      // Don't descend further — the BFS caller will handle this server span
      continue;
    }
    // Non-server: keep descending through its children
    const grandChildren = childrenByParent.get(node['span.id']) || [];
    stack.push(...grandChildren);
  }
  return found;
}

/**
 * Walks UP from a non-server span via parent_id until it hits a server span.
 * Returns null if it walks off the top of the trace without finding one.
 */
function walkUpToServerSpan(
  start: SpanRecord,
  spanById: Map<string, SpanRecord>
): SpanRecord | null {
  let current: SpanRecord | undefined = start;
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current['span.id'])) return null;
    visited.add(current['span.id']);
    if (current['span.kind'] === 'server' && current !== start) {
      return current;
    }
    const pid = current['span.parent_id'];
    if (!pid) return current['span.kind'] === 'server' && current !== start ? current : null;
    current = spanById.get(pid);
  }
  return null;
}

/**
 * Walks UP from a SERVER span's parent chain until it hits the next server
 * span. Skips the starting server span itself — we want the next one above.
 */
function walkUpToServerSpanFromParent(
  start: SpanRecord,
  spanById: Map<string, SpanRecord>
): SpanRecord | null {
  const pid = start['span.parent_id'];
  if (!pid) return null;
  let current = spanById.get(pid);
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current['span.id'])) return null;
    visited.add(current['span.id']);
    if (current['span.kind'] === 'server') return current;
    const nextPid = current['span.parent_id'];
    if (!nextPid) return null;
    current = spanById.get(nextPid);
  }
  return null;
}

/**
 * For a given server span, returns the IDs of any external/DB synthetic
 * nodes that are directly attached to it via client-span children. These
 * should also be highlighted because they are part of "what this service
 * touches".
 */
function collectExternalNeighborIds(
  serverSpan: SpanRecord,
  childrenByParent: Map<string, SpanRecord[]>
): string[] {
  const ids: string[] = [];
  const stack = [...(childrenByParent.get(serverSpan['span.id']) || [])];
  while (stack.length > 0) {
    const s = stack.pop()!;
    if (s['span.kind'] === 'server') {
      // Don't traverse into other services
      continue;
    }
    if (s['span.kind'] === 'client') {
      const dbNs = s['db.namespace'];
      if (dbNs) {
        ids.push(`db:${String(dbNs)}`);
      } else {
        const host = s['server.address'] as string | undefined;
        if (host) {
          // Only count if it's a real external (no instrumented child server span)
          const hasInstrumentedChild = (childrenByParent.get(s['span.id']) || [])
            .some(c => c['span.kind'] === 'server');
          if (!hasInstrumentedChild) {
            ids.push(`ext:${host}`);
          }
        }
      }
    }
    // Continue descending through internal/client wrappers
    const grandChildren = childrenByParent.get(s['span.id']) || [];
    stack.push(...grandChildren);
  }
  return ids;
}
