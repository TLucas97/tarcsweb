import { Component, useContext, useEffect, type ReactNode } from 'react';
import { CodeFrame } from './Code.tsx';
import { UiKey, UiLive } from './ui/card.tsx';
import { blockTypeOf, checkUi, uiIndex, whyOf } from './ui/check.ts';
import { registry } from './ui/registry.ts';
import { setUiLabels, UiReport } from './UiBlock.tsx';
import { useStore } from './store.ts';
import { send } from './socket.ts';

// The streaming placeholder names the block once this chunk is in.
setUiLabels(Object.fromEntries(Object.entries(registry).map(([k, d]) => [k, d.label])));

const REPORTED_MAX = 200;
const reported = new Set<string>();

// Only a reply of the turn on screen is worth a note: older ones were already followed by a new prompt.
function reportFail(sessionId: string, itemId: string, src: string, why: string) {
  const s = useStore.getState();
  const it = s.items[itemId];
  if (s.current !== sessionId || it?.kind !== 'agent') return;
  const at = s.order.lastIndexOf(itemId);
  if (at < 0) return;
  for (let i = s.order.length - 1; i > at; i--) {
    const later = s.items[s.order[i]];
    if (later?.kind === 'user' && !later.queued) return;
  }
  const index = uiIndex(it.text, src);
  const key = `${sessionId}:${itemId}#${index}`;
  if (reported.has(key)) return;
  if (!send({ type: 'ui-block-failed', sessionId, itemId, index, blockType: blockTypeOf(src), why: whyOf(why) })) {
    unsent.set(key, [sessionId, itemId, src, why]);
    if (unsent.size > UNSENT_MAX) unsent.delete(unsent.keys().next().value!);
    return;
  }
  unsent.delete(key);
  reported.add(key);
  if (reported.size > REPORTED_MAX) reported.delete(reported.values().next().value!);
}

// Reports that met a closed socket, by the same key; they go once the next hello lands, checked again like a fresh one.
const UNSENT_MAX = 20;
const unsent = new Map<string, Parameters<typeof reportFail>>();
useStore.subscribe((s, prev) => {
  if (!s.connected || prev.connected || !unsent.size) return;
  const list = [...unsent.values()];
  unsent.clear();
  for (const args of list) reportFail(...args);
});

function Fallback({ src, why }: { src: string; why: string }) {
  const ctx = useContext(UiReport);
  useEffect(() => {
    if (ctx) reportFail(ctx.sessionId, ctx.itemId, src, why);
  }, [ctx, src, why]);
  return (
    <div className="ub-bad">
      <CodeFrame code={src} lang="json" done />
      <p className="ub-note">This visual could not be drawn<span>{why}</span></p>
    </div>
  );
}

class Guard extends Component<{ src: string; children: ReactNode }, { err: string | null }> {
  state = { err: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { err: e instanceof Error ? e.message : 'Render error' };
  }
  render() {
    return this.state.err ? <Fallback src={this.props.src} why={this.state.err} /> : this.props.children;
  }
}

// A finished ```ui block: the registry and zod live in this chunk, loaded with the first block.
export default function UiDraw({ src, live }: { src: string; live: boolean }) {
  const r = checkUi(src);
  if (!r.ok) return <Fallback src={src} why={r.why} />;
  const { Component: Drawn } = registry[r.type];
  return (
    <Guard key={src} src={src}>
      <UiKey.Provider value={src}>
        <UiLive.Provider value={live}>
          <Drawn b={r.data} />
        </UiLive.Provider>
      </UiKey.Provider>
    </Guard>
  );
}
