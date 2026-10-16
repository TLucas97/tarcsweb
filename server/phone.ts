import { config, modOptions, rawConfig, t } from './config.ts';

type Config = { modTopic: string; modServer: string; delayMs: number; longTurnMs: number };

function load(): Config {
  const o = modOptions('phone-ping');
  return {
    modTopic: String(o.ntfy_topic ?? '').trim(),
    modServer: String(o.ntfy_server || 'https://ntfy.sh').replace(/\/+$/, ''),
    // CW_PING_* only exist to test the timing on a second instance.
    delayMs: Number(process.env.CW_PING_DELAY_MS) || (Number(o.delay_seconds) || 90) * 1000,
    longTurnMs: Number(process.env.CW_PING_LONG_MS) || (Number(o.long_turn_minutes) || 5) * 60_000,
  };
}

// ntfy push when a session needs the user: a wait that outlasts the delay, or a long turn that ended.
export class Phone {
  private config = load();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private warned = false;
  private dry = process.env.CW_PING_DRY === '1';

  // Read at push time so the settings switch applies at once. The mod's topic counts only until the app's own ntfy key exists.
  // The topic is a secret: never logged.
  private target() {
    if (config.ntfy) return config.ntfy;
    if ('ntfy' in rawConfig.value || !this.config.modTopic) return null;
    return { topic: this.config.modTopic, server: this.config.modServer };
  }

  // Title only: ntfy.sh is public, so no session text leaves the machine.
  private async push(title: string, fail: (text: string) => void) {
    if (this.dry) return void console.log(`phone-ping (dry run): would push "${title}"`);
    const to = this.target();
    if (!to) {
      if (!this.warned) console.log('phone-ping: no ntfy topic configured, pushes are off');
      this.warned = true;
      return;
    }
    try {
      const res = await fetch(`${to.server}/${to.topic}`, {
        method: 'POST', headers: { Title: 'tarcsweb', Priority: 'high', Tags: 'robot' }, body: title,
      });
      if (!res.ok) fail(`phone-ping: push failed (${res.status})`);
    } catch {
      fail('phone-ping: push failed (network)');
    }
  }

  schedule(sessionId: string, title: string, fail: (text: string) => void) {
    this.cancel(sessionId);
    this.timers.set(sessionId, setTimeout(() => {
      this.timers.delete(sessionId);
      void this.push(title, fail);
    }, this.config.delayMs));
  }

  cancel(sessionId: string) {
    clearTimeout(this.timers.get(sessionId));
    this.timers.delete(sessionId);
  }

  turnEnded(durationMs: number, fail: (text: string) => void) {
    if (durationMs < this.config.longTurnMs) return;
    const min = Math.round(durationMs / 60_000);
    void this.push(t({ en: `Claude finished (${min} min)`, 'pt-BR': `Claude terminou (${min} min)` }), fail);
  }

  close() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
