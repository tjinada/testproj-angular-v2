import { SpanRecord } from '../../models/trace.model';
import { isSpanFailed, extractCapturedExceptions } from '../../services/trace-analyzer';

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
  isMessaging: boolean;    // true for synthetic Kafka topic / MQ queue nodes (subset of external)
  isLambda: boolean;       // true if Dynatrace classifies the node as aws-lambda
  isWebSphere: boolean;    // true if websphere.server.name is present
  isChannels: boolean;     // true if k8s.container.name contains 'channels'
  techBadge: string;       // display badge from icon.primaryIconType ('' = none)
  callCount: number;       // real call count (aggregation-aware; >= spanCount)
  totalDurationNanos: number; // wall time attributable to this node's spans (may overlap parent/child)
  totalCpuNanos: number;   // CPU time reported by this node's spans (0 = not reported)
  exceptionCount: number;  // count of captured exceptions on non-failing spans
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
  isAsync: boolean;        // true for fire-and-forget messaging hops (rendered dashed)
  callCount: number;
  durationNanos: number;   // total wall time of the child spans behind this edge
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

/**
 * Real call count for a span. Dynatrace aggregates repeated identical
 * calls (DB CONNECTs etc.) into a single span carrying aggregation.count.
 * Ignoring it silently undercounts what actually happened.
 */
function callsOf(span: SpanRecord): number {
  const n = Number(span['aggregation.count']);
  return Number.isFinite(n) && n > 1 ? n : 1;
}

/**
 * Wall-clock nanoseconds attributable to a span. Aggregated spans carry
 * the true total in aggregation.duration_sum; plain duration otherwise.
 */
function durationOf(span: SpanRecord): number {
  return Number(span['aggregation.duration_sum']) || Number(span['duration']) || 0;
}

/** CPU nanoseconds reported for a span (0 when the agent doesn't report it). */
function cpuOf(span: SpanRecord): number {
  return Number(span['span.timing.cpu']) || 0;
}

/**
 * Map Dynatrace's own tech classification (icon.primaryIconType) to a
 * display badge. Authoritative and covers all runtimes, unlike scope-name
 * heuristics (e.g. only nodejs lambdas have dt.agent.nodejs.Lambda).
 * Unknown icon types render no badge rather than leaking raw strings.
 */
const ICON_BADGES: Record<string, string> = {
  'web-sphere': 'WEBSPHERE',
  'aws-lambda': 'LAMBDA',
  'apache-tomcat': 'TOMCAT',
  'spring-signet': 'SPRING',
  'apache': 'APACHE',
  'kafka-signet': 'KAFKA',
  'ibm': 'IBM'
};

/** Majority icon type across the group, mapped to a badge label. */
function deriveTechBadge(grp: SpanRecord[]): string {
  const counts = new Map<string, number>();
  for (const s of grp) {
    const t = (s['icon'] as { primaryIconType?: string } | null | undefined)?.primaryIconType;
    if (!t) continue;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [t, c] of counts.entries()) {
    if (c > bestCount) { best = t; bestCount = c; }
  }
  if (!best) return '';
  // 'ibm' covers CICS, z/OS Connect, and MQ listeners; only genuine
  // mainframe-sourced spans earn the MAINFRAME badge.
  if (best === 'ibm' && grp.some(s => s['dt.system.monitoring_source'] === 'mainframe')) {
    return 'MAINFRAME';
  }
  return ICON_BADGES[best] || '';
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

    // Tech badge from Dynatrace's icon classification; lambda status is
    // derived from the same source (the old otel.scope.name check missed
    // non-nodejs lambdas and lambdas whose spans report HttpClient scope).
    const techBadge = deriveTechBadge(grp);
    const isLambda = techBadge === 'LAMBDA';

    // Channels detection: k8s.container.name contains 'channels'
    const isChannels = !!k8sContainer && k8sContainer.toLowerCase().includes('channels');

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

    // Aggregation-aware call count; shown only when it differs from the
    // span count so unaggregated nodes look unchanged.
    const callCount = grp.reduce((sum, s) => sum + callsOf(s), 0);
    const totalDurationNanos = grp.reduce((sum, s) => sum + durationOf(s), 0);
    const totalCpuNanos = grp.reduce((sum, s) => sum + cpuOf(s), 0);
    const spanPart = `${grp.length} span${grp.length === 1 ? '' : 's'}`;
    const callPart = callCount !== grp.length ? ` \u00b7 ${callCount} calls` : '';
    const sublabel = (isLambda ? 'lambda \u00b7 ' : '') + spanPart + callPart;

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
      isMessaging: false,
      isLambda,
      isWebSphere,
      isChannels,
      techBadge,
      callCount,
      totalDurationNanos,
      totalCpuNanos,
      exceptionCount: (() => {
        const failedSpanIds = new Set(grp.filter(isSpanFailed).map(s => s['span.id']));
        const captured = extractCapturedExceptions(grp).filter(ex => !failedSpanIds.has(ex.spanId)).length;
        // Aggregated spans report exception totals separately from span.events.
        const aggregated = grp.reduce(
          (sum, s) => sum + (Number(s['aggregation.exception_count']) || 0), 0
        );
        return captured + aggregated;
      })(),
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
  const addEdge = (
    sourceId: string, targetId: string, failed: boolean,
    count: number = 1, isAsync: boolean = false, durationNanos: number = 0
  ) => {
    if (sourceId === targetId) return;
    const key = `${sourceId}->${targetId}`;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.callCount += count;
      existing.durationNanos += durationNanos;
      if (failed) existing.isFailed = true;
      if (isAsync) existing.isAsync = true;
    } else {
      edgeMap.set(key, {
        id: key,
        sourceId,
        targetId,
        isFailed: failed,
        isAsync,
        callCount: count,
        durationNanos
      });
    }
  };

  for (const s of spans) {
    const parentId = s['span.parent_id'];
    if (!parentId) continue;
    const parent = spanById.get(parentId);
    if (!parent) continue;
    // Consumer spans parent directly onto the producer span; that async hop
    // is re-routed through the topic/queue node in the messaging pass below,
    // so the direct service-to-service edge is suppressed here.
    if (s['span.kind'] === 'consumer' && s['messaging.destination.name']) continue;
    const childService = getServiceName(s);
    const parentService = getServiceName(parent);
    addEdge(parentService, childService, isSpanFailed(s), callsOf(s), false, durationOf(s));
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
        isMessaging: false,
        isLambda: false,
        isWebSphere: false,
        isChannels: false,
        techBadge: '',
        callCount: 0,
        totalDurationNanos: 0,
        totalCpuNanos: 0,
        exceptionCount: 0,
        websphereServer: '',
        spanCount: 0,
        endpoints: [],
        spans: [],
        fullHostname: dbHost
      };
      nodes.push(node);
      nodeById.set(nodeId, node);
    }

    // Attach the client span so the drawer can show the statements that
    // actually hit this DB (previously spans stayed empty and clicking a
    // DB node showed nothing).
    node.spans.push(s);

    const callerService = getServiceName(s);
    addEdge(callerService, nodeId, isSpanFailed(s), callsOf(s), false, durationOf(s));
  }

  // Finalize DB node counts and sublabels now that spans are attached:
  // "oracle · 33 calls" instead of the generic "database".
  for (const n of nodes) {
    if (!n.isDb || n.spans.length === 0) continue;
    n.spanCount = n.spans.length;
    n.callCount = n.spans.reduce((sum, s) => sum + callsOf(s), 0);
    n.totalDurationNanos = n.spans.reduce((sum, s) => sum + durationOf(s), 0);
    const dbSystem = (n.spans.find(s => s['db.system'])?.['db.system'] as string) || 'database';
    n.sublabel = `${dbSystem} \u00b7 ${n.callCount} call${n.callCount === 1 ? '' : 's'}`;
  }

  // --- Build MESSAGING synthetic nodes (Kafka topics / MQ queues) ---
  // Producer and consumer spans carry messaging.destination.name, and the
  // consumer's parent_id points at the producer span. The direct
  // producer→consumer edge was suppressed in the parent-edge loop above;
  // here it is re-routed as producer → channel → consumer so the async
  // hop is visible. Producers without an in-trace consumer leave the
  // channel as a leaf.
  for (const s of spans) {
    const dest = s['messaging.destination.name'] as string | undefined;
    if (!dest) continue;
    const kind = s['span.kind'];
    if (kind !== 'producer' && kind !== 'consumer') continue;

    const system = ((s['messaging.system'] as string) || '').toLowerCase();
    const nodeId = `msg:${dest}`;

    let node = nodeById.get(nodeId);
    if (!node) {
      node = {
        id: nodeId,
        label: dest,
        hostname: '',
        sublabel: system === 'kafka' ? 'topic' : 'queue',
        x: 0,
        y: 0,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        isFailed: false,
        isRootCause: false,
        isExternal: true,
        isDb: false,
        isMessaging: true,
        isLambda: false,
        isWebSphere: false,
        isChannels: false,
        techBadge: system === 'kafka' ? 'KAFKA' : 'MQ',
        callCount: 0,
        totalDurationNanos: 0,
        totalCpuNanos: 0,
        exceptionCount: 0,
        websphereServer: '',
        spanCount: 0,
        endpoints: [],
        spans: [],
        fullHostname: dest
      };
      nodes.push(node);
      nodeById.set(nodeId, node);
    }

    node.spans.push(s);

    const svc = getServiceName(s);
    if (kind === 'producer') {
      addEdge(svc, nodeId, isSpanFailed(s), callsOf(s), true, durationOf(s));
    } else {
      addEdge(nodeId, svc, isSpanFailed(s), callsOf(s), true, durationOf(s));
    }
  }

  // Finalize messaging sublabels: "topic · 1 producer · 1 consumer".
  for (const n of nodes) {
    if (!n.isMessaging || n.spans.length === 0) continue;
    n.spanCount = n.spans.length;
    n.callCount = n.spans.reduce((sum, s) => sum + callsOf(s), 0);
    n.totalDurationNanos = n.spans.reduce((sum, s) => sum + durationOf(s), 0);
    const system = ((n.spans[0]['messaging.system'] as string) || '').toLowerCase();
    const parts = [system === 'kafka' ? 'topic' : 'queue'];
    const producers = new Set(
      n.spans.filter(s => s['span.kind'] === 'producer').map(getServiceName)
    ).size;
    const consumers = new Set(
      n.spans.filter(s => s['span.kind'] === 'consumer').map(getServiceName)
    ).size;
    if (producers > 0) parts.push(`${producers} producer${producers === 1 ? '' : 's'}`);
    if (consumers > 0) parts.push(`${consumers} consumer${consumers === 1 ? '' : 's'}`);
    n.sublabel = parts.join(' \u00b7 ');
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
        isMessaging: false,
        isLambda: false,
        isWebSphere: false,
        isChannels: false,
        techBadge: '',
        callCount: 0,
        totalDurationNanos: 0,
        totalCpuNanos: 0,
        exceptionCount: 0,
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

    node.totalDurationNanos += durationOf(s);

    const callerService = getServiceName(s);
    // Failing external edge: don't flag the external node itself — only the edge.
    addEdge(callerService, nodeId, isSpanFailed(s), callsOf(s), false, durationOf(s));
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

  // --- Determine the starting spans for the click ---
  // Real services: every span in the service seeds both directions.
  // DB/external: client spans targeting them seed the upward walk only
  // (they are leaves; there is nothing beneath them).
  // Messaging channels: producer spans seed the upward walk (who led to
  // the publish), consumer spans seed the downward walk (what the
  // consumption triggered).
  const upSeeds: SpanRecord[] = [];
  const downSeeds: SpanRecord[] = [];

  if (startNodeId.startsWith('db:')) {
    const dbNamespace = startNodeId.substring(3);
    for (const s of spans) {
      if (s['span.kind'] !== 'client') continue;
      if (String(s['db.namespace'] ?? '') !== dbNamespace) continue;
      upSeeds.push(s);
    }
  } else if (startNodeId.startsWith('ext:')) {
    const host = startNodeId.substring(4);
    for (const s of spans) {
      if (s['span.kind'] !== 'client') continue;
      if (s['db.namespace']) continue;
      if (String(s['server.address'] ?? '') !== host) continue;
      upSeeds.push(s);
    }
  } else if (startNodeId.startsWith('msg:')) {
    const dest = startNodeId.substring(4);
    for (const s of spans) {
      if (String(s['messaging.destination.name'] ?? '') !== dest) continue;
      if (s['span.kind'] === 'producer') upSeeds.push(s);
      else if (s['span.kind'] === 'consumer') downSeeds.push(s);
    }
  } else {
    for (const s of spans) {
      if (getServiceName(s) === startNodeId) {
        upSeeds.push(s);
        downSeeds.push(s);
      }
    }
  }

  // --- Strictly-UP walk from each up seed ---
  // Collect every service name encountered along the parent chain. We do
  // NOT collect external/DB neighbors of ancestors — those are siblings,
  // not on the path. We do NOT walk back downward from any ancestor.
  for (const startSpan of upSeeds) {
    addMessagingNodeId(startSpan, result);
    const pid = startSpan['span.parent_id'];
    if (!pid) continue;
    walkStrictlyUp(spanById.get(pid), spanById, result);
  }

  // --- Strictly-DOWN walk from each down seed ---
  // Collect every service name in the entire subtree below the start span,
  // plus any external/DB/messaging synthetic nodes encountered.
  for (const startSpan of downSeeds) {
    walkStrictlyDown(startSpan, childrenByParent, result);
  }

  console.log(
    `[highlight] "${startNodeId}" → ${result.size} nodes:`,
    Array.from(result)
  );
  return result;
}

/**
 * If the span is a messaging producer/consumer, add its channel's
 * synthetic node id so path highlighting flows through topics/queues.
 */
function addMessagingNodeId(span: SpanRecord, result: Set<string>): void {
  const dest = span['messaging.destination.name'] as string | undefined;
  if (!dest) return;
  const kind = span['span.kind'];
  if (kind === 'producer' || kind === 'consumer') {
    result.add(`msg:${dest}`);
  }
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
    addMessagingNodeId(current, result);
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
    addMessagingNodeId(node, result);

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

// ============================================================
// CRITICAL PATH (Duration lens)
// ============================================================

/** One hop on the critical path, for the breakdown strip. */
export interface CriticalPathStep {
  nodeId: string;
  label: string;
  durationNanos: number;
}

export interface CriticalPath {
  nodeIds: Set<string>;
  edgeKeys: Set<string>;
  steps: CriticalPathStep[];
  totalDurationNanos: number;
}

/** Display name for a critical-path step. */
function spanDisplayName(s: SpanRecord): string {
  return (s['endpoint.name'] as string) || (s['span.name'] as string) || getServiceName(s);
}

/**
 * The chain where the request's time actually went: starting at the
 * slowest root span, repeatedly follow the slowest child down to a leaf.
 * Returns the node ids and edge keys on that chain (for gold styling)
 * plus one step per node transition (for the breakdown strip). If the
 * chain ends on a client/producer span, the synthetic DB/external/topic
 * target is included so the true leaf is on the path.
 */
export function computeCriticalPath(spans: SpanRecord[]): CriticalPath | null {
  if (!spans || spans.length === 0) return null;

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

  // Roots: spans whose parent is absent from the trace. Pick the slowest.
  let root: SpanRecord | null = null;
  for (const s of spans) {
    const pid = s['span.parent_id'];
    if (pid && spanById.has(pid)) continue;
    if (!root || durationOf(s) > durationOf(root)) root = s;
  }
  if (!root) return null;

  // Follow the slowest child at each level down to a leaf.
  const chain: SpanRecord[] = [];
  let current: SpanRecord | null = root;
  const visited = new Set<string>();
  while (current && !visited.has(current['span.id'])) {
    visited.add(current['span.id']);
    chain.push(current);
    const children = childrenByParent.get(current['span.id']) || [];
    let next: SpanRecord | null = null;
    for (const c of children) {
      if (!next || durationOf(c) > durationOf(next)) next = c;
    }
    current = next;
  }

  const nodeIds = new Set<string>();
  const edgeKeys = new Set<string>();
  const steps: CriticalPathStep[] = [];
  let prevNodeId: string | null = null;

  const pushStep = (nodeId: string, span: SpanRecord) => {
    if (prevNodeId === nodeId) return;
    nodeIds.add(nodeId);
    if (prevNodeId) edgeKeys.add(`${prevNodeId}->${nodeId}`);
    steps.push({ nodeId, label: spanDisplayName(span), durationNanos: durationOf(span) });
    prevNodeId = nodeId;
  };

  for (const s of chain) {
    pushStep(getServiceName(s), s);
  }

  // Extend to the synthetic leaf when the chain ends on an outgoing span.
  const tail = chain[chain.length - 1];
  if (tail) {
    const kind = tail['span.kind'];
    const dest = tail['messaging.destination.name'] as string | undefined;
    if (kind === 'client' && tail['db.namespace']) {
      pushStep(`db:${String(tail['db.namespace'])}`, tail);
    } else if (kind === 'client' && tail['server.address']) {
      pushStep(`ext:${String(tail['server.address'])}`, tail);
    } else if (kind === 'producer' && dest) {
      pushStep(`msg:${dest}`, tail);
    }
  }

  return { nodeIds, edgeKeys, steps, totalDurationNanos: durationOf(root) };
}