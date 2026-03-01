import { Component, type ErrorInfo, type ReactNode } from "react";
import { Clipboard, ClipboardCheck } from "lucide-react";

import { writeClipboard } from "@/lib/utils";

type Props = { children: ReactNode };
type State = { error: Error | null; copied: boolean };

export class ErrorBoundary extends Component<Props, State> {
    state: State = { error: null, copied: false };
    private copyTimer: ReturnType<typeof setTimeout> | null = null;

    static getDerivedStateFromError(error: Error): State {
        return { error, copied: false };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error("[ErrorBoundary]", error, info.componentStack);
    }

    componentWillUnmount() {
        if (this.copyTimer) clearTimeout(this.copyTimer);
    }

    private copyError = async () => {
        const error = this.state.error;
        if (!error) return;
        const text = `${error.name}: ${error.message}\n\n${error.stack ?? ""}`;
        if (await writeClipboard(text)) {
            if (this.copyTimer) clearTimeout(this.copyTimer);
            this.setState({ copied: true });
            this.copyTimer = setTimeout(
                () => this.setState({ copied: false }),
                1500,
            );
        }
    };

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
                            <div className="flex items-center justify-between">
                                <h3 className="text-xs font-medium text-muted-foreground">
                                    Source
                                </h3>
                                <button
                                    type="button"
                                    onClick={this.copyError}
                                    className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                                >
                                    {this.state.copied ? (
                                        <ClipboardCheck className="size-3.5" />
                                    ) : (
                                        <Clipboard className="size-3.5" />
                                    )}
                                    {this.state.copied ? "Copied" : "Copy"}
                                </button>
                            </div>
                            <pre className="dev-scrollbar max-h-48 overflow-auto rounded-lg border border-border bg-muted/20 p-4 font-mono text-xs leading-relaxed text-muted-foreground">
                                {this.state.error.stack}
                            </pre>
                        </div>
                    )}
                    <button
                        type="button"
                        onClick={() =>
                            this.setState({ error: null, copied: false })
                        }
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
