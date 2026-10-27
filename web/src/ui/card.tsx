import { createContext, useContext, type ReactNode } from 'react';
import { reduceMotion } from '../bits.tsx';
import { FxBtn } from '../Focus.tsx';
import { fenced, SendTextBtn } from '../SendToChat.tsx';
import { EASE_OUT, useEntrance, type Stage } from './motion.ts';

// The block's source text: identifies it across remounts while the message streams.
export const UiKey = createContext('');
// True while the message holding the block still streams: entrances then skip main-thread effects.
export const UiLive = createContext(false);

const REPLAY = (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M1.5 6a4.5 4.5 0 1 0 4.5-4.5 4.9 4.9 0 0 0-3.37 1.37L1.5 4M1.5 1.5V4H4" />
  </svg>
);

function ReplayBtn({ onReplay }: { onReplay: () => void }) {
  return (
    <button
      type="button" className="ub-rp" aria-label="Replay" title="Replay"
      onClick={(e) => {
        e.stopPropagation();
        onReplay();
        if (!reduceMotion()) e.currentTarget.firstElementChild?.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(-360deg)' }], { duration: 420, easing: EASE_OUT });
      }}
    >
      {REPLAY}
    </button>
  );
}

// Frame shared by every inline ui component: header with title, extras, Replay and full screen.
export function Card({ title, label, head, stage, className, children }: {
  title?: string;
  // Header text when there is no title; with `head === false` and no title the actions float instead.
  label: string;
  head?: ReactNode | false;
  stage: Stage;
  className: string;
  children: ReactNode;
}) {
  const key = useContext(UiKey);
  const live = useContext(UiLive);
  const { ref, replay } = useEntrance<HTMLDivElement>(key, stage, live);
  const name = title || label;
  const send = <SendTextBtn text={() => fenced(key, 'ui')} what="this visual" />;
  return (
    <div ref={ref} className={`frame ub ${className}`}>
      {head === false && !title ? (
        <div className="ub-acts">
          {send}
          <ReplayBtn onReplay={replay} />
          <FxBtn label={name} />
        </div>
      ) : (
        <div className="fh">
          <span className="n">{name}</span>
          {head}
          {send}
          <ReplayBtn onReplay={replay} />
          <FxBtn label={name} />
        </div>
      )}
      <div className="ub-body">{children}</div>
    </div>
  );
}
