#!/usr/bin/env python3
"""ElevenLabs character alignment -> word timings, with [audio tags] removed.
Usage: words.py alignment.json > words.json"""
import json, re, sys
a = json.load(open(sys.argv[1]))
text = "".join(a["characters"]); S = a["character_start_times_seconds"]; E = a["character_end_times_seconds"]
words = []
for m in re.finditer(r"\[[^\]]*\]|\S+", text):
    tok = m.group(0)
    if tok.startswith("[") and tok.endswith("]"):
        continue
    words.append({"w": tok, "s": round(S[m.start()], 3), "e": round(E[m.end() - 1], 3)})
json.dump(words, sys.stdout)
