// OpenCode 2.x shapes shared by the server and the web app.

// The app's model id is `opencode:<providerID>/<modelID>`; efforts are the model's OpenCode variants.
export const OPENCODE_PREFIX = 'opencode:';

export type OpencodeModel = {
  id: string; providerID: string; modelID: string; name: string; providerName: string;
  efforts: string[]; defaultEffort: string | null; contextWindow: number | null; images: boolean;
};

export type OpencodeIntegration = { id: string; name: string; connected: boolean; needsAuth: string | null };

export type OpencodeStatus = {
  installed: boolean; version: string | null; versionOk: boolean;
  // connected: the catalog has at least one usable model (free models count).
  connected: boolean; integrations: OpencodeIntegration[]; models: number;
  error: string | null; checkedAt: number;
};
