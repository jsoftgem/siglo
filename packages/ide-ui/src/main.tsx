import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';

class ErrorBoundary extends React.Component<
    { children: React.ReactNode },
    { hasError: boolean; error: Error | null }
> {
    constructor(props: { children: React.ReactNode }) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error) {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
        console.error('[Siglo Workflows UI Crash]:', error, errorInfo);
    }

    render() {
        if (this.state.hasError) {
            return (
                <div className="flex flex-col items-center justify-center h-screen bg-[#1e1f22] text-[#bcbec4] p-8 text-center select-none font-sans">
                    <div className="p-4 rounded-lg bg-rose-950/40 border border-rose-800/60 max-w-md w-full space-y-3">
                        <div className="text-rose-400 font-semibold text-sm">Visualizer Render Error</div>
                        <div className="text-xs text-[#dfe1e5] font-mono break-all bg-[#1e1f22] p-2.5 rounded border border-[#393b40] text-left overflow-auto max-h-36">
                            {this.state.error?.message || 'An unexpected error occurred rendering the workflow.'}
                        </div>
                        <button
                            onClick={() => window.location.reload()}
                            className="px-3 py-1.5 rounded bg-[#393b40] hover:bg-[#4e5157] text-[#dfe1e5] text-xs font-medium transition-colors"
                        >
                            Reload Visualizer
                        </button>
                    </div>
                </div>
            );
        }
        return this.props.children;
    }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <ErrorBoundary>
            <App />
        </ErrorBoundary>
    </React.StrictMode>,
);
