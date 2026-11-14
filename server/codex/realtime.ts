import { CodexClient, CodexError } from './client.ts';
import { tuning } from '../profile.ts';

// Shared transport only: calls and recaps own separate threads and release only their own holds.
export const callCodex = new CodexClient({ label: 'call', args: ['--enable', 'realtime_conversation'], idleMs: () => tuning().callCodexIdleMs });
callCodex.setRequestHandler(async (req) => {
  if (req.method === 'item/commandExecution/requestApproval' || req.method === 'item/fileChange/requestApproval') return { decision: 'decline' };
  throw new CodexError(`Voice does not handle ${req.method}`, -32601);
});
