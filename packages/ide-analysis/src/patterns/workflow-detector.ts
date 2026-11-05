import ts from 'typescript';
import type {
  GraphDocument,
  GraphNode,
  GraphEdge,
  UnresolvedNode,
  Diagnostic,
} from '@siglo/ide-protocol';
import { getSourceRange, generateDeterministicNodeId } from '../mapper';
import { detectStepFromExpression, DetectedStep, extractDisplayProperties } from './step-detector';

interface WorkflowParseContext {
  sourceFile: ts.SourceFile;
  uri: string;
  documentVersion: number;
  stepDefinitions: Map<string, GraphNode>;
  flowDefinitions: Map<string, { nodes: GraphNode[]; edges: GraphEdge[]; properties?: Record<string, string> }>;
}

export function analyzeWorkflowsInSourceFile(
  sourceFile: ts.SourceFile,
  uri: string,
  documentVersion = 1
): GraphDocument[] {
  const ctx: WorkflowParseContext = {
    sourceFile,
    uri,
    documentVersion,
    stepDefinitions: new Map(),
    flowDefinitions: new Map(),
  };

  // Phase 1: Collect top-level step variable declarations
  collectStepDefinitions(sourceFile, ctx);

  // Phase 2: Find workflow declarations and chains
  const workflows: GraphDocument[] = [];
  walkForWorkflows(sourceFile, ctx, workflows);

  // Fallback: If no workflow call expression was found, but steps exist in file,
  // create a default synthetic workflow document representing the file's steps.
  if (workflows.length === 0 && ctx.stepDefinitions.size > 0) {
    const nodes = Array.from(ctx.stepDefinitions.values());
    const edges: GraphEdge[] = [];
    for (let i = 0; i < nodes.length - 1; i++) {
      edges.push({
        id: `edge_${nodes[i].id}_to_${nodes[i + 1].id}`,
        from: nodes[i].id,
        to: nodes[i + 1].id,
        type: 'sequential',
      });
    }
    workflows.push({
      uri,
      documentVersion,
      workflowName: 'defaultWorkflow',
      nodes,
      edges,
      unresolved: [],
      diagnostics: runDiagnostics(nodes, edges),
    });
  }

  return workflows;
}

function collectStepDefinitions(sourceFile: ts.SourceFile, ctx: WorkflowParseContext) {
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const varName = node.name.getText(sourceFile);
      const enclosingRange = getSourceRange(sourceFile, node);
      const detected = detectStepFromExpression(node.initializer, sourceFile, enclosingRange);
      if (detected && detected.kind === 'node') {
        const stepNode = {
          ...detected.node,
          declarationRange: enclosingRange,
        };
        ctx.stepDefinitions.set(varName, stepNode);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function getEnclosingName(node: ts.Node, sourceFile: ts.SourceFile): string | null {
  let p: ts.Node | undefined = node.parent;
  while (p) {
    if (ts.isVariableDeclaration(p)) {
      return p.name.getText(sourceFile);
    }
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return p.left.getText(sourceFile);
    }
    if (ts.isPropertyAssignment(p)) {
      return p.name.getText(sourceFile).replace(/['"]/g, '');
    }
    if (ts.isExportAssignment(p)) {
      return 'default';
    }
    if (ts.isSourceFile(p) || ts.isBlock(p)) break;
    p = p.parent;
  }
  return null;
}

function isOutermostFlowCall(callExpr: ts.CallExpression): boolean {
  const p = callExpr.parent;
  if (p && ts.isPropertyAccessExpression(p)) {
    const grandP = p.parent;
    if (grandP && ts.isCallExpression(grandP) && grandP.expression === p) {
      return false;
    }
  }
  return true;
}

function walkForWorkflows(
  node: ts.Node,
  ctx: WorkflowParseContext,
  outWorkflows: GraphDocument[]
) {
  if (ts.isCallExpression(node)) {
    if (isOutermostFlowCall(node)) {
      const rootFlow = findRootFlowCall(node, ctx.sourceFile);
      if (!rootFlow) {
        let receiver: ts.Expression = node;
        const configuration: ts.CallExpression[] = [];
        while (ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression)) {
          configuration.unshift(receiver);
          receiver = receiver.expression.expression;
        }
        if (ts.isIdentifier(receiver)) {
          const definition = ctx.flowDefinitions.get(receiver.text);
          if (definition?.properties) for (const call of configuration) {
            const method = (call.expression as ts.PropertyAccessExpression).name.text;
            applyFlowProperty(definition.properties, method, [...call.arguments], ctx.sourceFile);
          }
        }
      }
      if (rootFlow) {
        // Inline flows are expanded by their enclosing combinator/flow. They
        // must not become a separate workflow named after the outer variable.
        let ancestor: ts.Node | undefined = node.parent;
        while (ancestor && !ts.isStatement(ancestor) && !ts.isVariableDeclaration(ancestor)) {
          if (ts.isCallExpression(ancestor)) {
            const callee = ancestor.expression;
            const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
            if (['flow', 'pipe', 'parallel', 'all', 'allSettled', 'race', 'map', 'when', 'branch'].includes(name)) return;
          }
          ancestor = ancestor.parent;
        }
        const doc = parseWorkflowChain(node, rootFlow, ctx);
        if (doc && !outWorkflows.some((w) => w.workflowName === doc.workflowName)) {
          outWorkflows.push(doc);
          if (doc.workflowName) {
            const definition = { nodes: doc.nodes, edges: doc.edges, properties: doc.properties };
            ctx.flowDefinitions.set(doc.workflowName, definition);
            const variableName = getEnclosingName(node, ctx.sourceFile);
            if (variableName) ctx.flowDefinitions.set(variableName, definition);
          }
        }
      }
    }
  }
  ts.forEachChild(node, (child) => walkForWorkflows(child, ctx, outWorkflows));
}

function findRootFlowCall(
  callExpr: ts.CallExpression,
  sourceFile: ts.SourceFile
): { call: ts.CallExpression; name: string } | null {
  let curr: ts.Expression = callExpr;
  let rootCall: ts.CallExpression | null = null;

  while (curr) {
    if (ts.isCallExpression(curr)) {
      const expr = curr.expression;
      if (ts.isIdentifier(expr) && (expr.text === 'flow' || expr.text === 'workflow' || expr.text === 'pipe' || expr.text === 'Pipeline')) {
        rootCall = curr;
        break;
      }
      if (ts.isPropertyAccessExpression(expr) && ['Step', 'Func', 'Chain'].includes(expr.expression.getText(sourceFile)) && ['flow', 'pipe'].includes(expr.name.text)) {
        rootCall = curr;
        break;
      }
      if (ts.isPropertyAccessExpression(expr)) {
        curr = expr.expression;
        continue;
      }
      break;
    } else if (ts.isPropertyAccessExpression(curr)) {
      curr = curr.expression;
    } else {
      break;
    }
  }

  if (rootCall) {
    let name = '';
    const firstArg = rootCall.arguments[0];
    if (firstArg) {
      if (ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg)) {
        name = firstArg.text;
      } else if (ts.isObjectLiteralExpression(firstArg)) {
        for (const prop of firstArg.properties) {
          if (
            ts.isPropertyAssignment(prop) &&
            prop.name.getText(sourceFile).replace(/['"]/g, '') === 'name' &&
            (ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer))
          ) {
            name = prop.initializer.text;
          }
        }
      }
    }

    if (!name) {
      const enclosingName = getEnclosingName(callExpr, sourceFile);
      if (enclosingName) {
        name = enclosingName;
      } else {
        const argNames = rootCall.arguments.map((a) => a.getText(sourceFile)).join(', ');
        name = argNames ? `flow(${argNames})` : 'workflow';
      }
    }

    return { call: rootCall, name };
  }

  return null;
}

interface MethodCall {
  methodName: string;
  args: ts.Expression[];
  callExpr: ts.CallExpression;
}

function parseWorkflowChain(
  outerCall: ts.CallExpression,
  rootFlow: { call: ts.CallExpression; name: string },
  ctx: WorkflowParseContext
): GraphDocument | null {
  // Collect the chain of calls from inner rootFlow to outerCall
  const chain: MethodCall[] = [];
  let curr: ts.Expression = outerCall;

  while (curr && curr !== rootFlow.call) {
    if (ts.isCallExpression(curr)) {
      const expr = curr.expression;
      if (ts.isPropertyAccessExpression(expr)) {
        chain.unshift({
          methodName: expr.name.text,
          args: Array.from(curr.arguments),
          callExpr: curr,
        });
        curr = expr.expression;
        continue;
      }
      break;
    } else if (ts.isPropertyAccessExpression(curr)) {
      curr = curr.expression;
    } else {
      break;
    }
  }

  const properties: Record<string, string> = {};
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const unresolved: UnresolvedNode[] = [];
  let currentHeadIds: string[] = [];

  function addNode(detected: DetectedStep): string {
    if (detected.kind === 'node') {
      let nodeToAdd = detected.node;
      // If referencing a known definition, merge definition range
      if (detected.variableName && ctx.stepDefinitions.has(detected.variableName)) {
        const def = ctx.stepDefinitions.get(detected.variableName)!;
        nodeToAdd = {
          ...nodeToAdd,
          name: def.name,
          stepKind: def.stepKind,
          location: def.location,
          declarationRange: def.declarationRange,
          executionConfig: { ...def.executionConfig, ...nodeToAdd.executionConfig },
          properties: { ...def.properties, ...nodeToAdd.properties },
          specs: [...(def.specs || []), ...(nodeToAdd.specs || [])],
        };
      }
      // Check if already in nodes
      const existing = nodes.find((n) => n.id === nodeToAdd.id);
      if (!existing) {
        nodes.push(nodeToAdd);
      }
      return nodeToAdd.id;
    } else {
      unresolved.push(detected.unresolved);
      return detected.unresolved.id;
    }
  }

  function appendSubflow(subflow: { nodes: GraphNode[]; edges: GraphEdge[] }) {
    if (subflow.nodes.length === 0) return;

    for (const n of subflow.nodes) {
      if (!nodes.some((existing) => existing.id === n.id)) {
        nodes.push(n);
      }
    }
    for (const e of subflow.edges) {
      if (!edges.some((existing) => existing.id === e.id)) {
        edges.push(e);
      }
    }

    const entryId = subflow.nodes[0].id;
    const exitId = subflow.nodes[subflow.nodes.length - 1].id;

    for (const headId of currentHeadIds) {
      edges.push({
        id: `edge_${headId}_to_${entryId}_${edges.length}`,
        from: headId,
        to: entryId,
        type: 'sequential',
      });
    }

    currentHeadIds = [exitId];
  }

  function connect(from: string[], to: string, type: GraphEdge['type'] = 'sequential', label?: string) {
    for (const id of new Set(from)) edges.push({
      id: `edge_${id}_to_${to}_${type}_${edges.length}`, from: id, to, type, ...(label ? { label } : {}),
    });
  }

  function junction(expr: ts.Expression, name: string, suffix: string): string {
    const location = getSourceRange(ctx.sourceFile, expr);
    const id = generateDeterministicNodeId(`${name}_${suffix}`, location);
    nodes.push({ id, name, stepKind: 'custom', location, declarationRange: location });
    return id;
  }

  // Expand combinators before step detection: their arguments are graph fragments,
  // and options objects are metadata rather than executable steps.
  function appendExpression(expr: ts.Expression, resolving = new Set<string>()) {
    if (ts.isParenthesizedExpression(expr)) return appendExpression(expr.expression, resolving);
    if (ts.isIdentifier(expr)) {
      const definition = findCombinatorDefinition(expr.text);
      if (definition && !resolving.has(expr.text)) {
        appendExpression(definition, new Set([...resolving, expr.text])); return;
      }
      if (ctx.flowDefinitions.has(expr.text)) {
        appendSubflow(ctx.flowDefinitions.get(expr.text)!); return;
      }
    }
    if (ts.isArrayLiteralExpression(expr)) {
      for (const child of expr.elements) appendExpression(child, resolving);
      return;
    }
    if (ts.isCallExpression(expr)) {
      const callee = expr.expression;
      const kind = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) && ['Step', 'Func', 'Chain'].includes(callee.expression.getText(ctx.sourceFile)) ? callee.name.text : '';
      if (['parallel', 'all', 'race', 'allSettled', 'branch', 'when', 'map'].includes(kind)) {
        const fork = junction(expr, kind, 'fork');
        const forkNode = nodes.find(n => n.id === fork)!;
        forkNode.properties = { operation: kind };
        for (const arg of expr.arguments) if (ts.isObjectLiteralExpression(arg)) Object.assign(forkNode.properties, extractDisplayProperties(arg, ctx.sourceFile));
        if (kind === 'when' || kind === 'branch') forkNode.properties.selector = expr.arguments[0]?.getText(ctx.sourceFile) || 'context route';
        if (kind === 'map') forkNode.properties.items = expr.arguments[0]?.getText(ctx.sourceFile) || 'unknown';
        connect(currentHeadIds, fork);
        const exits: string[] = [];
        const alternatives: { expression: ts.Expression; label?: string }[] = [];
        if (kind === 'branch') {
          const mapIndex = expr.arguments[0] && ts.isObjectLiteralExpression(expr.arguments[0]) ? 0 : 1;
          const map = expr.arguments[mapIndex];
          if (map && ts.isObjectLiteralExpression(map)) {
            for (const property of map.properties) {
              if (ts.isPropertyAssignment(property)) alternatives.push({ expression: property.initializer, label: property.name.getText(ctx.sourceFile).replace(/['"]/g, '') });
              else if (ts.isShorthandPropertyAssignment(property)) alternatives.push({ expression: property.name, label: property.name.text });
            }
          }
          const fallback = expr.arguments[mapIndex + 1];
          if (fallback) alternatives.push({ expression: fallback, label: 'default' });
        } else if (kind === 'when') {
          if (expr.arguments[1]) alternatives.push({ expression: expr.arguments[1], label: 'then' });
          if (expr.arguments[2]) alternatives.push({ expression: expr.arguments[2], label: 'else' });
          else exits.push(fork); // False predicate skips the then path.
        } else if (kind === 'map') {
          if (expr.arguments[1]) alternatives.push({ expression: expr.arguments[1], label: 'each item' });
        } else {
          for (const arg of expr.arguments) {
            if (ts.isObjectLiteralExpression(arg)) continue;
            for (const child of ts.isArrayLiteralExpression(arg) ? arg.elements : [arg]) alternatives.push({ expression: child });
          }
        }
        for (const alternative of alternatives) {
          currentHeadIds = [fork];
          const edgeStart = edges.length;
          appendExpression(alternative.expression, resolving);
          for (const edge of edges.slice(edgeStart)) if (edge.from === fork) {
            edge.type = kind === 'branch' || kind === 'when' ? 'branch' : 'parallel';
            edge.label = alternative.label || kind;
          }
          exits.push(...currentHeadIds);
        }
        const join = junction(expr, `${kind} join`, 'join');
        connect(exits.length ? exits : [fork], join);
        currentHeadIds = [join];
        return;
      }
      if (['flow', 'workflow', 'pipe', 'Pipeline'].includes(kind)) {
        for (const child of expr.arguments) {
          if (!ts.isStringLiteral(child) && !ts.isObjectLiteralExpression(child)) appendExpression(child, resolving);
        }
        return;
      }
    }
    const detected = detectStepFromExpression(expr, ctx.sourceFile);
    if (detected) {
      const id = addNode(detected);
      connect(currentHeadIds, id);
      currentHeadIds = [id];
    }
  }

  function findCombinatorDefinition(name: string): ts.Expression | undefined {
    let result: ts.Expression | undefined;
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(ctx.sourceFile) === name && node.initializer && ts.isCallExpression(node.initializer) && ['parallel', 'all', 'race', 'allSettled', 'branch', 'when', 'map'].includes(ts.isIdentifier(node.initializer.expression) ? node.initializer.expression.text : ts.isPropertyAccessExpression(node.initializer.expression) && ['Step', 'Func', 'Chain'].includes(node.initializer.expression.expression.getText(ctx.sourceFile)) ? node.initializer.expression.name.text : '')) result = node.initializer;
      ts.forEachChild(node, visit);
    }
    visit(ctx.sourceFile);
    return result;
  }

  for (const arg of rootFlow.call.arguments) {
    if (!ts.isStringLiteral(arg) && !ts.isNoSubstitutionTemplateLiteral(arg) && !ts.isObjectLiteralExpression(arg)) appendExpression(arg);
  }

  // 2. Process chained methods (.then, .parallel, .branch, .fallback, .compensate)
  for (const item of chain) {
    const { methodName, args } = item;
    applyFlowProperty(properties, methodName, args, ctx.sourceFile);
    if (methodName === 'then') {
      for (const arg of args) appendExpression(arg);
    } else if (methodName === 'parallel') {
      const arg = args[0];
      const nextHeadIds: string[] = [];
      if (arg && ts.isArrayLiteralExpression(arg)) {
        for (const el of arg.elements) {
          if (ts.isIdentifier(el) && ctx.flowDefinitions.has(el.text)) {
            const sub = ctx.flowDefinitions.get(el.text)!;
            if (sub.nodes.length > 0) {
              for (const n of sub.nodes) {
                if (!nodes.some((existing) => existing.id === n.id)) nodes.push(n);
              }
              for (const e of sub.edges) {
                if (!edges.some((existing) => existing.id === e.id)) edges.push(e);
              }
              const entryId = sub.nodes[0].id;
              const exitId = sub.nodes[sub.nodes.length - 1].id;
              for (const headId of currentHeadIds) {
                edges.push({
                  id: `edge_${headId}_to_${entryId}_parallel`,
                  from: headId,
                  to: entryId,
                  type: 'parallel',
                });
              }
              nextHeadIds.push(exitId);
            }
            continue;
          }

          const detected = detectStepFromExpression(el, ctx.sourceFile);
          if (detected) {
            const nextId = addNode(detected);
            nextHeadIds.push(nextId);
            for (const headId of currentHeadIds) {
              edges.push({
                id: `edge_${headId}_to_${nextId}_parallel`,
                from: headId,
                to: nextId,
                type: 'parallel',
              });
            }
          }
        }
      }
      if (nextHeadIds.length > 0) {
        currentHeadIds = nextHeadIds;
      }
    } else if (methodName === 'branch') {
      const conditionExpr = args[0];
      const trueArg = args[1];
      const falseArg = args[2];
      const conditionLabel = conditionExpr ? conditionExpr.getText(ctx.sourceFile) : undefined;
      const nextHeadIds: string[] = [];

      if (trueArg) {
        const detected = detectStepFromExpression(trueArg, ctx.sourceFile);
        if (detected) {
          const trueId = addNode(detected);
          nextHeadIds.push(trueId);
          for (const headId of currentHeadIds) {
            edges.push({
              id: `edge_${headId}_to_${trueId}_branch_true`,
              from: headId,
              to: trueId,
              type: 'branch',
              label: conditionLabel ? `true: ${conditionLabel}` : 'true',
            });
          }
        }
      }

      if (falseArg) {
        const detected = detectStepFromExpression(falseArg, ctx.sourceFile);
        if (detected) {
          const falseId = addNode(detected);
          nextHeadIds.push(falseId);
          for (const headId of currentHeadIds) {
            edges.push({
              id: `edge_${headId}_to_${falseId}_branch_false`,
              from: headId,
              to: falseId,
              type: 'branch',
              label: conditionLabel ? `false: !(${conditionLabel})` : 'false',
            });
          }
        }
      }

      if (nextHeadIds.length > 0) {
        currentHeadIds = nextHeadIds;
      }
    } else if (methodName === 'fallback') {
      const arg = args[0];
      if (arg) {
        const detected = detectStepFromExpression(arg, ctx.sourceFile);
        if (detected) {
          const fallbackId = addNode(detected);
          for (const headId of currentHeadIds) {
            edges.push({
              id: `edge_${headId}_to_${fallbackId}_fallback`,
              from: headId,
              to: fallbackId,
              type: 'fallback',
            });
          }
          currentHeadIds.push(fallbackId);
        }
      }
    } else if (methodName === 'compensate') {
      const arg = args[0];
      if (arg) {
        const detected = detectStepFromExpression(arg, ctx.sourceFile);
        if (detected) {
          const compId = addNode(detected);
          for (const headId of currentHeadIds) {
            edges.push({
              id: `edge_${headId}_to_${compId}_comp`,
              from: headId,
              to: compId,
              type: 'compensation',
            });
          }
        }
      }
    }
  }

  const routeEdges = new Map<string, GraphEdge>();
  const normalizedEdges: GraphEdge[] = [];
  for (const edge of edges) {
    const key = JSON.stringify([edge.from, edge.to, edge.type]);
    const existing = routeEdges.get(key);
    if (existing) {
      if (edge.label && edge.label !== existing.label) existing.label = existing.label ? `${existing.label} / ${edge.label}` : edge.label;
    } else {
      const normalized = { ...edge, id: `edge_${normalizedEdges.length}_${edge.from}_to_${edge.to}_${edge.type}` };
      routeEdges.set(key, normalized);
      normalizedEdges.push(normalized);
    }
  }
  const diagnostics = runDiagnostics(nodes, normalizedEdges);

  return {
    uri: ctx.uri,
    documentVersion: ctx.documentVersion,
    workflowName: rootFlow.name,
    properties,
    nodes,
    edges: normalizedEdges,
    unresolved,
    diagnostics,
  };
}

export function runDiagnostics(nodes: GraphNode[], edges: GraphEdge[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  // 1. Detect duplicate node IDs
  const idCounts = new Map<string, number>();
  for (const node of nodes) {
    idCounts.set(node.id, (idCounts.get(node.id) || 0) + 1);
  }
  for (const node of nodes) {
    if ((idCounts.get(node.id) || 0) > 1) {
      diagnostics.push({
        code: 'SIGLO_DUPLICATE_STEP_ID',
        message: `Duplicate step ID detected: "${node.id}"`,
        severity: 'error',
        range: node.location,
      });
    }
  }

  // 2. Detect cycles in graph edges
  const adj = new Map<string, string[]>();
  for (const edge of edges) {
    if (!adj.has(edge.from)) adj.set(edge.from, []);
    adj.get(edge.from)!.push(edge.to);
  }

  const visited = new Set<string>();
  const recStack = new Set<string>();
  const cycleNodes = new Set<string>();

  function dfs(nodeId: string) {
    visited.add(nodeId);
    recStack.add(nodeId);

    const neighbors = adj.get(nodeId) || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        dfs(neighbor);
      } else if (recStack.has(neighbor)) {
        cycleNodes.add(neighbor);
        cycleNodes.add(nodeId);
      }
    }
    recStack.delete(nodeId);
  }

  for (const node of nodes) {
    if (!visited.has(node.id)) {
      dfs(node.id);
    }
  }

  if (cycleNodes.size > 0) {
    for (const node of nodes) {
      if (cycleNodes.has(node.id)) {
        diagnostics.push({
          code: 'SIGLO_STATIC_CYCLE',
          message: `Cyclic workflow dependency detected involving step "${node.name}"`,
          severity: 'error',
          range: node.location,
        });
      }
    }
  }

  // 3. Detect side-effect steps lacking compensation in sagas
  const hasAnyCompensationEdge = edges.some((e) => e.type === 'compensation');
  if (hasAnyCompensationEdge) {
    for (const node of nodes) {
      if ((node.stepKind === 'http' || node.stepKind === 'crypto') && !node.executionConfig?.hasCompensation) {
        const hasOutCompensation = edges.some((e) => e.from === node.id && e.type === 'compensation');
        if (!hasOutCompensation) {
          diagnostics.push({
            code: 'SIGLO_MISSING_COMPENSATION',
            message: `Saga step "${node.name}" performs side effects without a registered compensation step`,
            severity: 'warning',
            range: node.location,
            fixAvailable: true,
          });
        }
      }
    }
  }

  return diagnostics;
}


function applyFlowProperty(properties: Record<string, string>, method: string, args: ts.Expression[], sourceFile: ts.SourceFile) {
  const arg = args[0];
  if (!arg && method !== 'networkPolicy') return;
  const value = arg ? (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) ? arg.text : arg.getText(sourceFile)) : 'undefined';
  if (method === 'timeout') properties.timeoutMs = value;
  else if (method === 'version') properties.workflowVersion = value;
  else if (method === 'monitor') properties.monitor = value;
  else if (method === 'networkPolicy') {
    for (const key of Object.keys(properties)) if (key.startsWith('network.')) delete properties[key];
    const defaults = { 'network.enabled': 'true', 'network.defaultPolicy': 'deny', 'network.allowedHosts': 'No hosts configured', 'network.allowLocalhost': 'false' };
    if (!arg || ts.isIdentifier(arg) && arg.text === 'undefined') Object.assign(properties, defaults);
    else if (ts.isObjectLiteralExpression(arg)) {
      if (!arg.properties.some(prop => ts.isSpreadAssignment(prop))) Object.assign(properties, defaults);
      for (const prop of arg.properties) {
        if (ts.isSpreadAssignment(prop)) properties['network.source'] = value;
        if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
          const key = prop.name.getText(sourceFile).replace(/['"]/g, '');
          if (['enabled', 'defaultPolicy', 'allowedHosts', 'allowLocalhost', 'allowUnixSockets'].includes(key)) {
            const expression = ts.isPropertyAssignment(prop) ? prop.initializer : prop.name;
            properties[`network.${key}`] = ts.isArrayLiteralExpression(expression) ? expression.elements.map(e => ts.isStringLiteral(e) ? e.text : e.getText(sourceFile)).join('\n') || 'No entries' : ts.isStringLiteral(expression) ? expression.text : expression.getText(sourceFile);
          }
        }
      }
    } else properties['network.source'] = value;
  }
}
