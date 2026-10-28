#!/usr/bin/env python3
"""Mix voiceover + music + SFX against the scene's cue sheet, then mux with the silent render.

Usage: mix.py <workdir> [--no-mux]
Reads <workdir>/mix.json and <workdir>/cues.json (from cues.cjs). Writes mix.wav and final.mp4.

mix.json:
{
  "vo": "takes/roger_v4_tags.mp3", "vo_delay": 0.5, "duration": 91,
  "music": "audio/music_a.mp3", "music_gain_db": -7, "music_fade_out": 2.5, "music_delay": 0,
  "events": [
    {"file": "audio/riser.mp3", "at": 0, "gain_db": -16},
    {"file": "audio/swoosh_a.mp3", "cue": "s1", "offset": -0.55, "gain_db": -15}
  ]
}
An event uses either an absolute "at" (film seconds) or a "cue" name from cues.json plus "offset".
Loudness: two-pass loudnorm to -14 LUFS integrated, -1.5 dBTP (typical social-video delivery target).
"""
import json
import subprocess
import sys
from pathlib import Path

W = Path(sys.argv[1])
cfg = json.loads((W / "mix.json").read_text())
cues = json.loads((W / "cues.json").read_text())
DUR = float(cfg["duration"])
delay_ms = int(float(cfg.get("vo_delay", 0)) * 1000)
FADE = float(cfg.get("music_fade_out", 2.5))
MDELAY = int(float(cfg.get("music_delay", 0)) * 1000)

ROOT = W.resolve()


def inside(rel):
    # Config paths must stay inside the work dir.
    path = (W / rel).resolve()
    if not path.is_relative_to(ROOT):
        sys.exit(f"mix.json path escapes the work dir: {rel}")
    return path


events = []
for e in cfg.get("events", []):
    t = e["at"] if "at" in e else cues[e["cue"]] + e.get("offset", 0)
    events.append((inside(e["file"]), max(0.0, t), e.get("gain_db", -15)))

inputs = ["-i", str(inside(cfg["vo"])), "-i", str(inside(cfg["music"]))]
for path, _, _ in events:
    inputs += ["-i", str(path)]

f = [
    # Voice: clean low end, gentle compression, a touch of presence.
    f"[0:a]aresample=48000,highpass=f=80,acompressor=threshold=-20dB:ratio=2.5:attack=8:release=120:makeup=2,"
    f"equalizer=f=3200:t=q:w=1.2:g=2,adelay={delay_ms}:all=1,apad=whole_dur={DUR}[vo]",
    "[vo]asplit=2[vo_mix][vo_key]",
    # Music: fade in/out, then duck under the voice (sidechain) so it swells back in the gaps.
    f"[1:a]aresample=48000,adelay={MDELAY}:all=1,atrim=0:{DUR},afade=t=in:st=0:d=2.5,afade=t=out:st={DUR - FADE}:d={FADE},"
    f"volume={cfg.get('music_gain_db', -7)}dB[mus]",
    "[mus][vo_key]sidechaincompress=threshold=0.03:ratio=6:attack=40:release=600:makeup=1[mus_d]",
]
labels = []
for i, (_, t, g) in enumerate(events):
    f.append(f"[{i + 2}:a]aresample=48000,volume={g}dB,adelay={int(t * 1000)}:all=1[s{i}]")
    labels.append(f"[s{i}]")
f.append(f"[vo_mix][mus_d]{''.join(labels)}amix=inputs={2 + len(labels)}:normalize=0:duration=first,atrim=0:{DUR}[pre]")

pre = W / "premix.wav"
subprocess.run(["ffmpeg", "-loglevel", "error", "-y", *inputs, "-filter_complex", ";".join(f),
                "-map", "[pre]", "-ac", "2", str(pre)], check=True)

probe = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(pre), "-af",
                        "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"],
                       capture_output=True, text=True).stderr
m = json.loads(probe[probe.rindex("{"):probe.rindex("}") + 1])
ln = (f"loudnorm=I=-14:TP=-1.5:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:"
      f"measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true")
mix = W / "mix.wav"
subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(pre), "-af", ln, "-ar", "48000", str(mix)], check=True)
print("premix", m["input_i"], "LUFS -> -14 LUFS")

if "--no-mux" not in sys.argv:
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(W / "silent.mp4"), "-i", str(mix),
                    "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                    "-shortest", "-movflags", "+faststart", str(W / "final.mp4")], check=True)
    print("wrote", W / "final.mp4")
