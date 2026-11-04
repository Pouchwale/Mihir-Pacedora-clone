import { Component, type ReactNode } from "react";

/** A crash in one page (the 3D viewer, mostly) shows a short note and a reload button instead of a blank window. */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="msg bad" style={{ margin: 24 }}>
        Something went wrong: {this.state.error.message}{" "}
        <button className="link" onClick={() => window.location.reload()}>Reload the page</button>
      </div>
    );
  }
}
