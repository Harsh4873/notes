import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Rendered when a descendant throws. `reset` clears the error and retries. */
  fallback: (reset: () => void) => ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Keeps a thrown render/effect error from unmounting the whole app. Scope this
 * around risky subtrees (e.g. the rich text editor) so a fault degrades to a
 * recoverable message instead of a blank screen. Remount with a `key` to reset
 * automatically when the underlying subject changes.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return this.props.fallback(this.reset);
    }
    return this.props.children;
  }
}
