#!/usr/bin/env python3
"""Renders text on stdin into one 16-bit mono WAV with Kokoro, like say.py's "whole" mode.
Mode "robot" (or "robot-g", glitched) renders a short line in the sound robot's voice instead.
Usage: voice.py out.wav [voice] [speed] [lang] [mode]"""
import os, re, sys, wave
import numpy as np
from kokoro_onnx import Kokoro

home = os.path.expanduser("~/.local/share/kokoro-tts")
out = sys.argv[1]
voice = sys.argv[2] if len(sys.argv) > 2 else "pf_dora"
speed = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0
lang = sys.argv[4] if len(sys.argv) > 4 else "pt-br"
mode = sys.argv[5] if len(sys.argv) > 5 else "plain"
text = sys.stdin.read().strip()
if not text:
    sys.exit("no text")

MAX_WORDS = 30

def chunks(text):
    # Same split as say.py: sentences, long ones cut at commas.
    for sent in re.split(r"(?<=[.!?:;])\s+", text):
        words = sent.split()
        if len(words) <= MAX_WORDS:
            if words:
                yield sent
            continue
        buf = []
        for part in re.split(r"(?<=,)\s+", sent):
            buf.append(part)
            if sum(len(p.split()) for p in buf) >= MAX_WORDS // 2:
                yield " ".join(buf)
                buf = []
        if buf:
            yield " ".join(buf)

def trim(samples, rate, keep=0.06):
    loud = np.flatnonzero(np.abs(samples) > 0.01)
    if loud.size == 0:
        return samples[:0]
    pad = int(rate * keep)
    return samples[max(0, loud[0] - pad):loud[-1] + pad]

# The robot's treatment, glitch and chirps, ported from notes/promo/tools (robovoice.py "a-metal", robolines.py).
SR = 48000
rng = np.random.default_rng()

def norm(x):
    return x / max(np.abs(x).max(), 1e-9)

def ringmod(x, hz, depth):
    t = np.arange(len(x)) / SR
    return x * ((1 - depth) + depth * np.sin(2 * np.pi * hz * t))

def comb(x, ms, fb, mix):
    # Feedback comb filled one delay-length block at a time; each block only reads the finished one before it.
    d = int(SR * ms / 1000); y = x.copy()
    for s in range(d, len(y), d):
        n = len(y[s:s + d])
        y[s:s + n] += fb * y[s - d:s - d + n]
    return (1 - mix) * x + mix * y * np.abs(x).max() / max(np.abs(y).max(), 1e-9)

def onsets(x, n):
    e = np.convolve(np.abs(x), np.ones(480) / 480, "same")
    d = np.diff(e[::240]); idx = np.argsort(d)[::-1][: n * 3] * 240
    idx = idx[(idx > 0.05 * len(x)) & (idx < 0.85 * len(x))]
    return rng.choice(idx, min(n, len(idx)), replace=False) if len(idx) else []

def chirps(base):
    out = []
    for _ in range(int(rng.integers(4, 7))):
        f = base * 2 ** ([0, 3, 5, 7, 10, 12][rng.integers(6)] / 12)
        t = np.arange(int(SR * 0.028)) / SR
        b = sum(np.sin(2 * np.pi * f * k * t) / k for k in (1, 3, 5, 7))
        out.append(b * np.clip(t / 0.003, 0, 1) * np.clip((0.028 - t) / 0.006, 0, 1))
    return np.concatenate(out)

def glitch(x):
    """One or two misfires at syllable starts: a stutter, a pitch jump or a low-res stretch."""
    x = x.copy()
    for kind in rng.choice(["stutter", "jump", "crunch"], int(rng.integers(1, 3)), replace=False):
        pts = onsets(x, 1)
        if not len(pts):
            continue
        s = int(pts[0])
        if kind == "stutter":
            seg = x[s:s + int(rng.uniform(0.06, 0.09) * SR)]
            x = np.concatenate([x[:s], seg, seg * 0.85, x[s:]])
        elif kind == "jump":
            L = int(rng.uniform(0.08, 0.13) * SR); r = [1.5, 2.0, 0.6][rng.integers(3)]
            seg = x[s:s + L]
            seg = np.interp(np.arange(0, len(seg), r), np.arange(len(seg)), seg)
            x = np.concatenate([x[:s], seg, x[s + L:]])
        else:
            k_ = int(rng.integers(5, 9))
            seg = x[s:s + int(0.15 * SR)]
            x[s:s + len(seg)] = 0.4 * seg + 0.6 * np.repeat(seg[::k_], k_)[: len(seg)]
    return x

def with_chirps(y):
    if rng.random() < 0.6:
        c = chirps(rng.uniform(700, 1000)) * 0.12
        s = int(rng.uniform(0.2, 0.7) * len(y))
        y = y.copy(); y[s:s + len(c)] += c[: len(y) - s]
    return y

def robot(samples, rate, glitched):
    loud = np.flatnonzero(np.abs(samples) > 0.01)
    if loud.size == 0:
        sys.exit("no audio")
    s = samples[loud[0]:loud[-1]]
    v = np.interp(np.arange(int(len(s) * SR / rate)) * rate / SR, np.arange(len(s)), s)
    if glitched:
        v = glitch(v)
    y = comb(ringmod(v, 45, 0.35), 2.2, 0.5, 0.35)
    # Same peak as the prerecorded lines in web/public/sounds.
    return norm(with_chirps(norm(y)) if glitched else y) * 0.45

k = Kokoro(os.path.join(home, "kokoro-v1.0.onnx"), os.path.join(home, "voices-v1.0.bin"))

class _FloatSpeed:
    """kokoro-onnx 0.4.7 sends speed as int32 to the v1.1 export, which wants float."""
    def __init__(self, sess): self._s = sess
    def get_inputs(self): return self._s.get_inputs()
    def run(self, names, feed, *a):
        if "speed" in feed: feed["speed"] = np.asarray(feed["speed"], dtype=np.float32)
        return self._s.run(names, feed, *a)
k.sess = _FloatSpeed(k.sess)

if mode.startswith("robot"):
    samples, rate = k.create(text, voice=voice, speed=speed, lang=lang)
    y, rate = robot(samples, rate, mode == "robot-g"), SR
else:
    clips, rate = [], 24000
    for piece in chunks(text):
        samples, rate = k.create(piece, voice=voice, speed=speed, lang=lang)
        clips.append(trim(samples, rate))
    if not clips:
        sys.exit("no audio")
    y = np.concatenate(clips)
pcm = (np.clip(y, -1, 1) * 32767).astype("<i2").tobytes()
# Written aside and renamed, so the server never serves half a file.
tmp = out + ".part"
with wave.open(tmp, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(rate)
    w.writeframes(pcm)
os.replace(tmp, out)
