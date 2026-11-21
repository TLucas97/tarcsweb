import { unwatchFile, watchFile } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BROWSER_AGENT_DESCRIPTION, COMMANDER_PROMPT, STRETCH_GUIDE, VISUAL_REMINDER, browserAgentPrompt, browserPrompt, claudeReminder, codexPrompt, codexReminder, opencodePrompt, opencodeReminder, promptFamily, stretchNote, visualPrompt } from '../prompt.ts';
import { onPerfChange, tuning } from '../profile.ts';

// Re-read on edit, so a reloaded session gets the new prompt without restarting the server.
export const livePrompt = {
  visualPromptOf: visualPrompt,
  visualReminder: VISUAL_REMINDER,
  stretchGuide: STRETCH_GUIDE,
  commanderPrompt: COMMANDER_PROMPT,
  noteOf: stretchNote,
  codexPromptOf: codexPrompt,
  codexReminderOf: codexReminder,
  opencodePromptOf: opencodePrompt,
  claudeReminderOf: claudeReminder,
  opencodeReminderOf: opencodeReminder,
  familyOf: promptFamily,
  browserPromptOf: browserPrompt,
  browserAgentPromptOf: browserAgentPrompt,
  browserAgentDescription: BROWSER_AGENT_DESCRIPTION,
};
const promptUrl = new URL('../prompt.ts', import.meta.url);
const refreshPrompt = () => {
  import(`${promptUrl.href}?t=${Date.now()}`).then((m: typeof import('../prompt.ts')) => {
    livePrompt.visualPromptOf = m.visualPrompt;
    livePrompt.browserPromptOf = m.browserPrompt;
    livePrompt.browserAgentPromptOf = m.browserAgentPrompt;
    livePrompt.browserAgentDescription = m.BROWSER_AGENT_DESCRIPTION;
    livePrompt.visualReminder = m.VISUAL_REMINDER;
    livePrompt.stretchGuide = m.STRETCH_GUIDE;
    livePrompt.commanderPrompt = m.COMMANDER_PROMPT;
    livePrompt.noteOf = m.stretchNote;
    livePrompt.codexPromptOf = m.codexPrompt;
    livePrompt.codexReminderOf = m.codexReminder;
    livePrompt.opencodePromptOf = m.opencodePrompt;
    livePrompt.claudeReminderOf = m.claudeReminder;
    livePrompt.opencodeReminderOf = m.opencodeReminder;
    livePrompt.familyOf = m.promptFamily;
  }, () => {});
};
const watchPrompt = () => {
  if (tuning().promptWatch) watchFile(fileURLToPath(promptUrl), { interval: 1500 }, refreshPrompt).unref();
  else unwatchFile(fileURLToPath(promptUrl), refreshPrompt);
};
watchPrompt();
onPerfChange((profile, prev) => { if (profile !== prev) watchPrompt(); });
