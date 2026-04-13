import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error.message, error.stack);
    console.error("[ErrorBoundary] componentStack:", info.componentStack);
    document.title = `ERR: ${error.message}`;
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ background: "#000", color: "#f44", padding: 16, fontFamily: "monospace", fontSize: 11 }}>
          <div style={{ marginBottom: 8 }}>CRASH: {this.state.error.message}</div>
          <pre style={{ color: "#888", fontSize: 9, whiteSpace: "pre-wrap", maxHeight: 200, overflow: "auto" }}>
            {this.state.error.stack}
          </pre>
          <button
            style={{ marginTop: 8, padding: "4px 12px", background: "#333", color: "#fff", border: "1px solid #555", borderRadius: 4, cursor: "pointer" }}
            onClick={() => this.setState({ error: null })}
          >
            RELOAD
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
