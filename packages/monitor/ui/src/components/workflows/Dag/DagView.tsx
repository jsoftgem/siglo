import React, { useState } from 'react';
import { StepRun } from '../../../types';
import { DagNode } from './DagNode';
import { StepDetailCard } from './StepDetailCard';
import { EmptyState } from '../../ui/EmptyState';
import { Clock, ArrowRight } from 'lucide-react';

interface DagViewProps {
  steps: Record<string, StepRun>;
}

export const DagView: React.FC<DagViewProps> = ({ steps }) => {
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const stepList = Object.values(steps || {});

  if (stepList.length === 0) {
    return (
      <EmptyState
        icon={Clock}
        title="Awaiting Step Execution"
        description="Steps will appear dynamically in real time as the execution progresses."
      />
    );
  }

  const selectedStep = selectedStepId ? steps[selectedStepId] : null;

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto pb-4 pt-2">
        <div className="flex items-center gap-3 min-w-max px-2">
          {stepList.map((step, idx) => {
            const isSelected = selectedStepId === step.stepId;
            return (
              <React.Fragment key={step.stepId}>
                {idx > 0 && (
                  <div className="flex items-center text-slate-600">
                    <ArrowRight className="w-5 h-5" />
                  </div>
                )}
                <DagNode
                  step={step}
                  isSelected={isSelected}
                  onSelect={(id) => setSelectedStepId(selectedStepId === id ? null : id)}
                />
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {selectedStep && (
        <StepDetailCard
          step={selectedStep}
          onClose={() => setSelectedStepId(null)}
        />
      )}
    </div>
  );
};
