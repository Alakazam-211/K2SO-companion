import { Component, type ErrorInfo, type ReactNode } from "react";

/** A throw in a pane must not unmount the rest of the app. */
export class PaneErrorBoundary extends Component<
  { name: string; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`PaneErrorBoundary(${this.props.name})`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          className="flex-1 min-h-0 overflow-auto p-3 text-[12px] text-[var(--warning)]"
          data-testid="pane-error"
        >
          {this.props.name}: {this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}