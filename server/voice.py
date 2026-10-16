#!/usr/bin/env python3
"""Renders text on stdin into one 16-bit mono WAV with Kokoro, like say.py's "whole" mode.
Usage: voice.py out.wav [voice] [speed] [lang]"""
import os, re, sys, wave
import numpy as np
from kokoro_onnx import Kokoro

home = os.path.expanduser("~/.local/share/kokoro-tts")
out = sys.argv[1]
voice = sys.argv[2] if len(sys.argv) > 2 else "pf_dora"
speed = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0
lang = sys.argv[4] if len(sys.argv) > 4 else "pt-br"
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

k = Kokoro(os.path.join(home, "kokoro-v1.0.onnx"), os.path.join(home, "voices-v1.0.bin"))

class _FloatSpeed:
    """kokoro-onnx 0.4.7 sends speed as int32 to the v1.1 export, which wants float."""
    def __init__(self, sess): self._s = sess
    def get_inputs(self): return self._s.get_inputs()
    def run(self, names, feed, *a):
        if "speed" in feed: feed["speed"] = np.asarray(feed["speed"], dtype=np.float32)
        return self._s.run(names, feed, *a)
k.sess = _FloatSpeed(k.sess)

clips, rate = [], 24000
for piece in chunks(text):
    samples, rate = k.create(piece, voice=voice, speed=speed, lang=lang)
    clips.append(trim(samples, rate))
if not clips:
    sys.exit("no audio")
pcm = (np.clip(np.concatenate(clips), -1, 1) * 32767).astype("<i2").tobytes()
# Written aside and renamed, so the server never serves half a file.
tmp = out + ".part"
with wave.open(tmp, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(rate)
    w.writeframes(pcm)
os.replace(tmp, out)
