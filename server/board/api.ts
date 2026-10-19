// Wire contract of board AI jobs, shared by server and client (no Node imports). Routes: serveBoard in http.ts.

export const BOARD_API = '/api/board';

// Region PNG: longest side in px, and upload size.
export const REGION_PX_MAX = 2000;
export const REGION_BYTES_MAX = 12 << 20;
export const PROMPT_MAX = 2000;
// Overview PNG of the whole drawing: longest side in px. Context: read-only neighbours, by count and JSON size.
export const OVERVIEW_PX_MAX = 1200;
export const CONTEXT_MAX = 60;
export const CONTEXT_BYTES_MAX = 16 << 10;
// Submit body (elements JSON included) and returned elements JSON text.
export const SUBMIT_BYTES_MAX = 1 << 20;
export const RESULT_BYTES_MAX = 1 << 20;

export type SubmitBody = {
  // Asset id from POST /assets.
  image: string;
  // The region's elements JSON, as toJSON exported it.
  elements: { w: number; h: number; elements: unknown[] };
  // Empty means the base prompt: clean up the lines, keep the layout.
  prompt: string;
  // Size the result document should have, in the same units as `elements`.
  target: { w: number; h: number };
  // What stays on the board around the region; absent when nothing does. The model reads it but never returns it.
  context?: BoardContext;
  // Board revision at submit; echoed so a later adapter or the client can tell stale results.
  revision: number;
  // Adapter id; the server default when absent.
  provider?: string;
  // Model and reasoning effort for this job; the server clamps them to what the account offers.
  model?: string;
  effort?: string;
  // The model's "Fast" service tier, which uses more of the Codex limit; only honored when the model offers it.
  fast?: boolean;
};

export type BoardContext = {
  // Elements near the region in the same coordinates as `elements` (they may lie outside its box); ids are "c1", "c2", ...
  elements: unknown[];
  // Asset id of the whole drawing scaled down, region outlined; `box` is the area it shows, in region coordinates.
  overview?: { image: string; box: { x: number; y: number; w: number; h: number } };
};

// The service tier the Fast toggle asks for.
export const FAST_TIER = 'priority';

// Used until the person picks something else in the refine field.
export const BOARD_DEFAULT = { model: 'gpt-6-astra', effort: 'high' };

// provider: the adapter id that runs this model; the picker groups by it and the job sends it back.
export type BoardModel = { id: string; name: string; description: string; isDefault: boolean; efforts: string[]; defaultEffort: string; tiers: string[]; provider: string };
// Picker group labels by provider id.
export const PROVIDER_LABELS: Record<string, string> = { codex: 'Codex', claude: 'Claude' };
// GET models: every provider's list; error names the providers that could not list theirs.
export type ModelsReply = { models: BoardModel[]; default: { model: string; effort: string }; error: string | null };

export type JobEvent =
  | { type: 'progress'; step: number; of: number; text: string }
  // `json` is the adapter's raw elements JSON text; the client validates it before it touches the board.
  | { type: 'done'; json: string; revision: number; ms: number }
  | { type: 'failed'; error: string }
  | { type: 'cancelled' };
