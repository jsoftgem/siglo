import { buildSchema, GraphQLObjectType, type GraphQLSchema, type ValueNode } from 'graphql';
import type { WorkflowQueryEngine } from '../engine';
import type { WorkflowGraphQLSchemaOptions } from '../types';
import { createResolvers } from './resolvers';
import { GraphQLDateTime, GraphQLJSON } from './scalars';

export const WORKFLOW_SCHEMA_SDL = `
scalar JSON
scalar DateTime

enum WorkflowStatus {
  RUNNING
  WAITING
  COMPLETED
  FAILED
  CANCELLED
}

enum SortDirection {
  ASC
  DESC
}

enum WorkflowSortField {
  CREATED_AT
  UPDATED_AT
  STATUS
  REVISION
}

"""
Represents a single workflow execution instance.
"""
type WorkflowExecution {
  stackId: ID!
  workflowId: String
  namespace: String
  status: WorkflowStatus!
  revision: Int!
  createdAt: DateTime!
  updatedAt: DateTime!
  expiresAt: DateTime

  """
  Promoted top-level metadata passed during workflow initialization.
  """
  metadata: JSON

  """
  Materialized accumulated context across all completed steps.
  Supports optional JSONPath filtering and security redaction.
  """
  context(path: String, redact: Boolean = true): JSON

  """
  Execution breakdown of completed and in-flight steps.
  """
  steps: [StepExecution!]!

  """
  Active suspension state if status is WAITING.
  """
  waitRecord: WaitRecord

  """
  Registered saga compensation records if configured.
  """
  compensations: [CompensationRecord!]!
}

type StepExecution {
  stepId: ID!
  name: String!
  status: String!
  output(redact: Boolean = true): JSON
}

type WaitRecord {
  correlationKey: String!
  eventName: String
  expiresAt: DateTime
  lockedBy: String
}

type CompensationRecord {
  stepId: String!
  stepName: String!
  status: String!
}

input WorkflowFilterInput {
  workflowId: String
  namespace: String
  status: WorkflowStatus
  createdAfter: DateTime
  createdBefore: DateTime
  correlationKey: String
  """Filter against promoted metadata fields (e.g. { orderId: "ord_123" })"""
  metadata: JSON
}

input WorkflowSortInput {
  field: WorkflowSortField! = CREATED_AT
  direction: SortDirection! = DESC
}

input PaginationInput {
  limit: Int = 20
  cursor: String
}

type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}

type WorkflowEdge {
  cursor: String!
  node: WorkflowExecution!
}

type WorkflowConnection {
  edges: [WorkflowEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

type Query {
  """
  Retrieve a single workflow execution by its unique stackId.
  """
  workflow(stackId: ID!, namespace: String): WorkflowExecution

  """
  Query and filter workflow executions with cursor-based pagination.
  """
  workflows(
    filter: WorkflowFilterInput
    sort: WorkflowSortInput
    pagination: PaginationInput
  ): WorkflowConnection!
}

type Mutation {
  """
  Resume a suspended durable workflow waiting on an external event.
  """
  resumeWorkflow(
    correlationKey: String!
    payload: JSON
    namespace: String
  ): Boolean!

  """
  Cancel an active or waiting workflow execution stack.
  """
  cancelWorkflow(stackId: ID!, reason: String): Boolean!
}

type Subscription {
  """
  Subscribe to real-time status transitions and context updates for a workflow.
  """
  workflowUpdated(stackId: ID!, namespace: String): WorkflowExecution!

  """
  Subscribe to workflow completion or failure events within a namespace.
  """
  workflowCompleted(namespace: String!): WorkflowExecution!
}
`;

export function createWorkflowGraphQLSchema(
    engine: WorkflowQueryEngine,
    options?: WorkflowGraphQLSchemaOptions,
): GraphQLSchema {
    const schema = buildSchema(WORKFLOW_SCHEMA_SDL);

    const jsonType = schema.getType('JSON');
    if (jsonType) {
        const serializeJson = (val: unknown) => GraphQLJSON.serialize(val);
        const parseValueJson = (val: unknown) => GraphQLJSON.parseValue(val);
        const parseLiteralJson = (ast: ValueNode, vars?: Record<string, unknown> | null) =>
            GraphQLJSON.parseLiteral(ast, vars);
        Object.assign(jsonType, {
            serialize: serializeJson,
            coerceOutputValue: serializeJson,
            parseValue: parseValueJson,
            coerceInputValue: parseValueJson,
            parseLiteral: parseLiteralJson,
        });
    }

    const dateTimeType = schema.getType('DateTime');
    if (dateTimeType) {
        const serializeDateTime = (val: unknown) => GraphQLDateTime.serialize(val);
        const parseValueDateTime = (val: unknown) => GraphQLDateTime.parseValue(val);
        const parseLiteralDateTime = (ast: ValueNode, vars?: Record<string, unknown> | null) =>
            GraphQLDateTime.parseLiteral(ast, vars);
        Object.assign(dateTimeType, {
            serialize: serializeDateTime,
            coerceOutputValue: serializeDateTime,
            parseValue: parseValueDateTime,
            coerceInputValue: parseValueDateTime,
            parseLiteral: parseLiteralDateTime,
        });
    }

    const resolvers = createResolvers(engine, options);

    const queryType = schema.getType('Query');
    if (queryType instanceof GraphQLObjectType) {
        const queryFields = queryType.getFields();
        if (queryFields.workflow) queryFields.workflow.resolve = resolvers.Query.workflow;
        if (queryFields.workflows) queryFields.workflows.resolve = resolvers.Query.workflows;
    }

    const mutationType = schema.getType('Mutation');
    if (mutationType instanceof GraphQLObjectType) {
        const mutationFields = mutationType.getFields();
        if (mutationFields.resumeWorkflow) mutationFields.resumeWorkflow.resolve = resolvers.Mutation.resumeWorkflow;
        if (mutationFields.cancelWorkflow) mutationFields.cancelWorkflow.resolve = resolvers.Mutation.cancelWorkflow;
    }

    const subscriptionType = schema.getType('Subscription');
    if (subscriptionType instanceof GraphQLObjectType) {
        const subFields = subscriptionType.getFields();
        if (subFields.workflowUpdated) {
            subFields.workflowUpdated.subscribe = resolvers.Subscription.workflowUpdated.subscribe;
            subFields.workflowUpdated.resolve = resolvers.Subscription.workflowUpdated.resolve;
        }
        if (subFields.workflowCompleted) {
            subFields.workflowCompleted.subscribe = resolvers.Subscription.workflowCompleted.subscribe;
            subFields.workflowCompleted.resolve = resolvers.Subscription.workflowCompleted.resolve;
        }
    }

    const executionType = schema.getType('WorkflowExecution');
    if (executionType instanceof GraphQLObjectType) {
        const execFields = executionType.getFields();
        if (execFields.status) execFields.status.resolve = resolvers.WorkflowExecution.status;
        if (execFields.context) execFields.context.resolve = resolvers.WorkflowExecution.context;
        if (execFields.steps) execFields.steps.resolve = resolvers.WorkflowExecution.steps;
        if (execFields.waitRecord) execFields.waitRecord.resolve = resolvers.WorkflowExecution.waitRecord;
        if (execFields.compensations) execFields.compensations.resolve = resolvers.WorkflowExecution.compensations;
    }

    const stepType = schema.getType('StepExecution');
    if (stepType instanceof GraphQLObjectType) {
        const stepFields = stepType.getFields();
        if (stepFields.output) stepFields.output.resolve = resolvers.StepExecution.output;
    }

    return schema;
}
