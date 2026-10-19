import type { BoardEngine } from './engine.ts';
import { useBoard } from './store.ts';
import { COLORS, DASHES, FILLS, FONTS, RADII, toolSummary, WIDTHS, type StylePatch, type Summary } from './style.ts';

type Eng = React.RefObject<BoardEngine | null>;

// Buttons never take focus from the board, so Space keeps panning.
const keepFocus = (e: React.MouseEvent) => e.preventDefault();

const Line = ({ w = 1.5, dash }: { w?: number; dash?: string }) => (
  <svg width="18" height="16" viewBox="0 0 18 16" aria-hidden="true">
    <path d="M2.5 8h13" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeDasharray={dash} />
  </svg>
);

const FillIcon = ({ alpha }: { alpha: number }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" fill="currentColor" fillOpacity={alpha} stroke="currentColor" strokeWidth="1.3" />
  </svg>
);

const Corner = ({ r }: { r: number }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d={`M3 13V${3 + r}${r ? `a${r} ${r} 0 0 1 ${r}-${r}` : ''}H13`} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const DASH_ART = { solid: undefined, dashed: '3.5 2.5', dotted: '0 3' } as const;
const FILL_ART = { none: 0, light: 0.18, medium: 0.4 } as const;
const CORNER_ART = [0, 2.5, 4.5, 7];

// A dashed frame marks a control whose value differs across the selection.
function Group({ label, mixed, children }: { label: string; mixed: boolean; children: React.ReactNode }) {
  return (
    <div className="bd-sg" role="group" aria-label={mixed ? `${label} (mixed)` : label} data-mixed={mixed ? '' : undefined}>
      <div className="bd-sg-row" title={mixed ? `${label}: mixed` : undefined}>{children}</div>
    </div>
  );
}

function Opt({ on, label, onPick, children }: { on: boolean; label: string; onPick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className="bd-btn bd-sopt" aria-pressed={on} aria-label={label} title={label} onClick={onPick}>
      {children}
    </button>
  );
}

// Style of the selection, or of the next element when nothing is selected. A click applies at once as one undo step.
export function StylePanel({ eng }: { eng: Eng }) {
  const tool = useBoard((s) => s.tool);
  const selection = useBoard((s) => s.selection);
  const selStyle = useBoard((s) => s.selStyle);
  const next = useBoard((s) => s.next);
  const selecting = tool === 'select' || tool === 'lasso';
  const sum: Summary | null = selecting ? (selection ? selStyle : null) : toolSummary(tool, next);
  if (!sum || !Object.keys(sum).length) return null;
  const set = (p: StylePatch) => eng.current?.applyStyle(p);
  return (
    <div className="bd-style" role="toolbar" aria-label={selecting ? 'Selection style' : 'Style for new elements'} onMouseDown={keepFocus}>
      {sum.color !== undefined && (
        <Group label="Color" mixed={sum.color === null}>
          {COLORS.map(({ id, label }) => (
            <Opt key={id} on={sum.color === id} label={label} onPick={() => set({ color: id })}>
              <span className="bd-sw" data-c={id} />
            </Opt>
          ))}
        </Group>
      )}
      {sum.width !== undefined && (
        <Group label="Width" mixed={sum.width === null}>
          {WIDTHS.map(({ px, label }) => (
            <Opt key={px} on={sum.width === px} label={label} onPick={() => set({ width: px })}>
              <Line w={Math.max(1, px * 0.6)} />
            </Opt>
          ))}
        </Group>
      )}
      {sum.dash !== undefined && (
        <Group label="Line" mixed={sum.dash === null}>
          {DASHES.map(({ id, label }) => (
            <Opt key={id} on={sum.dash === id} label={label} onPick={() => set({ dash: id })}>
              <Line w={1.8} dash={DASH_ART[id]} />
            </Opt>
          ))}
        </Group>
      )}
      {sum.fill !== undefined && (
        <Group label="Fill" mixed={sum.fill === null}>
          {FILLS.map(({ id, label }) => (
            <Opt key={id} on={sum.fill === id} label={label} onPick={() => set({ fill: id })}>
              <FillIcon alpha={FILL_ART[id]} />
            </Opt>
          ))}
        </Group>
      )}
      {sum.radius !== undefined && (
        <Group label="Corners" mixed={sum.radius === null}>
          {RADII.map(({ px, label }, i) => (
            <Opt key={px} on={sum.radius === px} label={label} onPick={() => set({ radius: px })}>
              <Corner r={CORNER_ART[i]} />
            </Opt>
          ))}
        </Group>
      )}
      {sum.font !== undefined && (
        <Group label="Text size" mixed={sum.font === null}>
          {FONTS.map(({ px, label, short }) => (
            <Opt key={px} on={sum.font === px} label={label} onPick={() => set({ font: px })}>
              <span className="bd-sopt-text">{short}</span>
            </Opt>
          ))}
        </Group>
      )}
    </div>
  );
}
