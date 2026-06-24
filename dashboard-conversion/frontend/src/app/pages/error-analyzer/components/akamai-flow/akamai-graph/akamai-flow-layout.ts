import type { FlowHop } from '../../../models/akamai.model';

/** A laid-out node: spine hop or conditional branch. */
export interface AkNode {
  id: string;
  kind: string;              // FlowHopKind | 'branch'
  label: string;
  detail: string;
  annotations: string[];
  x: number;
  y: number;
  width: number;
  height: number;
  isConditional: boolean;    // branch nodes render dimmed/dashed
}

/** A laid-out edge. Conditional edges carry a gate label and dash. */
export interface AkEdge {
  id: string;
  sourceId: string;
  targetId: string;
  label: string;
  isConditional: boolean;
}

export interface AkGraph {
  nodes: AkNode[];
  edges: AkEdge[];
  width: number;
  height: number;
}

const NODE_WIDTH = 210;
const BASE_HEIGHT = 64;
const LINE_HEIGHT = 16;
const MAX_ANN = 3;
const H_GAP = 80;
const BRANCH_V_GAP = 70;
const PAD = 30;

function nodeHeight(annCount: number): number {
  return BASE_HEIGHT + Math.min(annCount, MAX_ANN) * LINE_HEIGHT;
}

/** Caps annotation lines, collapsing the overflow into a "+N more" line. */
function capAnnotations(labels: string[]): string[] {
  if (labels.length <= MAX_ANN) return labels;
  return [...labels.slice(0, MAX_ANN - 1), `+${labels.length - (MAX_ANN - 1)} more`];
}

/**
 * Lays out the flow as a horizontal spine (request → … → backend) with
 * conditional branches stacked in a row beneath, each connected to the
 * hop it diverts from.
 */
export function buildAkamaiFlowGraph(flow: FlowHop[], showAlternatives = false): AkGraph {
  if (!flow || flow.length === 0) {
    return { nodes: [], edges: [], width: 0, height: 0 };
  }

  const nodes: AkNode[] = [];
  const edges: AkEdge[] = [];

  const spineHeights = flow.map(h => nodeHeight(h.annotations.length));
  const maxSpineHeight = Math.max(...spineHeights);
  const spineCenterY = PAD + maxSpineHeight / 2;

  // Spine row.
  flow.forEach((hop, i) => {
    const annotations = capAnnotations(hop.annotations.map(a => a.label));
    nodes.push({
      id: `hop-${i}`,
      kind: hop.kind,
      label: hop.label,
      detail: hop.detail,
      annotations,
      x: PAD + i * (NODE_WIDTH + H_GAP) + NODE_WIDTH / 2,
      y: spineCenterY,
      width: NODE_WIDTH,
      height: nodeHeight(annotations.length),
      isConditional: false
    });
    if (i > 0) {
      edges.push({
        id: `edge-${i}`,
        sourceId: `hop-${i - 1}`,
        targetId: `hop-${i}`,
        label: '',
        isConditional: false
      });
    }
  });

  // Branch row — all branches in a single row beneath, left to right.
  // Skipped entirely unless the "show alternatives" toggle is on.
  const branchTopY = spineCenterY + maxSpineHeight / 2 + BRANCH_V_GAP;
  const firstBranchX = PAD + Math.min(1, flow.length - 1) * (NODE_WIDTH + H_GAP) + NODE_WIDTH / 2;
  let branchIdx = 0;

  if (showAlternatives) {
    flow.forEach((hop, i) => {
      hop.branches.forEach((branch, bi) => {
        const id = `branch-${i}-${bi}`;
        const h = nodeHeight(0);
        nodes.push({
          id,
          kind: 'branch',
          label: branch.targetLabel,
          detail: branch.rulePath.length ? branch.rulePath[branch.rulePath.length - 1] : '',
          annotations: [],
          x: firstBranchX + branchIdx * (NODE_WIDTH + H_GAP),
          y: branchTopY + h / 2,
          width: NODE_WIDTH,
          height: h,
          isConditional: true
        });
        edges.push({
          id: `bedge-${i}-${bi}`,
          sourceId: `hop-${i}`,
          targetId: id,
          label: branch.conditionLabel,
          isConditional: true
        });
        branchIdx++;
      });
    });
  }

  const maxX = nodes.reduce((m, n) => Math.max(m, n.x + n.width / 2), 0);
  const maxY = nodes.reduce((m, n) => Math.max(m, n.y + n.height / 2), 0);

  return {
    nodes,
    edges,
    width: maxX + PAD,
    height: maxY + PAD
  };
}
