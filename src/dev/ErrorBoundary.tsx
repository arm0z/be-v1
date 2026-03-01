import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
    state: State = { error: null };

    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error("[ErrorBoundary]", error, info.componentStack);
    }

    render() {
        if (this.state.error) {
            return (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                    <p className="text-sm font-medium text-destructive">
                        Something went wrong
                    </p>
                    <pre className="max-w-full overflow-auto rounded border bg-muted/30 p-2 text-xs text-muted-foreground">
                        {this.state.error.message}
                    </pre>
                    <button
                        type="button"
                        onClick={() => this.setState({ error: null })}
                        className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
                    >
                        Retry
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}
