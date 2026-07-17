import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

document.documentElement.dataset.platform = navigator.platform.startsWith('Mac') ? 'darwin' : 'other';

class RendererErrorBoundary extends React.Component<React.PropsWithChildren, { error?: Error }> {
  override state: { error?: Error } = {};
  static getDerivedStateFromError(error: unknown): { error: Error } { return { error: error instanceof Error ? error : new Error(String(error)) }; }
  override componentDidCatch(error: Error, info: React.ErrorInfo): void { console.error('[Atomizer] renderer failed loudly', error, info); }
  override render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return <main className="renderer-fatal" role="alert">
      <div className="renderer-fatal-mark">!</div>
      <small>RENDERER CONTRACT FAILURE</small>
      <h1>Atomizer could not start</h1>
      <p>{this.state.error.message}</p>
      <button onClick={() => { for (const key of Object.keys(localStorage)) if (key.startsWith('atomizer:v2:')) localStorage.removeItem(key); location.reload(); }}>Reset local UI preferences and reload</button>
    </main>;
  }
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><RendererErrorBoundary><App /></RendererErrorBoundary></React.StrictMode>);
