import type { CSSProperties, ReactNode } from 'react';
import type { ClientMessage, ServerMessage, UiElement, UiNode, UiPromptAnswer } from '../../server/protocol.ts';
import { useStore } from './store.ts';
import { send } from './socket.ts';
import { Markdown } from './Markdown.tsx';
import { CodeFrame } from './Code.tsx';
import { Led } from './led.tsx';

// Layout props come in terminal cells; rows and columns map to small pixel steps here.
const ROW = 6;
const COL = 3;
const INK: Record<string, string> = {
  subtle: 'var(--muted)', inactive: 'var(--muted)', secondaryText: 'var(--muted)', text: 'var(--ink)',
  claude: 'var(--coral)', suggestion: 'var(--coral)', permission: 'var(--coral)',
  success: 'var(--green)', error: 'var(--red)', warning: 'var(--amber,#a86b16)',
};

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const cells = (v: unknown, unit: number) => (num(v) !== undefined ? num(v)! * unit : undefined);

function boxStyle(p: Record<string, unknown>): CSSProperties {
  const m = cells(p.margin, ROW);
  const pad = cells(p.padding, COL);
  return {
    flexDirection: p.flexDirection === 'column' || p.flexDirection === 'row-reverse' || p.flexDirection === 'column-reverse' ? p.flexDirection : 'row',
    flexWrap: p.flexWrap === 'wrap' ? 'wrap' : undefined,
    flexGrow: num(p.flexGrow), flexShrink: num(p.flexShrink),
    alignItems: str(p.alignItems) as CSSProperties['alignItems'], justifyContent: str(p.justifyContent) as CSSProperties['justifyContent'],
    gap: cells(p.gap, COL),
    marginTop: cells(p.marginTop ?? p.marginY, ROW) ?? m, marginBottom: cells(p.marginBottom ?? p.marginY, ROW) ?? m,
    marginLeft: cells(p.marginLeft ?? p.marginX, COL) ?? m, marginRight: cells(p.marginRight ?? p.marginX, COL) ?? m,
    paddingTop: cells(p.paddingTop ?? p.paddingY, ROW) ?? pad, paddingBottom: cells(p.paddingBottom ?? p.paddingY, ROW) ?? pad,
    paddingLeft: cells(p.paddingLeft ?? p.paddingX, COL) ?? pad, paddingRight: cells(p.paddingRight ?? p.paddingX, COL) ?? pad,
    width: typeof p.width === 'string' ? p.width : undefined,
    border: p.borderStyle ? '1px solid var(--line)' : undefined, borderRadius: p.borderStyle ? 8 : undefined,
  };
}

function textStyle(p: Record<string, unknown>): CSSProperties {
  const color = str(p.color);
  return {
    color: p.dimColor ? 'var(--muted)' : color && (INK[color] ?? (/^(#|rgb)/.test(color) ? color : undefined)),
    fontWeight: p.bold ? 600 : undefined, fontStyle: p.italic ? 'italic' : undefined,
    textDecoration: p.underline ? 'underline' : p.strikethrough ? 'line-through' : undefined,
  };
}

const svgUrl = (src: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(src)}`;
const safeHref = (h: string) => /^https?:\/\//.test(h);

export function press(sessionId: string, el: UiElement, path: number[]) {
  if (!el.press) return;
  const key = str(el.props?.key) ?? null;
  send({ type: 'ui-press', sessionId, plugin: el.press.plugin, key, path });
}

type Slot = { at: string; index: number };
type Extra = { slot: Slot | null; node: ReactNode };

// Where the app's own actions join the plugin's: the row of its last button, ahead of a trailing Dismiss.
function actionSlot(tree: UiNode): Slot | null {
  let slot: Slot | null = null;
  const walk = (n: UiNode, path: number[], chain: UiElement[]) => {
    if (typeof n === 'string') return;
    if (n.type === 'Button' && chain.length) {
      // Climb past single-child wrappers to the box that holds the buttons.
      let k = chain.length - 1;
      while (k > 0 && chain[k].children?.length === 1) k--;
      slot = { at: path.slice(0, k).join('.'), index: path[k] + (n.props?.role === 'dismiss' ? 0 : 1) };
      return;
    }
    n.children?.forEach((c, i) => walk(c, [...path, i], [...chain, n]));
  };
  walk(tree, [], []);
  return slot;
}

function Node({ n, path, sessionId, extra }: { n: UiNode; path: number[]; sessionId: string; extra?: Extra }): ReactNode {
  if (typeof n === 'string') return n === '✦' ? <span className="plb-star"><Led size="sm" pattern="mark" still /></span> : n;
  const p = n.props ?? {};
  const kids = () => n.children?.map((c, i) => <Node key={i} n={c} path={[...path, i]} sessionId={sessionId} extra={extra} />);
  switch (n.type) {
    case 'Box':
    case 'div': {
      const k = kids();
      if (k && extra?.slot?.at === path.join('.')) {
        // Spaced like the plugin's own button wrapper next to it.
        const i = extra.slot.index;
        const like = n.children![i] ?? n.children![i - 1];
        const style = typeof like === 'object' && like.type !== 'Button' ? boxStyle(like.props ?? {}) : undefined;
        k.splice(i, 0, <div key="extra" className="plb-box" style={style}>{extra.node}</div>);
      }
      return <div className="plb-box" style={boxStyle(p)}>{k}</div>;
    }
    case 'Text':
    case 'span':
    case 'b': {
      const trunc = p.wrap === 'truncate-end' || p.wrap === 'truncate';
      return <span className={trunc ? 'plb-trunc' : undefined} style={{ ...textStyle(p), ...(n.type === 'b' ? { fontWeight: 600 } : {}) }}>{kids()}</span>;
    }
    case 'Button': {
      const label = n.children?.length ? kids() : str(p.label);
      const role = p.role === 'dismiss' ? ' dismiss' : p.variant === 'primary' ? ' primary' : '';
      return <button type="button" className={`plb-btn${role}${p.dimColor ? ' dim' : ''}`} autoFocus={p.autoFocus === true} onClick={() => press(sessionId, n, path)}>{label}</button>;
    }
    case 'Markdown':
      return <div className={`plb-md${p.dimColor ? ' dim' : ''}`}><Markdown text={str(p.text) ?? ''} /></div>;
    case 'Code':
      return <div className="plb-code"><CodeFrame code={str(p.source) ?? ''} lang={str(p.language) === 'text' ? '' : str(p.language) ?? ''} done /></div>;
    case 'Svg':
      return <img className="plb-svg" src={svgUrl(str(p.source) ?? '')} alt={str(p.alt) ?? ''} width={num(p.width)} height={num(p.height)} />;
    case 'Link': {
      const href = str(p.href) ?? '';
      const body = n.children?.length ? kids() : str(p.label) ?? href;
      return safeHref(href) ? <a href={href} target="_blank" rel="noreferrer">{body}</a> : <span>{body}</span>;
    }
    default:
      return null;
  }
}

// Plugins' AbovePrompt band (a ui.render tree drawn for this app's surface); HeadsUps places it right above the composer.
// actions render next to the plugin's own buttons; a tree with none drops them.
export function PluginBand({ sessionId, tree, actions }: { sessionId: string; tree: UiNode; actions?: ReactNode }) {
  const extra = actions ? { slot: actionSlot(tree), node: actions } : undefined;
  return (
    <div className="plb" role="region" aria-label="Plugin notice">
      <Node n={tree} path={[]} sessionId={sessionId} extra={extra} />
    </div>
  );
}

const composer = () => document.querySelector<HTMLTextAreaElement>('.input textarea');
let clearSuggestion: (() => void) | null = null;

function fill(t: HTMLTextAreaElement, text: string, mode: string) {
  clearSuggestion?.();
  if (mode === 'append') t.value += text;
  else if (mode === 'insert') t.setRangeText(text, t.selectionStart, t.selectionEnd, 'end');
  else t.value = text;
  // The composer resizes on its own input handler.
  t.dispatchEvent(new Event('input', { bubbles: true }));
  t.focus();
  t.setSelectionRange(t.value.length, t.value.length);
}

export function fillComposer(text: string) {
  const t = composer();
  if (t) fill(t, text, 'replace');
}

// Adds text after the draft, focused with the caret at the end; multi-line text starts a new paragraph.
export function appendComposer(text: string) {
  const t = composer();
  if (!t) return false;
  const v = t.value;
  const gap = !v || /\n\n$/.test(v) ? '' : text.includes('\n') ? (v.endsWith('\n') ? '\n' : '\n\n') : /\s$/.test(v) ? '' : ' ';
  fill(t, gap + text, 'append');
  return true;
}

// A suggestion shows as the placeholder; Tab takes it, typing drops it.
function suggest(t: HTMLTextAreaElement, text: string) {
  clearSuggestion?.();
  const was = t.placeholder;
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || t.value) return;
    e.preventDefault();
    fill(t, text, 'replace');
  };
  const clear = () => {
    t.removeEventListener('keydown', onKey);
    t.removeEventListener('input', clear);
    if (t.placeholder === text) t.placeholder = was;
    clearSuggestion = null;
  };
  t.placeholder = text;
  t.addEventListener('keydown', onKey);
  t.addEventListener('input', clear);
  clearSuggestion = clear;
}

// Answers a plugin's question about the composer; null leaves it to another client showing the session.
export function answerUiPrompt(msg: Extract<ServerMessage, { type: 'ui-prompt' }>): ClientMessage | null {
  const s = useStore.getState();
  if (s.current !== msg.sessionId) return null;
  const t = composer();
  const blocked = !t || !!s.palette || !!s.replayView || !!document.querySelector(':popover-open');
  let answer: UiPromptAnswer;
  if (msg.op === 'read') answer = { text: t?.value ?? '', cursor: t?.selectionStart ?? 0 };
  else if (msg.op === 'fill') {
    if (!blocked) fill(t!, msg.text ?? '', msg.mode ?? 'replace');
    answer = { filled: !blocked };
  } else {
    const ok = !blocked && !t!.value && s.status !== 'working';
    if (ok) suggest(t!, msg.text ?? '');
    answer = { shown: ok };
  }
  return { type: 'ui-prompt-answer', sessionId: msg.sessionId, id: msg.id, answer };
}
