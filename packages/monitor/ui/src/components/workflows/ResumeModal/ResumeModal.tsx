import React, { useState, useEffect } from 'react';
import { Modal } from '../../ui/Modal';
import { Play, AlertCircle } from 'lucide-react';

interface ResumeModalProps {
  stackId: string;
  waitingForEvent?: string | null;
  isOpen: boolean;
  onClose: () => void;
  onResume: (key: string, eventName: string, payload: any) => Promise<void>;
}

export const ResumeModal: React.FC<ResumeModalProps> = ({
  stackId,
  waitingForEvent,
  isOpen,
  onClose,
  onResume
}) => {
  const [key, setKey] = useState(stackId);
  const [eventName, setEventName] = useState(waitingForEvent || '');
  const [payloadText, setPayloadText] = useState('{\n  "resumedBy": "dashboard"\n}');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setKey(stackId);
      setEventName(waitingForEvent || '');
      setJsonError(null);
    }
  }, [isOpen, stackId, waitingForEvent]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setJsonError(null);

    let parsedPayload = {};
    if (payloadText.trim()) {
      try {
        parsedPayload = JSON.parse(payloadText);
      } catch (err: any) {
        setJsonError('Invalid JSON format: ' + err.message);
        return;
      }
    }

    try {
      setIsSubmitting(true);
      await onResume(key.trim(), eventName.trim(), parsedPayload);
      onClose();
    } catch (err: any) {
      setJsonError(err?.message || 'Failed to resume workflow');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Resume Suspended Flow"
      subtitle={`Stack: ${stackId}`}
      icon={
        <div className="p-1.5 rounded-lg bg-amber-500/10 text-amber-400">
          <Play className="w-4 h-4 fill-current" />
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-slate-300 mb-1.5">
            Key
          </label>
          <input
            type="text"
            required
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Stack ID or correlation key"
            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-amber-500 focus:border-amber-500 transition-colors"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-300 mb-1.5">
            Event Signal Name
          </label>
          <input
            type="text"
            required
            value={eventName}
            onChange={(e) => setEventName(e.target.value)}
            placeholder="e.g. payment.confirmed, order.approved"
            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-amber-500 focus:border-amber-500 transition-colors"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-300 mb-1.5">
            Payload (JSON)
          </label>
          <textarea
            rows={4}
            value={payloadText}
            onChange={(e) => setPayloadText(e.target.value)}
            className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-xs font-mono text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-amber-500 focus:border-amber-500 transition-colors"
          />
        </div>

        {jsonError && (
          <div className="flex items-center gap-2 p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{jsonError}</span>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSubmitting}
            className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-slate-950 transition-colors disabled:opacity-50 flex items-center gap-1.5 shadow-sm"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>{isSubmitting ? 'Resuming...' : 'Dispatch Signal'}</span>
          </button>
        </div>
      </form>
    </Modal>
  );
};
