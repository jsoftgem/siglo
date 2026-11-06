import type { WorkflowNode } from '@siglo/core';
import type { StepRun } from '../../../types';

export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 140;
const GAP = 72;
interface RouteConstraint { owner: string; route: string }

export interface LayoutNode {
  key: string;
  name: string;
  kind: string;
  stepId?: string;
  legacyNameMatch?: boolean;
  routes?: RouteConstraint[];
  height?: number;
  controlKey?: string;
  x: number;
  y: number;
}
export interface LayoutEdge { from: string; to: string; label?: string; routes?: RouteConstraint[] }
interface Block {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
  entry: string;
  exit: string;
}

function move(block: Block, x: number, y: number): Block {
  return { ...block, nodes: block.nodes.map(node => ({ ...node, x: node.x + x, y: node.y + y })) };
}

/** Build the definition's topology, independent of runtime event arrival order. */
export function layoutWorkflow(ast: WorkflowNode): Block {
  function leaf(key: string, name: string, kind: string, stepId?: string): Block {
    return { nodes: [{ key, name, kind, stepId, x: 0, y: 0 }], edges: [],
      width: NODE_WIDTH, height: NODE_HEIGHT, entry: key, exit: key };
  }

  function visit(node: WorkflowNode, key: string): Block {
    if (node.type === 'sequence' && node.children?.length) {
      const children = node.children.map((child, i) => visit(child, `${key}.${i}`));
      const width = Math.max(...children.map(child => child.width));
      let y = 0;
      const blocks = children.map(child => {
        const block = move(child, (width - child.width) / 2, y);
        y += child.height + GAP;
        return block;
      });
      return { nodes: blocks.flatMap(block => block.nodes),
        edges: [...blocks.flatMap(block => block.edges), ...blocks.slice(1).map((block, i) => ({
          from: blocks[i].exit, to: block.entry
        }))], width, height: y - GAP, entry: blocks[0].entry, exit: blocks[blocks.length - 1].exit };
    }

    const runtimeId = node.metadata?.runtimeStepId || node.id;
    const kind = node.type === 'parallel' ? (node.mode === 'race' ? 'race · first result' : `parallel · ${node.mode || 'fail-fast'}`)
      : node.type === 'map' ? `map · concurrency ${node.concurrency ?? 10}` : node.type;
    const head = leaf(key, node.name, kind, runtimeId);
    head.nodes[0].legacyNameMatch = !node.metadata?.runtimeStepId
      && (node.type === 'branch' || node.type === 'parallel' || node.type === 'map');
    let routes: { label: string; block: Block }[] = [];
    if (node.type === 'parallel') {
      routes = (node.branches || []).map((child, i) => ({ label: `branch ${i + 1}`, block: visit(child, `${key}.${i}`) }));
    } else if (node.type === 'branch') {
      routes = Object.entries(node.branches || {}).map(([label, child], i) => ({ label, block: visit(child, `${key}.${i}`) }));
      if (typeof node.defaultBranch === 'object') {
        routes.push({ label: 'default', block: visit(node.defaultBranch, `${key}.default`) });
      } else if (typeof node.defaultBranch === 'string' && node.branches[node.defaultBranch]) {
        // The default targets an existing route; it does not execute a second copy.
        routes = routes.map(route => route.label === node.defaultBranch ? { ...route, label: `${route.label} (default)` } : route);
      } else if (!(node.name === 'when' && node.branches.else)) {
        routes.push({ label: node.name === 'when' ? 'else' : 'default', block: leaf(`${key}.skip`, 'Continue without action', 'skip') });
      }
    } else if (node.type === 'map' && node.itemNode) {
      routes = [{ label: 'per item', block: visit(node.itemNode, `${key}.item`) }];
    }
    if (!routes.length) return head;

    const width = Math.max(NODE_WIDTH, routes.reduce((sum, route) => sum + route.block.width, 0) + GAP * (routes.length - 1));
    const branchHeight = Math.max(...routes.map(route => route.block.height));
    const joinY = NODE_HEIGHT + GAP + branchHeight + GAP;
    const joinKey = `${key}.join`;
    const joinName = node.type === 'parallel' ? (node.mode === 'race' ? 'First result' : 'Wait for all')
      : node.type === 'map' ? 'Collect results' : 'Merge route';
    const join = move(leaf(joinKey, joinName, node.type === 'branch' ? 'merge' : 'join'), (width - NODE_WIDTH) / 2, joinY);
    join.nodes[0].controlKey = key;
    if (node.type === 'branch') join.nodes[0].height = 0;
    let x = 0;
    const branches = routes.map(route => {
      const block = move(route.block, x, NODE_HEIGHT + GAP);
      const constraints = node.type === 'branch' ? [{ owner: key, route: route.label.replace(' (default)', '') }] : [];
      block.nodes = block.nodes.map(child => ({ ...child, routes: [...constraints, ...(child.routes || [])] }));
      block.edges = block.edges.map(edge => ({ ...edge, routes: [...constraints, ...(edge.routes || [])] }));
      x += block.width + GAP;
      return { ...route, block, constraints };
    });
    return { nodes: [...move(head, (width - NODE_WIDTH) / 2, 0).nodes,
      ...branches.flatMap(route => route.block.nodes), ...join.nodes],
      edges: branches.flatMap(({ label, block, constraints }) => [
        { from: key, to: block.entry, label, routes: constraints }, ...block.edges, { from: block.exit, to: joinKey, routes: constraints }
      ]), width, height: joinY + (node.type === 'branch' ? 0 : NODE_HEIGHT), entry: key, exit: joinKey };
  }
  return visit(ast, 'root');
}

export type RouteState = 'taken' | 'skipped' | 'unknown';

/** Route decisions remain usable even when application output is not captured. */
export function routeHighlights(graph: Block, matches: Map<string, StepRun>) {
  const decisions = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.kind !== 'branch') continue;
    const step = matches.get(node.key);
    const output = step?.outputSummary as Record<string, unknown> | undefined;
    let route = step?.selectedRoute;
    // Compatibility with runtimes predating branch:selected events.
    if (route === undefined && step?.status === 'COMPLETED' && output && typeof output === 'object') {
      if (typeof output.$branchSelected === 'string') route = output.$branchSelected;
      else if (output.$skipped === true) route = node.name === 'when' ? 'else' : 'default';
    }
    if (route !== undefined) {
      const routes = graph.edges.filter(edge => edge.from === node.key).flatMap(edge => edge.routes || []);
      decisions.set(node.key, routes.some(item => item.owner === node.key && item.route === route) ? route : 'default');
    }
  }
  const state = (routes?: RouteConstraint[]): RouteState => {
    if (!routes?.length) return 'unknown';
    if (routes.some(item => decisions.has(item.owner) && decisions.get(item.owner) !== item.route)) return 'skipped';
    return routes.every(item => decisions.get(item.owner) === item.route) ? 'taken' : 'unknown';
  };
  const nodes = new Map(graph.nodes.map(node => [node.key, state(node.routes)]));
  const byKey = new Map(graph.nodes.map(node => [node.key, node]));
  const edges = graph.edges.map(edge => {
    const routeState = state(edge.routes);
    if (routeState !== 'unknown') return routeState;
    const from = byKey.get(edge.from)!;
    const owner = from.controlKey;
    return owner && decisions.has(owner) && matches.get(owner)?.status === 'COMPLETED' ? 'taken' : routeState;
  });
  return { nodes, edges };
}

/** IDs are authoritative. Older definitions can match a name only if unambiguous. */
export function matchSteps(nodes: LayoutNode[], steps: Record<string, StepRun>): Map<string, StepRun> {
  const matches = new Map<string, StepRun>();
  const used = new Set<string>();
  for (const node of nodes) {
    if (node.stepId && steps[node.stepId]) {
      matches.set(node.key, steps[node.stepId]);
      used.add(node.stepId);
    }
  }
  const observed = Object.values(steps);
  for (const node of nodes) {
    if (!node.legacyNameMatch || matches.has(node.key)) continue;
    const candidates = observed.filter(step => !used.has(step.stepId) && step.stepName === node.name);
    if (candidates.length === 1 && nodes.filter(other => other.stepId && other.name === node.name).length === 1) {
      matches.set(node.key, candidates[0]);
      used.add(candidates[0].stepId);
    }
  }
  return matches;
}
