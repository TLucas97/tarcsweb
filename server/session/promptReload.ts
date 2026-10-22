import { unwatchFile, watchFile } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BROWSER_AGENT_DESCRIPTION, STRETCH_GUIDE, VISUAL_PROMPT, VISUAL_REMINDER, browserAgentPrompt, browserPrompt, codexPrompt, codexReminder, stretchNote } from '../prompt.ts';
import { onPerfChange, tuning } from '../profile.ts';

// Re-read on edit, so a reloaded session gets the new prompt without restarting the server.
export const livePrompt = {
  visualPrompt: VISUAL_PROMPT,
  visualReminder: VISUAL_REMINDER,
  stretchGuide: STRETCH_GUIDE,
  noteOf: stretchNote,
  codexPromptOf: codexPrompt,
  codexReminderOf: codexReminder,
  browserPromptOf: browserPrompt,
  browserAgentPromptOf: browserAgentPrompt,
  browserAgentDescription: BROWSER_AGENT_DESCRIPTION,
};
const promptUrl = new URL('../prompt.ts', import.meta.url);
const refreshPrompt = () => {
  import(`${promptUrl.href}?t=${Date.now()}`).then((m: typeof import('../prompt.ts')) => {
    livePrompt.visualPrompt = m.VISUAL_PROMPT;
    livePrompt.browserPromptOf = m.browserPrompt;
    livePrompt.browserAgentPromptOf = m.browserAgentPrompt;
    livePrompt.browserAgentDescription = m.BROWSER_AGENT_DESCRIPTION;
    livePrompt.visualReminder = m.VISUAL_REMINDER;
    livePrompt.stretchGuide = m.STRETCH_GUIDE;
    livePrompt.noteOf = m.stretchNote;
    livePrompt.codexPromptOf = m.codexPrompt;
    livePrompt.codexReminderOf = m.codexReminder;
  }, () => {});
};
const watchPrompt = () => {
  if (tuning().promptWatch) watchFile(fileURLToPath(promptUrl), { interval: 1500 }, refreshPrompt).unref();
  else unwatchFile(fileURLToPath(promptUrl), refreshPrompt);
};
watchPrompt();
onPerfChange((profile, prev) => { if (profile !== prev) watchPrompt(); });
