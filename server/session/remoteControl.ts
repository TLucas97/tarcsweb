import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Provider, RemoteState } from '../protocol.ts';
import { bridgeState, phoneMessage, remoteUrl, type PhoneMessage, type RemoteControl as RemoteQuery } from '../remote.ts';
import { oneLine } from '../text.ts';
import { capAdd } from './util.ts';

type WithRemote = Query & RemoteQuery;
const OWN_TEXTS = 20;

export type RemoteHost = {
  id: string;
  cwd: string;
  q: () => Query | null;
  provider: () => Provider;
  name: () => string;
  resumeId: () => string | null;
  ensureStarted: () => void;
  armIdle: () => void;
  cliIdle: () => void;
  toast: (text: string) => void;
  onChange: () => void;
  // A turn sent from the phone, once its message was read from the transcript.
  phoneStart: (id: string, msg: PhoneMessage) => void;
  handle: (m: SDKMessage) => void;
};

// Remote Control: the CLI's bridge to the phone, and telling the phone's turns apart from ours.
export class Remote {
  private host: RemoteHost;
  // wanted outlives a CLI restart (it is turned on again); state is what the clients see, null when off.
  wanted = false;
  state: RemoteState | null = null;
  // Bumped on every enable, disable and CLI stop, so a late answer from an older call is dropped.
  private gen = 0;
  private enabling = false;
  // Prompt uuids this server sent and turn uuids already checked, so a phone turn stands out. Capped at ID_CAP.
  private ownIds = new Set<string>();
  private seenTurns = new Set<string>();
  // Prompts sent from here whose UserPromptSubmit has not fired yet, oldest first; capped at OWN_TEXTS.
  private ownTexts: string[] = [];
  // Stream messages held while a phone message is read from the transcript, so it lands before its reply.
  private phoneHold: SDKMessage[] | null = null;
  phoneTurn = false;

  constructor(host: RemoteHost) {
    this.host = host;
  }

  // Returns why it could not turn on (the CLI's own reason), or null.
  async set(on: boolean): Promise<string | null> {
    if (on && this.host.provider() === 'codex') return 'Remote Control works on Claude tabs only';
    if (!on) {
      this.wanted = false;
      this.gen++;
      this.setState(null);
      try {
        await (this.host.q() as WithRemote | null)?.enableRemoteControl?.(false);
      } catch {}
      this.host.armIdle();
      this.host.cliIdle();
      return null;
    }
    if (this.wanted && this.state?.state !== 'error') return null;
    this.wanted = true;
    this.host.ensureStarted();
    return this.enable();
  }

  private async enable(): Promise<string | null> {
    const q = this.host.q() as WithRemote | null;
    const gen = ++this.gen;
    if (!q) return this.failed("Claude Code isn't running for this session");
    if (typeof q.enableRemoteControl !== 'function') return this.failed("This Claude Code version can't do Remote Control");
    this.setState({ state: 'connecting', url: null });
    this.enabling = true;
    try {
      const r = await q.enableRemoteControl(true, this.host.name());
      if (gen !== this.gen || !this.wanted) return null;
      this.setState({ state: 'on', url: remoteUrl(r) });
      return null;
    } catch (err) {
      return gen === this.gen ? this.failed(oneLine(err instanceof Error ? err.message : String(err), 300)) : null;
    } finally {
      if (gen === this.gen) this.enabling = false;
    }
  }

  private failed(why: string) {
    this.wanted = false;
    this.setState(null);
    this.host.cliIdle();
    return why;
  }

  // A restarted CLI drops the bridge; it comes back with a new session page.
  resume() {
    if (!this.wanted) return;
    this.host.ensureStarted();
    void this.enable().then((why) => why && this.host.toast(`Remote Control is off: ${why}`));
  }

  private setState(next: RemoteState | null) {
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    this.host.onChange();
  }

  bridge(state: unknown, detail: unknown, kind: unknown) {
    if (!this.wanted || !this.state) return;
    const next = bridgeState(state, detail, kind, this.state);
    // Until enable answers, only a final failure is news; the answer brings the url.
    if (this.enabling && next.state !== 'error') return;
    if (next.state === 'error') {
      this.wanted = false;
      this.gen++;
      this.host.toast(`Remote Control stopped: ${next.error}`);
    }
    this.setState(next);
  }

  // The bridge dies with the process; resume brings it back when it is still wanted.
  cliStopped() {
    this.gen++;
    if (this.state) this.setState(this.wanted ? { state: 'connecting', url: null } : null);
  }

  cliExited() {
    if (this.state) this.host.toast('Remote Control stopped: Claude Code exited');
    this.wanted = false;
    this.gen++;
    this.setState(null);
  }

  // A prompt sent from here; only the end of its text is kept: enough to match it, small with large pastes.
  sent(uuid: string, text: string) {
    capAdd(this.ownIds, uuid);
    this.ownTexts.push(text.trim().slice(-500));
    if (this.ownTexts.length > OWN_TEXTS) this.ownTexts.shift();
  }

  // The hook only gets the text: a prompt matching one sent from here is ours (and is dropped); the rest came over Remote Control.
  ownPrompt(prompt: string) {
    const i = this.ownTexts.findIndex((t) => !t || prompt.includes(t));
    if (i < 0) return false;
    this.ownTexts.splice(i, 1);
    return true;
  }

  // True when the message is held: a phone turn just showed up, or its prompt is still being read.
  intercept(m: SDKMessage) {
    if (this.phoneHold) {
      this.phoneHold.push(m);
      return true;
    }
    const turn = this.remoteTurn(m);
    if (!turn) return false;
    this.phoneHold = [m];
    void this.phoneArrived(turn);
    return true;
  }

  // A turn the web did not send: its uuid shows on the lifecycle start or on the reply, never as a user message.
  private remoteTurn(m: SDKMessage) {
    if (!this.wanted) return null;
    const raw = m as unknown as { type: string; state?: string; command_uuid?: string; user_message_uuid?: string; parent_tool_use_id?: string | null };
    const id = raw.type === 'command_lifecycle' ? (raw.state === 'started' ? raw.command_uuid : undefined) : raw.type === 'assistant' && !raw.parent_tool_use_id ? raw.user_message_uuid : undefined;
    if (!id || this.ownIds.has(id) || this.seenTurns.has(id)) return null;
    capAdd(this.seenTurns, id);
    return id;
  }

  // Holds the stream while the phone's message is read, then replays it, so the prompt lands before its reply.
  private async phoneArrived(uuid: string) {
    try {
      const msg = await phoneMessage(this.host.cwd, this.host.resumeId() ?? this.host.id, uuid);
      if (msg) this.host.phoneStart(uuid, msg);
    } catch {}
    const held = this.phoneHold ?? [];
    this.phoneHold = null;
    for (const m of held) this.host.handle(m);
  }
}
