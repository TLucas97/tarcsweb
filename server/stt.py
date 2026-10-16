#!/usr/bin/env python3
"""Dictation engine: a hidden `claude` in a PTY whose voice mode does the speech-to-text.
JSON lines on stdin: {"cmd": "start" | "stop", "id": n}.
On stdout: {"ready": true}, {"fatal": ...}, and per take {"id": n, ...}: "state": "recording" | "transcribing",
then exactly one "text" or "error". A stop that does not apply gets {"id": n, "ignored": "stop"}.
Usage: python3 -I stt.py <work dir> <language code>"""
import fcntl, glob, json, os, pty, re, select, shlex, signal, struct, sys, termios, threading, time

# CLAUDE is the SDK's bundled binary, so voice runs the version the app pins, not the terminal's.
WORK, LANG, CLAUDE = sys.argv[1], sys.argv[2], sys.argv[3]
HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "stt_hook.py")
OUT = os.path.join(WORK, "prompt.json")
DEBUG = os.path.join(WORK, "debug.log")
ANSI = re.compile(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMcN]")
TRUST = re.compile(r"(?i)trust\s*this\s*folder|Yes,\s*I\s*trust")
PROMPT = re.compile(r"(?i)for\s*shortcuts|hold\s*space|to\s*speak|❯")
FINAL = re.compile(r"\[voice\] Final transcript assembled \((\d+) chars\)")
STARTED = "[voice] Starting recording session"
FAILED = re.compile(r"\[voice\] (Recording failed.*|Recording not available.*|circuit breaker.*|Failed to connect to voice_stream.*)")
SCREEN_MAX = 64 * 1024
# Claude ends a hold ~200 ms after the last space, so the repeat must stay well under that.
REPEAT_S = 0.04
# Claude starts a hold only after 5 quick spaces; sending them at once makes even a short take start.
BURST = b" " * 5
START_TIMEOUT_S = 4
FINAL_TIMEOUT_S = 25

out_lock = threading.Lock()


def emit(**msg):
    try:
        with out_lock:
            sys.stdout.write(json.dumps(msg) + "\n")
            sys.stdout.flush()
    except (BrokenPipeError, ValueError):
        engine.close()
        os._exit(0)


class Tail:
    """New lines of the debug log since the last call."""

    def __init__(self, path):
        self.path, self.pos, self.buf = path, 0, b""

    def lines(self):
        try:
            with open(self.path, "rb") as f:
                f.seek(self.pos)
                data = f.read()
        except FileNotFoundError:
            return []
        self.pos += len(data)
        parts = (self.buf + data).split(b"\n")
        self.buf = parts.pop()
        return [p.decode("utf-8", "replace") for p in parts if b"[voice]" in p]


class Engine:
    def __init__(self):
        self.pid = None
        self.fd = None
        self.screen = ""
        self.lock = threading.Lock()
        self.state = "boot"
        # Guards state and take, so a stop and the watcher's answer cannot interleave.
        self.take_lock = threading.Lock()
        self.take = None
        self.holding = False
        self.closing = False
        self.began = 0.0
        self.since = 0.0
        self.started = False
        self.tail = Tail(DEBUG)

    def spawn(self):
        os.makedirs(WORK, exist_ok=True)
        for p in (OUT, DEBUG):
            if os.path.exists(p):
                os.remove(p)
        settings = {
            "voice": {"enabled": True, "mode": "hold", "autoSubmit": False},
            "language": LANG,
            "hooks": {"UserPromptSubmit": [{"hooks": [{
                "type": "command",
                "command": f"python3 -I {shlex.quote(HOOK)} {shlex.quote(OUT)}",
                "timeout": 5,
                "onFailure": "block",
            }]}]},
        }
        # The server's own Claude Code variables must not leak in; DISABLE_AUTOUPDATER stops a silent CLI update.
        env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDECODE", "CLAUDE_CODE", "ANTHROPIC"))}
        env["TERM"] = "xterm-256color"
        env["DISABLE_AUTOUPDATER"] = "1"
        argv = [CLAUDE, "--setting-sources", "", "--settings", json.dumps(settings), "--strict-mcp-config", "--debug-file", DEBUG]
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            try:
                os.chdir(WORK)
                os.execve(CLAUDE, argv, env)
            finally:
                os._exit(127)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        threading.Thread(target=self.read_pty, daemon=True).start()

    def read_pty(self):
        while not self.closing:
            r, _, _ = select.select([self.fd], [], [], 0.2)
            if not r:
                continue
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                break
            if not data:
                break
            # Answer terminal queries so the TUI does not wait on them.
            if b"\x1b[6n" in data:
                self.send(b"\x1b[1;1R")
            if b"\x1b[c" in data:
                self.send(b"\x1b[?62;22c")
            with self.lock:
                self.screen = (self.screen + ANSI.sub("", data.decode("utf-8", "replace")))[-SCREEN_MAX:]
        if not self.closing:
            emit(fatal="Claude Code exited: " + self.last_line())
            self.close()
            os._exit(1)

    def last_line(self):
        with self.lock:
            lines = [l.strip() for l in self.screen.splitlines() if l.strip()]
        return lines[-1][:200] if lines else "no output"

    def send(self, b):
        try:
            os.write(self.fd, b)
        except OSError:
            pass

    def boot(self):
        self.spawn()
        end = time.time() + 40
        mark, trusted, moves = 0, False, 0
        while time.time() < end:
            with self.lock:
                screen = self.screen
            if not trusted and TRUST.search(screen):
                # Its own private work dir, so trusting it is safe. The dialog may preselect "No, exit".
                picked = screen[screen.rfind("❯") + 1:].split("\n")[0].strip()
                if picked.startswith("Yes") or moves >= 3:
                    trusted, mark = True, len(screen)
                    self.send(b"\r")
                else:
                    moves += 1
                    self.send(b"\x1b[B")
                    time.sleep(0.4)
            elif PROMPT.search(screen[mark:]) and not TRUST.search(screen[mark:]):
                time.sleep(1.5)
                self.tail.lines()
                self.state = "ready"
                emit(ready=True)
                return
            time.sleep(0.1)
        with self.lock:
            sys.stderr.write(self.screen[-1500:] + "\n")
        emit(fatal="Claude Code did not reach its prompt: " + self.last_line())
        self.close()
        os._exit(1)

    def hold(self):
        while self.holding:
            self.send(b" ")
            time.sleep(REPEAT_S)

    def start(self, take):
        if self.state != "ready":
            return emit(id=take, error=f"Voice input is busy ({self.state})")
        self.send(b"\x15")
        time.sleep(0.05)
        self.tail.lines()
        with self.take_lock:
            self.take, self.state, self.started, self.holding = take, "recording", False, True
            self.began = self.since = time.time()
            self.send(BURST)
            threading.Thread(target=self.hold, daemon=True).start()
            emit(id=take, state="recording")

    def stop(self, take):
        with self.take_lock:
            if take != self.take or self.state != "recording":
                return emit(id=take, ignored="stop")
            self.holding = False
            self.state, self.since = "transcribing", time.time()
            emit(id=take, state="transcribing")

    def finish(self, **answer):
        with self.take_lock:
            take, self.take, self.state = self.take, None, "ready"
            emit(id=take, **answer)

    def fail(self, error):
        self.holding = False
        time.sleep(0.3)
        self.send(b"\x15")
        self.finish(error=error)

    def capture(self):
        if os.path.exists(OUT):
            os.remove(OUT)
        self.send(b"\r")
        end = time.time() + 8
        text = None
        while time.time() < end:
            if os.path.exists(OUT):
                with open(OUT, encoding="utf-8") as f:
                    text = json.load(f).get("prompt", "")
                break
            time.sleep(0.05)
        # Blocking the prompt puts the text back in the input; one Ctrl+U clears only one wrapped line, so send plenty.
        time.sleep(0.2)
        self.send(b"\x15" * 40)
        if text is None:
            self.finish(error="Could not read the transcript")
        else:
            self.finish(text=text.strip())

    def watch(self):
        while not self.closing:
            time.sleep(0.05)
            if self.state not in ("recording", "transcribing"):
                continue
            for line in self.tail.lines():
                if STARTED in line:
                    self.started = True
                m = FAILED.search(line)
                if m:
                    self.fail(m.group(1)[:300])
                    break
                m = FINAL.search(line)
                if m:
                    self.holding = False
                    if int(m.group(1)) == 0:
                        self.fail("No speech detected")
                    else:
                        time.sleep(0.2)
                        self.capture()
                    break
            else:
                # A take released before Claude started recording never gets a final line, so it ends here too.
                if not self.started and time.time() - self.began > START_TIMEOUT_S:
                    self.fail("Voice mode did not start recording")
                elif self.state == "transcribing" and time.time() - self.since > FINAL_TIMEOUT_S:
                    self.fail("Transcription timed out")

    def close(self):
        if self.closing:
            return
        self.closing = True
        self.holding = False
        if self.pid:
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.kill(self.pid, sig)
                except ProcessLookupError:
                    break
                time.sleep(0.5)
            try:
                os.waitpid(self.pid, 0)
            except ChildProcessError:
                pass
        # Each boot leaves a tiny transcript of blocked prompts; nothing in it is worth keeping.
        config = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
        for p in glob.glob(os.path.join(glob.escape(config), "projects", re.sub(r"[^A-Za-z0-9]", "-", os.path.realpath(WORK)), "*.jsonl")):
            try:
                os.remove(p)
            except OSError:
                pass


engine = Engine()


def on_term(*_):
    engine.close()
    os._exit(0)


signal.signal(signal.SIGTERM, on_term)
signal.signal(signal.SIGINT, on_term)
engine.boot()
threading.Thread(target=engine.watch, daemon=True).start()
for raw in sys.stdin:
    try:
        msg = json.loads(raw)
        cmd, take = msg.get("cmd"), msg.get("id")
    except (ValueError, AttributeError):
        emit(ignored=raw.strip()[:200])
        continue
    if cmd == "start":
        engine.start(take)
    elif cmd == "stop":
        engine.stop(take)
    else:
        emit(id=take, ignored=str(cmd)[:50])
engine.close()
