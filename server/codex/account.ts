import { firstLine } from '../connect.ts';
import type { CodexLimitWindow, CodexLoginFlow, CodexLoginState, CodexModel, CodexStatus } from '../protocol.ts';
import { codex, CodexMissing, TESTED_VERSION } from './client.ts';
import type { AccountLoginCompletedNotification, Model, ModelListResponse, RateLimitSnapshot, RateLimitWindow } from './types.ts';

const LOGIN_MS = 10 * 60_000;
const MODEL_PAGES = 20;
const IDLE: CodexLoginState = { state: 'idle', flow: null, url: null, code: null, error: null };

const PLANS: Record<string, string> = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' };
const planName = (p: string | null | undefined) => (!p || p === 'unknown' ? null : `ChatGPT ${PLANS[p] ?? p.replace(/_/g, ' ')}`);
const errText = (e: unknown) => firstLine(e instanceof Error ? e.message : String(e));

const toWindow = (w: RateLimitWindow | null): CodexLimitWindow | null =>
  w && { usedPercent: w.usedPercent, windowMins: w.windowDurationMins, resetsAt: w.resetsAt === null ? null : w.resetsAt * 1000 };
const toModel = (m: Model): CodexModel => ({
  id: m.id, model: m.model, name: m.displayName, description: m.description, isDefault: m.isDefault,
  efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort), defaultEffort: m.defaultReasoningEffort,
  multiAgent: m.multiAgentVersion === 'v1' || m.multiAgentVersion === 'v2' ? m.multiAgentVersion : null,
  images: m.inputModalities.includes('image'),
});

// The Codex account behind the shared app-server: status, sign-in and sign-out, rate limits and the model catalog.
class CodexAccount {
  status: CodexStatus | null = null;
  login: CodexLoginState = IDLE;
  limits: RateLimitSnapshot | null = null;
  private running: Promise<CodexStatus> | null = null;
  private statusFns = new Set<(s: CodexStatus) => void>();
  private loginFns = new Set<(s: CodexLoginState) => void>();
  private loginId: string | null = null;
  private loginHold: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private catalog: CodexModel[] | null = null;
  private catalogLoad: Promise<CodexModel[]> | null = null;

  constructor() {
    codex.onNotification((method, params) => this.note(method, params));
    codex.onExit(() => {
      if (this.login.state === 'starting' || this.login.state === 'waiting') this.endLogin('Codex stopped. Try again.');
    });
  }

  subscribe(fn: (s: CodexStatus) => void) {
    this.statusFns.add(fn);
    return () => void this.statusFns.delete(fn);
  }

  subscribeLogin(fn: (s: CodexLoginState) => void) {
    this.loginFns.add(fn);
    return () => void this.loginFns.delete(fn);
  }

  check() {
    this.running ??= this.probe().then((s) => {
      this.running = null;
      this.emit(s);
      return s;
    });
    return this.running;
  }

  // After a sign-in change: a probe already running may have read the old state.
  recheck() {
    return (this.running ?? Promise.resolve()).then(() => this.check());
  }

  async startLogin(flow: CodexLoginFlow) {
    if (this.login.state !== 'idle') return;
    this.setLogin({ ...IDLE, state: 'starting', flow });
    // The browser flow's callback server lives inside the app-server, so it must outlive the idle timer.
    this.loginHold = codex.hold();
    try {
      const r = await codex.request('account/login/start', flow === 'device' ? { type: 'chatgptDeviceCode' } : { type: 'chatgpt' });
      const loginId = r.type === 'chatgpt' || r.type === 'chatgptDeviceCode' ? r.loginId : null;
      // Cancelled while Codex was answering.
      if (this.phase() !== 'starting') {
        if (loginId) void codex.request('account/login/cancel', { loginId }).catch(() => {});
        return;
      }
      if (r.type === 'chatgpt') this.setLogin({ state: 'waiting', url: r.authUrl });
      else if (r.type === 'chatgptDeviceCode') this.setLogin({ state: 'waiting', url: r.verificationUrl, code: r.userCode });
      else return this.endLogin(null);
      this.loginId = loginId;
      this.timer = setTimeout(() => this.cancelLogin('Sign-in timed out. Try again.'), LOGIN_MS);
    } catch (e) {
      this.endLogin(e instanceof CodexMissing ? e.message : `Could not start sign-in: ${errText(e)}`);
    }
  }

  cancelLogin(error: string | null = null) {
    if (this.login.state !== 'starting' && this.login.state !== 'waiting') return;
    const loginId = this.loginId;
    if (loginId) void codex.request('account/login/cancel', { loginId }).catch(() => {});
    this.endLogin(error);
  }

  async logout() {
    if (this.login.state !== 'idle') return;
    this.setLogin({ ...IDLE, state: 'signing-out' });
    let error: string | null = null;
    try {
      await codex.request('account/logout', undefined);
    } catch (e) {
      error = `Could not sign out: ${errText(e)}`;
    }
    this.accountChanged();
    await this.recheck();
    this.setLogin({ ...IDLE, error });
  }

  async rateLimits(): Promise<RateLimitSnapshot | null> {
    const r = await codex.request('account/rateLimits/read', undefined);
    this.limits = r.rateLimits;
    return this.limits;
  }

  // Cached for the life of the server; a sign-in change drops it.
  models(): Promise<CodexModel[]> {
    if (this.catalog) return Promise.resolve(this.catalog);
    this.catalogLoad ??= this.fetchModels().finally(() => (this.catalogLoad = null));
    return this.catalogLoad;
  }

  private async fetchModels() {
    const out: CodexModel[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MODEL_PAGES; page++) {
      const r: ModelListResponse = await codex.request('model/list', { cursor, limit: 100 });
      out.push(...r.data.map(toModel));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    this.catalog = out;
    return out;
  }

  private async probe(): Promise<CodexStatus> {
    const bin = await codex.checkBinary(true);
    const base: CodexStatus = {
      installed: !!bin.path, version: bin.version, versionOk: bin.versionOk, testedVersion: TESTED_VERSION,
      signedIn: false, method: null, email: null, plan: null, limits: null, error: null, checkedAt: Date.now(),
    };
    if (!bin.path) return base;
    try {
      const { account } = await codex.request('account/read', {});
      if (!account) return base;
      const st: CodexStatus = { ...base, signedIn: true };
      if (account.type === 'chatgpt') Object.assign(st, { method: 'chatgpt', email: account.email?.trim() || null, plan: planName(account.planType) });
      else if (account.type === 'apiKey') Object.assign(st, { method: 'apiKey', plan: 'API key' });
      else st.plan = 'Amazon Bedrock';
      // Usage is a bonus; the account shows without it.
      if (account.type === 'chatgpt') await this.rateLimits().catch(() => null);
      return { ...st, limits: this.limitsView() };
    } catch (e) {
      return { ...base, error: e instanceof CodexMissing ? null : errText(e), installed: !(e instanceof CodexMissing) };
    }
  }

  private limitsView(): CodexStatus['limits'] {
    const l = this.limits;
    return l && (l.primary || l.secondary) ? { primary: toWindow(l.primary), secondary: toWindow(l.secondary) } : null;
  }

  private note(method: string, params: unknown) {
    switch (method) {
      case 'account/login/completed': {
        const p = params as AccountLoginCompletedNotification;
        if (this.login.state !== 'waiting' || (p.loginId && p.loginId !== this.loginId)) return;
        this.endLogin(p.success ? null : p.error || 'Sign-in failed');
        if (p.success) {
          this.accountChanged();
          void this.recheck();
        }
        return;
      }
      case 'account/updated':
        this.accountChanged();
        if (this.status) void this.recheck();
        return;
      case 'account/rateLimits/updated': {
        // Sparse: a missing window or null metadata keeps what the last read said.
        const u = (params as { rateLimits: RateLimitSnapshot }).rateLimits;
        const cur = this.limits;
        if (cur && u.limitId && cur.limitId && u.limitId !== cur.limitId) return;
        this.limits = cur ? { ...cur, primary: u.primary ?? cur.primary, secondary: u.secondary ?? cur.secondary, credits: u.credits ?? cur.credits } : u;
        if (this.status?.signedIn) this.emit({ ...this.status, limits: this.limitsView() });
        return;
      }
    }
  }

  // A call, so TS does not keep a narrowing across awaits.
  private phase() {
    return this.login.state;
  }

  private accountChanged() {
    this.catalog = null;
    this.limits = null;
  }

  private endLogin(error: string | null) {
    clearTimeout(this.timer);
    this.loginId = null;
    this.loginHold?.();
    this.loginHold = null;
    this.setLogin({ ...IDLE, error });
  }

  private setLogin(patch: Partial<CodexLoginState>) {
    this.login = { ...this.login, ...patch };
    for (const fn of this.loginFns) fn(this.login);
  }

  private emit(s: CodexStatus) {
    this.status = s;
    for (const fn of this.statusFns) fn(s);
  }
}

export const codexAccount = new CodexAccount();
