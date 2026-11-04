import type { StandardSchemaV1 } from '@siglo/http';
import type { AiOutput, AiStepResult, AiStepOptions } from '../src';
import { defineAiTool, aiStep } from '../src';
import { Step } from 'siglo';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
export type InputInference = Assert<Equal<StandardSchemaV1.InferInput<StandardSchemaV1<string, number>>, string>>;
export type OutputInference = Assert<Equal<AiOutput<StandardSchemaV1<string, number>>, number>>;
export type NoSchema = Assert<Equal<AiOutput<undefined>, string>>;
export type ResultData = Assert<Equal<AiStepResult<number[]>['data'], number[]>>;

declare const schema: StandardSchemaV1<unknown, { count: number }>;
const tool = defineAiTool({ name: 'count', description: 'count', inputSchema: schema,
  step: Step.create('count', (input: { n: number }) => ({ value: input.n })),
  mapInput: (args, _ctx: { user: string }) => ({ n: args.count }) });
// @ts-expect-error Tool argument types must survive inference.
tool.mapInput({ count: 'wrong' }, { user: 'x' });
// @ts-expect-error Wrapped primitive output cannot be treated as a flattened object.
const invalidResult: AiStepResult<number> = { data: 'text' };
void invalidResult;

const inferred = aiStep('typed', { model: { provider: 'openai', model: 'test' }, prompt: 'x', schema,
  enforceNativeStructuredOutputs: false });
export type FactoryInference = Assert<Equal<Awaited<ReturnType<typeof inferred.action>>['data'], { count: number }>>;
const plain = aiStep('plain', { model: { provider: 'openai', model: 'test' }, prompt: (ctx: { query: string }) => ctx.query });
export type PlainInference = Assert<Equal<Awaited<ReturnType<typeof plain.action>>['data'], string>>;
// @ts-expect-error Factory must preserve input types.
plain.action({ query: 42 });

declare const configured: AiStepOptions<{ query: string }, StandardSchemaV1<string, number>>;
const optionalSchema = aiStep('configured', configured);
export type OptionalSchemaInference = Assert<Equal<Awaited<ReturnType<typeof optionalSchema.action>>['data'], string | number>>;
