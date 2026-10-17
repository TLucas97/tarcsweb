import { useId } from 'react';
import { useStore } from '../store.ts';
import type { ActiveSkill } from '../../../server/protocol.ts';
import type { SkillRef } from './ref.tsx';

const NONE: ActiveSkill[] = [];
const SHOWN = 1;
const HOW = { tool: 'Loaded by the agent', slash: 'Loaded with a /command', chip: 'Attached from the library' };

function stateLine(s: ActiveSkill) {
  if (s.lost) return 'Dropped by the last compaction.';
  if (s.kept) return 'Kept after the compaction. A long skill comes back shortened.';
  return null;
}

function Badge({ skill: s, onAttach }: { skill: ActiveSkill; onAttach: (r: SkillRef) => void }) {
  const tip = useId();
  const state = stateLine(s);
  const card = (
    <span className="skx-card" id={tip} role="tooltip">
      <b>{s.name}</b>
      <span className="skx-d">{s.desc || s.path || 'No description'}</span>
      <small>{HOW[s.how]}{state && <> · {state}</>}{s.lost && s.path && <> Click to attach it again.</>}</small>
    </span>
  );
  if (s.lost && s.path) {
    const ref = { name: s.name, path: s.path };
    return <li><button type="button" className="skx-b lost" aria-describedby={tip} onClick={() => onAttach(ref)}><span className="skx-n">{s.name}</span>{card}</button></li>;
  }
  return <li><span className={`skx-b${s.lost ? ' lost' : ''}`} tabIndex={0} aria-describedby={tip}><span className="skx-n">{s.name}</span>{card}</span></li>;
}

// The skills in effect for the main agent, next to the composer's skills button; the rest fold into "+N".
export function ActiveSkills({ onAttach }: { onAttach: (r: SkillRef) => void }) {
  const skills = useStore((s) => (s.current ? s.maps[s.current]?.skills : undefined)) ?? NONE;
  if (!skills.length) return null;
  // Newest first, dropped ones last.
  const order = [...skills].reverse().sort((a, b) => Number(!!a.lost) - Number(!!b.lost));
  const rest = order.slice(SHOWN);
  return (
    <ul className="skx"aria-label="Skills in effect">
      {order.slice(0, SHOWN).map((s) => <Badge key={s.name} skill={s} onAttach={onAttach} />)}
      {rest.length > 0 && (
        <li>
          <span className="skx-b" tabIndex={0} aria-label={`${rest.length} more skills`}>
            +{rest.length}
            <span className="skx-card" role="tooltip">
              {rest.map((s) => (
                <span key={s.name} className={`skx-row${s.lost ? ' lost' : ''}`}>
                  <b>{s.name}</b>
                  {(s.desc || s.lost) && <span className="skx-d">{s.lost ? 'Dropped by the last compaction.' : s.desc}</span>}
                </span>
              ))}
            </span>
          </span>
        </li>
      )}
    </ul>
  );
}
