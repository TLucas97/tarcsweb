import { useEffect, useId, useState } from 'react';
import type { AdvisorItem } from './store.ts';
import { Led } from './led.tsx';

const TITLE = { consulting: 'Consulting Fable', reviewed: 'Fable reviewed the work', declined: 'Fable declined to advise', unavailable: 'Fable unavailable' } as const;

// "claude-fable-5-1" reads "Fable 5.1".
const modelName = (id: string) => id.replace(/^claude-([a-z]+)-(\d+)-(\d+).*$/, (_, f: string, a: string, b: string) => `${f[0].toUpperCase()}${f.slice(1)} ${a}.${b}`);
const kTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const usd = (n: number) => `~$${n < 0.01 ? n.toFixed(3) : n.toFixed(2)}`;

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="adv-meta mono">{Math.max(0, Math.round((now - since) / 1000))}s</span>;
}

// One advisor call: a live line while Fable reads the conversation, then what it cost; the detail opens on click.
export function AdvisorRow({ item }: { item: AdvisorItem }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const live = item.state === 'consulting';
  const title = item.state === 'unavailable' && item.error === 'stopped' ? 'Fable consult stopped' : TITLE[item.state];
  const u = item.usage;
  const head = (
    <>
      <span className="adv-led" aria-hidden="true"><Led size="sm" pattern={live ? 'think' : item.state === 'unavailable' ? 'fault' : 'calm'} still={!live} /></span>
      <span className="adv-t">{title}</span>
      {live ? <Elapsed since={item.since} /> : (
        <span className="adv-meta">
          {u && <span className="mono">{kTokens(u.input + u.output)} tokens</span>}
          {u?.costUsd != null && <span className="mono">{usd(u.costUsd)}</span>}
          {item.state === 'unavailable' && item.error !== 'stopped' && <span className="mono">{item.error}</span>}
          {u && item.billing && <span className={`adv-tag ${item.billing}`}>{item.billing === 'plan' ? 'plan' : 'credits'}</span>}
        </span>
      )}
    </>
  );
  return (
    <div className={`adv-row${live ? ' live' : ''}${item.state === 'unavailable' ? ' bad' : ''}${open ? ' open' : ''}`} data-id={item.id}>
      {live ? <div className="adv-h" role="status">{head}</div> : (
        <button type="button" className="adv-h" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(!open)}>
          {head}<svg className="adv-chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5l3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      )}
      {open && (
        <div className="adv-d" id={panel}>
          <dl>
            {item.model && <><dt>Model</dt><dd>{modelName(item.model)}</dd></>}
            {u && <><dt>Read</dt><dd><span className="mono">{u.input.toLocaleString('en-US')}</span> tokens <span className="adv-n">· the whole conversation</span></dd></>}
            {u && <><dt>Wrote</dt><dd><span className="mono">{u.output.toLocaleString('en-US')}</span> tokens</dd></>}
            {u?.costUsd != null && <><dt>Cost</dt><dd><span className="mono">{usd(u.costUsd)}</span> <span className="adv-n">· estimate</span></dd></>}
            {item.billing && <><dt>Billed to</dt><dd>{item.billing === 'plan' ? 'Your plan' : 'Usage credits'} <span className="adv-n">· from your account's usage state at the time</span></dd></>}
            {item.state === 'unavailable' && <><dt>Error</dt><dd className="mono">{item.error}</dd></>}
            {!u && item.state !== 'unavailable' && <><dt>Tokens</dt><dd>not reported</dd></>}
          </dl>
          {item.state !== 'unavailable' && (
            item.text ? <p className="adv-text">{item.text}</p> : <p className="adv-note">The advice is encrypted. Claude reads it; the app can only show that it arrived.</p>
          )}
        </div>
      )}
    </div>
  );
}
