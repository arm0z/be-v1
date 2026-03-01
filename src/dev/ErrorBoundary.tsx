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
                <div className="flex h-full flex-col justify-center gap-6 p-8">
                    <div className="flex flex-col gap-2">
                        <h2 className="text-sm font-semibold text-foreground">
                            Unhandled Runtime Error
                        </h2>
                        <p className="font-mono text-sm text-muted-foreground">
                            {this.state.error.name}: {this.state.error.message}
                        </p>
                    </div>
                    {this.state.error.stack && (
                        <div className="flex flex-col gap-2">
                            <h3 className="text-xs font-medium text-muted-foreground">
                                Source
                            </h3>
                            <pre className="dev-scrollbar max-h-48 overflow-auto rounded-lg border border-border bg-muted/20 p-4 font-mono text-xs leading-relaxed text-muted-foreground">
                                {this.state.error.stack}
                            </pre>
                        </div>
                    )}
                    <button
                        type="button"
                        onClick={() => this.setState({ error: null })}
                        className="w-fit rounded-md border border-border bg-foreground px-4 py-2 text-xs font-medium text-background transition-colors hover:bg-foreground/90"
                    >
                        Try again
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}
