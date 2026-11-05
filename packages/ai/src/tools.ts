import { Step, networkPolicyStorage } from '@siglo/core';
import type { ExecutionOptions } from '@siglo/core';
import { validatePayload } from '@siglo/http';
import { resolveJsonSchema } from './schema';
import { getExecutionSignal } from './execution';
import type { AiTool } from './types';

export function defineAiTool<C, A, I, O>(tool: AiTool<C, A, I, O>): AiTool<C, A, I, O> {
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(tool.name)) throw new TypeError('Invalid AI tool name');
  return tool;
}

export function describeAiTools(tools: AiTool[]) {
  const names = new Set<string>();
  return tools.map(tool => {
    defineAiTool(tool);
    if (names.has(tool.name)) throw new TypeError(`Duplicate AI tool: ${tool.name}`);
    names.add(tool.name);
    return { name: tool.name, description: tool.description,
      parameters: resolveJsonSchema(tool.inputSchema, tool.jsonSchema, 'input') };
  });
}

/** Run sequentially from the agent loop. Never call step.action directly. */
export async function executeAiTool<C, A, I, O>(
  tool: AiTool<C, A, I, O>, args: unknown, ctx: C,
  options: Pick<ExecutionOptions, 'stackId' | 'signal' | 'namespace' | 'services' | 'monitor'>
): Promise<unknown> {
  if (!options.stackId) throw new TypeError('AI tools require the parent workflow stackId');
  const signal = options.signal ?? getExecutionSignal(ctx as Parameters<typeof getExecutionSignal>[0]);
  signal?.throwIfAborted();
  const validated = await validatePayload<A>(tool.inputSchema, args, 'validation', tool.name);
  signal?.throwIfAborted();
  const input = tool.mapInput(validated, ctx);
  // Pass the enclosing effective policy explicitly: a nested runner must not widen it.
  const policy = networkPolicyStorage.getStore();
  const result = await Step.start(tool.step, input, { ...options, signal, pojo: true, networkPolicy: policy });
  // Expose the tool's output snapshot, not workflow history or execution metadata.
  return result.$steps[tool.step.name];
}
