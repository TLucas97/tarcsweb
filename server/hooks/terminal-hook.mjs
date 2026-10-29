// Claude Code hook from tarcsweb (Settings › Terminal sessions): forwards a terminal session's events to the app.
// On PermissionRequest it waits for the app's answer; no answer or no app means no output, so the terminal asks.
import { readFileSync, readdirSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';

// The server waits 120 s; this leaves room for its empty reply.
const ASK_MS = 125_000;
const EVENT_MS = 3000;

// tarcsweb's own CLIs answer asks through the SDK, so their hooks stay out.
if (process.env.CWEB_OWNED === '1' || !process.argv[2]) process.exit(0);

// Newest first; a file left behind by a crashed server has a dead pid.
function servers(dir) {
  let names = [];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of names) {
    try {
      const s = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      process.kill(s.pid, 0);
      if (Number.isInteger(s.port) && typeof s.token === 'string') out.push(s);
    } catch {}
  }
  return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

// Resolves with the reply body on 200, null on anything else.
function post(s, body, ms) {
  return new Promise((done) => {
    const req = request({
      host: '127.0.0.1', port: s.port, path: '/hook/terminal', method: 'POST', timeout: ms,
      headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => done(res.statusCode === 200 ? text : null));
      res.on('error', () => done(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => done(null));
    req.end(body);
  });
}

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;
let input;
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}
if (!input || typeof input !== 'object') process.exit(0);
// Tool output and the last reply can be megabytes; the app needs neither.
delete input.tool_response;
delete input.last_assistant_message;
const ask = input.hook_event_name === 'PermissionRequest';
const body = JSON.stringify({ at: Date.now(), input });
for (const s of servers(process.argv[2])) {
  const text = await post(s, body, ask ? ASK_MS : EVENT_MS);
  if (text === null) continue;
  let decision;
  try {
    decision = JSON.parse(text).decision;
  } catch {}
  if (ask && decision) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }));
  break;
}
process.exit(0);
