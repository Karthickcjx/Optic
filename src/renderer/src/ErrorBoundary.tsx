import { Component, type ReactNode } from 'react';
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div className="empty" style={{ height: '100vh' }} role="alert"><h2>The workspace encountered an error</h2><p>Reload to recover. Active terminals and port forwards will be closed.</p><button className="primary" onClick={() => window.location.reload()}>Reload workspace</button></div>;
    return this.props.children;
  }
}
