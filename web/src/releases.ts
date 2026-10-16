import { create } from 'zustand';
import type { ServerMessage, UpdateRun, UpdateStatus, UpdateStep } from '../../server/protocol.ts';
import { pref } from './bits.tsx';
import { send } from './socket.ts';

// later: the release "Later" hid, until a newer one appears. seen: the finished update whose notice was closed.
type Update = { status: UpdateStatus | null; later: string | null; seen: string | null };
export const useUpdate = create<Update>(() => ({ status: null, later: pref.get<string | null>('update-later', null), seen: pref.get<string | null>('update-seen', null) }));

export const ACTIVE_STEPS: UpdateStep[] = ['downloading', 'installing', 'checking', 'restarting'];
export const isActive = (run: UpdateRun | null | undefined): run is UpdateRun => !!run && ACTIVE_STEPS.includes(run.step);

// The version this page's code was built for.
let loaded: string | null = null;

export function applyUpdate(msg: Extract<ServerMessage, { type: 'update' }>) {
  // After an update the server serves a new build and the old chunks are gone, so the page reloads into it.
  if (loaded && msg.update.current !== loaded) return location.reload();
  loaded = msg.update.current;
  useUpdate.setState({ status: msg.update });
}

export const checkUpdates = () => send({ type: 'update-check' });
export const startUpdate = (tag: string) => send({ type: 'update', tag });

export function updateLater(tag: string) {
  pref.set('update-later', tag);
  useUpdate.setState({ later: tag });
}

export function closeUpdated(tag: string) {
  pref.set('update-seen', tag);
  useUpdate.setState({ seen: tag });
}

// A failure matters only while that release is still the one on offer.
export const failedRun = (s: UpdateStatus | null) => (s?.run?.step === 'failed' && s.available && s.run.tag === s.latest?.tag ? s.run : null);
// The update that brought this page's version, for an hour after it finished.
export const doneRun = (s: UpdateStatus | null) =>
  s?.run?.step === 'done' && s.run.tag === `v${s.current}` && Date.now() - s.run.at < 3600_000 ? s.run : null;
