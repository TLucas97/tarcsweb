import { Component, type ReactNode } from 'react';
import { create } from 'zustand';

// Set when a lazy chunk fails to load, usually because the server rebuilt and old hashed files are gone.
const useStale = create<{ stale: boolean }>(() => ({ stale: false }));
export const markStale = () => useStale.setState({ stale: true });

const CHUNK_ERR = /dynamically imported module|module script failed|preload css/i;
const isChunkError = (e: unknown) => e instanceof Error && CHUNK_ERR.test(e.message);

// Catches a lazy mount whose chunk failed; other errors keep propagating as before.
export class ChunkGuard extends Component<{ fallback?: ReactNode; children: ReactNode }, { err: unknown }> {
  state = { err: null as unknown };
  static getDerivedStateFromError(err: unknown) {
    return { err };
  }
  componentDidCatch(err: unknown) {
    if (isChunkError(err)) markStale();
  }
  render() {
    const { err } = this.state;
    if (err === null) return this.props.children;
    if (!isChunkError(err)) throw err;
    return this.props.fallback ?? null;
  }
}

// One line for the whole page, never an automatic reload: the owner may have a draft open.
export function StaleBar() {
  const stale = useStale((s) => s.stale);
  if (!stale) return null;
  return (
    <div className="stale" role="alert">
      <span>A newer version is available. Reload to update.</span>
      <button type="button" onClick={() => location.reload()}>Reload</button>
    </div>
  );
}
