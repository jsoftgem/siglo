import { type GraphQLResolveInfo, Kind, type SelectionSetNode } from 'graphql';

export interface WorkflowSelectionFlags {
    selectedFields: Set<string>;
    hasContext: boolean;
    hasSteps: boolean;
    hasMetadata: boolean;
    includeContext: boolean;
    contextPath?: string;
}

export function getWorkflowExecutionSelections(info: GraphQLResolveInfo): {
    fields: Set<string>;
    contextPath?: string;
} {
    const fields = new Set<string>();
    const fragments = info.fragments;
    let contextPath: string | undefined;

    function visitSelections(selectionSet: SelectionSetNode | undefined, inNode: boolean) {
        if (!selectionSet) return;
        for (const sel of selectionSet.selections) {
            if (sel.kind === Kind.FIELD) {
                const name = sel.name.value;
                if (inNode) {
                    fields.add(name);
                    if (name === 'context' && contextPath === undefined) {
                        const pathArg = sel.arguments?.find(a => a.name.value === 'path');
                        if (pathArg && pathArg.value.kind === Kind.STRING) {
                            contextPath = pathArg.value.value;
                        }
                    }
                }
                if (name === 'node' || info.fieldName === 'workflow') {
                    visitSelections(sel.selectionSet, true);
                } else {
                    visitSelections(sel.selectionSet, inNode);
                }
            } else if (sel.kind === Kind.INLINE_FRAGMENT) {
                const isWorkflowExecution = sel.typeCondition?.name.value === 'WorkflowExecution';
                visitSelections(sel.selectionSet, inNode || isWorkflowExecution);
            } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
                const frag = fragments?.[sel.name.value];
                if (frag) {
                    const isWorkflowExecution = frag.typeCondition?.name.value === 'WorkflowExecution';
                    visitSelections(frag.selectionSet, inNode || isWorkflowExecution);
                }
            }
        }
    }

    for (const fieldNode of info.fieldNodes) {
        if (info.fieldName === 'workflow') {
            visitSelections(fieldNode.selectionSet, true);
        } else {
            visitSelections(fieldNode.selectionSet, false);
        }
    }

    return { fields, contextPath };
}

export function getWorkflowSelectionFlags(info: GraphQLResolveInfo): WorkflowSelectionFlags {
    const { fields, contextPath } = getWorkflowExecutionSelections(info);
    const hasContext = fields.has('context');
    const hasSteps = fields.has('steps');
    const hasMetadata = fields.has('metadata');
    return {
        selectedFields: fields,
        hasContext,
        hasSteps,
        hasMetadata,
        includeContext: hasContext || hasSteps,
        contextPath,
    };
}
