// One clip per chapter, served from web/public/tour/. Recorded by script (notes/tour/plan.md), so a UI change means a re-record.
export type Chapter = {
  id: string;
  title: string;
  blurb: string;
  // Part of the first-run tour; the rest play from Settings > Tour.
  essential?: boolean;
  // File name under /tour/, set once the clip is recorded.
  clip?: string;
};

export const CHAPTERS: Chapter[] = [
  { id: 'start', essential: true, title: 'Start a session', blurb: 'Pick a folder, then talk to Claude or Codex.', clip: 'start.webm' },
  { id: 'palette', essential: true, title: 'Find anything', blurb: 'Ctrl+K finds any session by folder, title or what was said in it.', clip: 'palette.webm' },
  { id: 'stretch', essential: true, title: 'Short replies that grow', blurb: 'Click an underlined phrase to read more, right where it is.', clip: 'stretch.webm' },
  { id: 'diffs', essential: true, title: 'Every edit is a diff', blurb: 'Each turn that edits files leaves a card. Click it for the full diff.', clip: 'diffs.webm' },
  { id: 'cards', essential: true, title: 'Visuals and questions', blurb: 'Replies draw charts and checklists. Decisions arrive as one card to answer.', clip: 'cards.webm' },
  { id: 'agents', essential: true, title: 'Agents at work', blurb: 'Every subagent reports its progress here, and you can stop any of them.', clip: 'agents.webm' },
  { id: 'watch', title: 'Watch mode', blurb: 'Play the session back as a robot walking through its plan.' },
  { id: 'codex', title: 'Codex tabs', blurb: 'Pick a Codex model and the tab runs on Codex, with the same panels.', clip: 'codex.webm' },
  { id: 'skills', title: 'Skills library', blurb: 'Browse every skill and attach one to your next message.', clip: 'skills.webm' },
  { id: 'widgets', title: 'Session widgets', blurb: 'Float up to three sessions over the window and reply from them.', clip: 'widgets.webm' },
  { id: 'voice', title: 'Voice and Listen', blurb: 'Hold Space to talk. Listen reads a short recap of a reply aloud.', clip: 'voice.webm' },
  { id: 'tab-menu', title: 'The tab menu', blurb: 'Right-click a tab to rename, reload, continue on your phone or open it as a widget.', clip: 'tab-menu.webm' },
  { id: 'replays', title: 'Replays and Explain', blurb: 'Page through a replay of a change, or select any text and ask for an explanation.', clip: 'replays.webm' },
  { id: 'settings', title: 'Settings worth knowing', blurb: 'Reply style, when long sessions compact, and phone notifications.', clip: 'settings.webm' },
];

// Only recorded chapters ship; one recorded later shows up as new in the tour.
export const READY = CHAPTERS.filter((c) => c.clip);
export const ESSENTIALS = READY.filter((c) => c.essential);
