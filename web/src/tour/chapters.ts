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
  { id: 'start', essential: true, title: 'Start a session', blurb: 'Pick a folder, then talk to Claude or Codex.' },
  { id: 'palette', essential: true, title: 'Find anything', blurb: 'Ctrl+K finds any session by folder, title or what was said in it.' },
  { id: 'stretch', essential: true, title: 'Short replies that grow', blurb: 'Click an underlined phrase to read more, right where it is.' },
  { id: 'diffs', essential: true, title: 'Every edit is a diff', blurb: 'Each turn that edits files leaves a card. Click it for the full diff.' },
  { id: 'cards', essential: true, title: 'Visuals and questions', blurb: 'Replies draw charts and checklists. Decisions arrive as one card to answer.' },
  { id: 'agents', essential: true, title: 'Agents at work', blurb: 'Every subagent reports its progress here, and you can stop any of them.' },
  { id: 'watch', title: 'Watch mode', blurb: 'Play the session back as a robot walking through its plan.' },
  { id: 'codex', title: 'Codex tabs', blurb: 'Pick a Codex model and the tab runs on Codex, with the same panels.' },
  { id: 'skills', title: 'Skills library', blurb: 'Browse every skill, attach one to your message, or ask which fit.' },
  { id: 'widgets', title: 'Session widgets', blurb: 'Float up to three sessions over the window and reply from them.' },
  { id: 'voice', title: 'Voice and Listen', blurb: 'Hold Space to talk. Listen reads a short recap of a reply aloud.' },
  { id: 'tab-menu', title: 'The tab menu', blurb: 'Right-click a tab to rename, reload, continue on your phone or open it as a widget.' },
  { id: 'replays', title: 'Replays and Explain', blurb: 'Page through a replay of a change, or select any text and ask for an explanation.' },
  { id: 'settings', title: 'Settings worth knowing', blurb: 'Reply style, when long sessions compact, and phone notifications.' },
];

export const ESSENTIALS = CHAPTERS.filter((c) => c.essential);
