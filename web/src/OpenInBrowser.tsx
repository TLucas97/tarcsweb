import { TAB_BYTES_MAX, TAB_HTML_MAX, type ClientMessage } from '../../server/protocol.ts';
import { useStore } from './store.ts';
import { send } from './socket.ts';

// A URL the app already serves, or a composed page the server stores and serves.
export type TabPage = { url: string } | { html: string; title: string };

const ICON = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12.5 9.5v3a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1h3M9.5 2.5h4v4M13.5 2.5l-6 6" />
  </svg>
);

const notice = (text: string) => useStore.setState({ notice: text, noticeInfo: false });

// Opens a visual in a normal tab of the user's Chrome; page is built on click, so a card never composes it per render.
export function OpenTabBtn({ className, page }: { className: string; page: () => TabPage }) {
  const open = () => {
    const p = page();
    const msg: ClientMessage = 'url' in p ? { type: 'open-url', url: p.url } : { type: 'open-html', html: p.html, title: p.title };
    // The server's check and the socket's frame limit both drop a larger page without a word, so say it here.
    const big = 'html' in p && (p.html.length > TAB_HTML_MAX || new TextEncoder().encode(JSON.stringify(msg)).length > TAB_BYTES_MAX);
    if (big) return notice('The page is too large to open in the browser');
    if (!send(msg)) notice('Not connected');
  };
  return (
    <button type="button" className={className} aria-label="Open in browser" title="Open in browser" onClick={(e) => (e.stopPropagation(), open())}>
      {ICON}
    </button>
  );
}
