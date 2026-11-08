import React from 'react';
import { LucideIcon } from 'lucide-react';

interface EmptyStateProps {
    icon: LucideIcon;
    title: string;
    description?: string;
    children?: React.ReactNode;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ icon: Icon, title, description, children }) => {
    return (
        <div className="flex flex-col items-center justify-center p-8 text-center text-slate-500">
            <div className="p-3 rounded-2xl bg-slate-900 border border-slate-800 text-slate-400 mb-3 shadow-inner">
                <Icon className="w-6 h-6 opacity-80" />
            </div>
            <h3 className="font-semibold text-slate-200 text-sm mb-1">{title}</h3>
            {description && <p className="text-xs text-slate-400 max-w-sm mb-4 leading-relaxed">{description}</p>}
            {children}
        </div>
    );
};
