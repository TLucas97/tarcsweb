#!/usr/bin/env python3
# UserPromptSubmit hook of the hidden dictation session: save the prompt for stt.py and always block it.
import json, os, sys

out = sys.argv[1]
data = json.load(sys.stdin)
tmp = out + ".tmp"
with open(tmp, "w") as f:
    json.dump({"prompt": data.get("prompt", "")}, f)
os.replace(tmp, out)
print(json.dumps({
    "decision": "block",
    "reason": "captured",
    "hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "suppressOriginalPrompt": True},
}))
