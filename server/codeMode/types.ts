import type { Mode } from '../protocol.ts';

// Code Mode: the model writes one JS program; each tool call inside it crosses this contract.
// sandbox.ts runs the program, gate.ts applies the user's hooks, rules and mode, tools.ts executes.

// The CLI tools a program can call, in the CLI's own input shape so hooks and rules see what they expect.
export type InnerTool = 'Bash' | 'Read' | 'Glob' | 'Grep';
export const INNER_TOOLS: InnerTool[] = ['Bash', 'Read', 'Glob', 'Grep'];

// Bash: { command, timeout? (ms), description? }
// Read: { file_path (absolute), offset? (1-based line), limit? (lines) }
// Glob: { pattern, path? }
// Grep: { pattern, path?, glob?, type?, output_mode?: 'content' | 'files_with_matches' | 'count', '-i'?, '-n'?, '-A'?, '-B'?, '-C'?, multiline?, head_limit? }
export type InnerCall = { id: string; tool: InnerTool; input: Record<string, unknown> };

// What the host resolves for each tool; a denied or failed call rejects with an Error whose message the program sees.
export type BashData = { stdout: string; stderr: string; exitCode: number; interrupted: boolean; truncated?: boolean };
// cut: a line was longer than 2000 chars and lost its end. capped: the file's size, when only its first 5 MB were read.
export type ReadData = { text: string; totalLines: number; truncated: boolean; cut?: boolean; capped?: number };
export type GlobData = { files: string[]; truncated: boolean };
export type GrepData = { output: string; truncated: boolean };
export type InnerData = BashData | ReadData | GlobData | GrepData;

// The program's only way out: one async call per tool use. args is plain JSON.
export type HostCall = (tool: InnerTool, args: Record<string, unknown>) => Promise<InnerData>;

export type RunLimits = {
  cpuMs: number; // the program's own run time, waits on host calls excluded
  wallMs: number; // whole run, waits included
  memoryBytes: number;
  maxOutputChars: number; // returned value + logs, after JSON encoding
};
export type RunResult = { ok: true; value: string; logs: string[]; truncated: boolean } | { ok: false; error: string; logs: string[]; truncated: boolean };

// One permission outcome for an inner call; input is the one to execute (a hook may have rewritten it).
export type SearchPathFilter = (path: string) => Promise<boolean>;
export type Decision = { allow: true; input: Record<string, unknown>; context: string[]; searchPathAllowed?: SearchPathFilter; searchNote?: () => string | undefined } | { allow: false; message: string; context: string[] };

export type GateContext = {
  cwd: string;
  mode: Mode;
  sessionId: string;
  transcriptPath: string;
  signal: AbortSignal;
  // false: a PreToolUse hook's new Bash input is dropped (its decision still counts), from Settings › Context.
  hookRewrites: boolean;
  // Shows the app's permission card for this call and waits; why is a short reason shown with it, when there is one.
  ask: (call: InnerCall, why: string | null) => Promise<{ allow: true; input: Record<string, unknown> } | { allow: false; message: string }>;
};

export type ToolOutput = { data: InnerData; isError: boolean };
