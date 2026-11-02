// Project commands (the run bar): a folder's dev servers, production build, one-shot actions and shortcuts.

// service: long-running; prod: build, then start; action: runs once and exits.
export type RunKind = 'service' | 'prod' | 'action';
export type RunSource = 'package.json' | 'workspace' | 'Makefile' | 'justfile' | 'compose' | 'Procfile' | 'Cargo' | 'app-qa' | 'agent' | 'repeat' | 'finder';

export type RunCommand = {
  id: string;
  label: string;
  command: string;
  // Relative to the folder; '' is the folder itself.
  cwd: string;
  kind: RunKind;
  destructive: boolean;
  source: RunSource;
  // prod only: runs first, and command starts only when it succeeds.
  build?: string;
  // The port it is expected to listen on, when the config says.
  port?: number;
  // A web front, so the row offers Open in Chrome.
  web?: boolean;
  hidden?: boolean;
  pinned?: boolean;
};

// A shortcut waiting for the user: from an agent, a repeated command or the finder. why says where it came from.
export type RunSuggestion = RunCommand & { why: string };

export type RunPhase = 'starting' | 'running' | 'done' | 'failed' | 'stopped' | 'blocked';

// stoppable is false for tarcsweb's own ports and processes this user cannot signal.
export type RunHolder = { pid: number; name: string; port: number; stoppable: boolean };

export type RunState = {
  id: string;
  phase: RunPhase;
  startedAt: number;
  endedAt?: number;
  exit?: number | null;
  // prod: [step, of].
  step?: [number, number];
  ports: number[];
  // Resident memory of the process tree, in MB.
  mb: number | null;
  // Who holds the port this run needs: before a start (blocked) or after an address-in-use failure.
  holder?: RunHolder;
  // The last error lines of a failed run.
  errors?: string;
};

export type RunFolder = {
  folder: string;
  pm: string | null;
  // The files the commands were found in, for the Edit button's hint.
  sources: string[];
  commands: RunCommand[];
  suggestions: RunSuggestion[];
  runs: RunState[];
  // Services running in other folders, for the build warning.
  elsewhere: number;
  finding: boolean;
  findError?: string;
};

export type RunEdit = { label?: string; hidden?: boolean; pinned?: boolean };

export type RunClientMessage =
  | { type: 'run-watch'; folder: string | null }
  | { type: 'run-start'; folder: string; id: string }
  | { type: 'run-stop'; folder: string; id: string }
  | { type: 'run-start-all'; folder: string }
  // Streams one run's log tail to this client; null stops.
  | { type: 'run-log'; folder: string; id: string | null }
  | { type: 'run-full-log'; folder: string; id: string }
  | { type: 'run-edit'; folder: string; id: string; edit: RunEdit }
  | { type: 'run-remove'; folder: string; id: string }
  | { type: 'run-suggestion'; folder: string; id: string; accept: false }
  // command and cwd as the user saw them; the server refuses if an agent changed them since.
  | { type: 'run-suggestion'; folder: string; id: string; accept: true; command: string; cwd: string }
  | { type: 'run-find'; folder: string }
  // Stops the process that holds the port a run needs, then starts the run.
  | { type: 'run-free-port'; folder: string; id: string; pid: number }
  | { type: 'run-open'; url: string };

export type RunServerMessage =
  | { type: 'run-folder'; folder: RunFolder }
  // Only the runs whose ports or memory changed.
  | { type: 'run-stats'; folder: string; stats: { id: string; ports: number[]; mb: number | null }[] }
  | { type: 'run-log'; folder: string; id: string; text: string }
  | { type: 'run-full-log'; folder: string; id: string; text: string };
