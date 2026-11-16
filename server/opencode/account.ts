import { opencode, type Location } from './client.ts';
import { checkBinary } from './server.ts';
import { OPENCODE_PREFIX, type OpencodeModel, type OpencodeStatus } from './types.ts';

const TTL_MS = 30_000;

class OpencodeAccount {
  status: OpencodeStatus | null = null;
  private catalog: OpencodeModel[] = [];
  private running: Promise<OpencodeStatus> | null = null;
  private listeners = new Set<(status: OpencodeStatus) => void>();
  private directory: string | undefined;

  subscribe(fn: (status: OpencodeStatus) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  async get(location?: Location) {
    if (this.status && this.directory === location?.directory && Date.now() - this.status.checkedAt < TTL_MS) return this.status;
    return this.check(location);
  }

  check(location?: Location): Promise<OpencodeStatus> {
    if (this.running) return this.running.then(() => this.directory === location?.directory ? this.status! : this.check(location));
    this.running = this.probe(location).then((status) => {
      this.status = status;
      this.directory = location?.directory;
      for (const fn of this.listeners) fn(status);
      return status;
    }).finally(() => { this.running = null; });
    return this.running;
  }

  get cachedModels() { return this.catalog; }

  async models(location?: Location) {
    await this.get(location);
    return this.catalog;
  }

  private async probe(location?: Location): Promise<OpencodeStatus> {
    const binary = await checkBinary();
    const status: OpencodeStatus = { installed: !!binary.path, version: binary.version, versionOk: binary.versionOk, connected: false, integrations: [], models: 0, error: null, checkedAt: Date.now() };
    this.catalog = [];
    if (!binary.path) return status;
    if (!binary.versionOk) return { ...status, error: 'OpenCode 2.x is required' };
    try {
      const [integrations, models, providers] = await Promise.all([opencode.integrations(location), opencode.models(location), opencode.providers(location)]);
      status.integrations = integrations.data.map((i) => ({ id: i.id, name: i.name, connected: i.connections.some((c) => !c.status), needsAuth: i.connections.find((c) => c.status?.status === 'needs_auth')?.status?.message ?? null }));
      this.catalog = models.data.map((m) => {
        const efforts = m.variants.map((v) => v.id);
        return { id: `${OPENCODE_PREFIX}${m.providerID}/${m.id}`, providerID: m.providerID, modelID: m.id, name: m.name, providerName: providers.data.find((p) => p.id === m.providerID)?.name ?? m.providerID, efforts, defaultEffort: efforts.includes('medium') ? 'medium' : efforts.includes('high') ? 'high' : efforts[0] ?? null, contextWindow: m.limit.input ?? m.limit.context ?? null, images: m.capabilities.input.includes('image') };
      });
      status.models = this.catalog.length;
      // The catalog lists only usable models, and OpenCode's free models need no integration login.
      status.connected = status.models > 0;
      return status;
    } catch (error) {
      return { ...status, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

export const opencodeAccount = new OpencodeAccount();
