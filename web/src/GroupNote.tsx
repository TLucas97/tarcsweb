import type { GroupState, SessionOrigin } from '../../server/protocol.ts';
import { openText } from './Focus.tsx';
import { send } from './socket.ts';
import { useStore } from './store.ts';

type S = ReturnType<typeof useStore.getState>;

const groupOf = (s: S, id: string | null) => (id ? s.groups.find((g) => g.main.id === id || g.children.some((m) => m.id === id)) : undefined);

// An open tab's name, else a group member's last known one.
function nameOf(s: Pick<S, 'roster' | 'groups'>, id: string) {
  const open = s.roster.find((r) => r.id === id);
  if (open) return open.name;
  for (const g of s.groups) for (const m of [g.main, ...g.children]) if (m.id === id || m.savedId === id) return m.name;
  return null;
}

// Entries start with their author's session id; the reader shows the member's name instead.
const named = (text: string, g: GroupState | undefined) =>
  text.replace(/^\[([^\]\n]+)\] /gm, (_tag, id: string) => {
    const m = g && [g.main, ...g.children].find((x) => x.id === id || x.savedId === id);
    return `**${m?.name ?? 'Former session'}:** `;
  });

const read = (text: string, g: GroupState | undefined, from: Element) => openText({ paste: named(text, g), md: true, label: 'Shared group summary' }, from);

// The session menu's request opens the reader when the answer lands, wherever the conversation is scrolled.
let asked: string | null = null;
export function readGroupSummary(id: string) {
  if (!send({ type: 'group-read', sessionId: id })) return void useStore.setState({ notice: 'Not connected', noticeInfo: false });
  asked = id;
}
useStore.subscribe((s, prev) => {
  const got = s.groupSummary;
  if (!asked || !got || got === prev.groupSummary || got.sessionId !== asked) return;
  asked = null;
  useStore.setState({ groupSummary: null });
  if (!got.text) return void useStore.setState({ notice: 'The shared summary is empty', noticeInfo: true });
  const from = document.querySelector('.conv');
  if (from) read(got.text, groupOf(s, got.sessionId), from);
});

const GroupIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="1.8" width="7.5" height="4" rx="1.2" /><path d="M4.5 5.8v6.7H8M4.5 8.5H8" /><rect x="8" y="7" width="6" height="3" rx="1" /><rect x="8" y="11" width="6" height="3" rx="1" />
  </svg>
);

// A message another session sent here; the tooltip says who wrote it.
export function OriginTag({ origin }: { origin: SessionOrigin }) {
  const roster = useStore((s) => s.roster);
  const groups = useStore((s) => s.groups);
  const name = nameOf({ roster, groups }, origin.sessionId);
  const where = name ?? 'another session';
  const label = origin.role === 'main' ? 'From main session' : origin.role === 'child' ? 'From sub-session' : `From ${where}`;
  return <span className="rc-from" title={origin.actor === 'user' ? `You sent this from ${where}` : `The agent in ${where} sent this`}>{label}</span>;
}

// Under the newest row: what the group added while the main session was away, and the cleanup notice.
export function GroupNote() {
  const current = useStore((s) => s.current);
  const roster = useStore((s) => s.roster);
  const groups = useStore((s) => s.groups);
  const gid = roster.find((r) => r.id === current)?.group?.id;
  const group = groups.find((g) => g.id === gid);
  const summary = useStore((s) => (s.groupSummary?.sessionId === s.current ? s.groupSummary.text : ''));
  if (!group) return null;
  const first = summary && named(summary, group).split('\n').find((l) => l.trim())?.replace(/\*\*/g, '');
  return (
    <>
      {summary && (
        <div className="hon">
          <span className="hon-ic"><GroupIcon /></span>
          <div className="hon-txt">
            <span className="hon-t"><b>Shared summary</b><span dir="auto">{first}</span></span>
            <small>Added since you last read it</small>
          </div>
          <button
            type="button" className="hon-open"
            onClick={(e) => {
              read(summary, group, e.currentTarget.closest('.hon') ?? e.currentTarget);
              useStore.setState({ groupSummary: null });
            }}
          >
            Read
          </button>
        </div>
      )}
      {group.cleanupNotice && group.cleanupAt !== null && (
        <div className="hon gn-clean">
          <span className="hon-ic"><GroupIcon /></span>
          <div className="hon-txt">
            <span className="hon-t"><b>Group cleanup</b><span>{new Date(group.cleanupAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span></span>
            <small>Removes the group and its shared summary, not its sessions</small>
          </div>
          <button type="button" className="hon-open" onClick={() => send({ type: 'group-keep', groupId: group.id })}>Keep group</button>
        </div>
      )}
    </>
  );
}
