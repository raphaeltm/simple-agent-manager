#!/usr/bin/env python3
"""Objective prosody metrics for voiceover takes.

We cannot listen to audio, so compare takes with numbers that track how
"read-aloud" a voice sounds. Flat, mechanical TTS has a narrow pitch range,
little loudness movement, and even pacing with uniform pauses.

Usage: prosody_report.py take1.mp3 [take2.mp3 ...]
A sibling <take>.json with ElevenLabs character alignment is optional.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import parselmouth


def to_wav(path: Path) -> str:
    out = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(path), "-ac", "1", "-ar", "44100", out], check=True)
    return out


def words_from_alignment(alignment):
    chars = alignment["characters"]
    starts = alignment["character_start_times_seconds"]
    ends = alignment["character_end_times_seconds"]
    words, cur, s = [], "", None
    for ch, st, en in zip(chars, starts, ends):
        if ch.isspace():
            if cur:
                words.append((cur, s, prev_end))
            cur, s = "", None
            continue
        if s is None:
            s = st
        cur += ch
        prev_end = en
    if cur:
        words.append((cur, s, prev_end))
    return words


def report(path: Path):
    snd = parselmouth.Sound(to_wav(path))
    pitch = snd.to_pitch_ac(time_step=0.01, pitch_floor=70, pitch_ceiling=400)
    f0 = pitch.selected_array["frequency"]
    f0 = f0[f0 > 0]
    st = 12 * np.log2(f0 / np.median(f0))
    inten = snd.to_intensity(time_step=0.01).values[0]
    voiced_db = inten[inten > inten.max() - 35]
    row = {
        "take": path.stem,
        "dur_s": round(snd.duration, 2),
        "f0_median_hz": round(float(np.median(f0)), 1),
        "f0_sd_semitones": round(float(st.std()), 2),
        "f0_range_p5_p95_st": round(float(np.percentile(st, 95) - np.percentile(st, 5)), 2),
        "loudness_sd_db": round(float(voiced_db.std()), 2),
    }
    align = path.with_suffix(".json")
    if align.exists():
        words = words_from_alignment(json.loads(align.read_text()))
        gaps = [b[1] - a[2] for a, b in zip(words, words[1:])]
        pauses = [g for g in gaps if g > 0.18]
        durs = [(e - s) / max(len(w), 1) for w, s, e in words]
        row.update(
            {
                "words_per_min": round(len(words) / (words[-1][2] - words[0][1]) * 60, 1),
                "pauses_gt_180ms": len(pauses),
                "pause_sd_s": round(float(np.std(pauses)), 3) if pauses else 0,
                "per_char_dur_cv": round(float(np.std(durs) / np.mean(durs)), 3),
            }
        )
    return row


if __name__ == "__main__":
    rows = [report(Path(p)) for p in sys.argv[1:]]
    keys = list(rows[0].keys())
    print("\t".join(keys))
    for r in rows:
        print("\t".join(str(r.get(k, "")) for k in keys))
