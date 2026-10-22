import type { ReactNode } from 'react';
import { useStore } from './store.ts';
import { Reader } from './Reader.tsx';
import { DiffViewer } from './DiffViewer.tsx';
import { closeLog, LogBody } from './Agents.tsx';
import { setLogClose, type View } from './Focus.tsx';

setLogClose(closeLog);

function LogView() {
  const log = useStore((s) => s.log);
  if (!log) return <div className="frame log"><pre className="logbody mono">The log was closed.</pre></div>;
  return <div className="frame log"><LogBody log={log} /></div>;
}

// The focus view's heavy bodies, split from Focus.tsx so its buttons cost the main chunk nothing.
export default function FocusBody({ view, close }: { view: Extract<View, { mode: 'text' | 'diff' | 'log' }>; close: ReactNode }) {
  if (view.mode === 'text') return <Reader source={view.source} label={view.label} close={close} />;
  if (view.mode === 'diff') return <DiffViewer source={view.diff} close={close} />;
  return <LogView />;
}
