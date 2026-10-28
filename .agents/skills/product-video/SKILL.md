---
name: product-video
description: Produce a narrated SAM product video (weekly recap, blog companion, feature walkthrough) with a natural-sounding ElevenLabs voiceover, real app screenshots in animated glass frames, ethereal music and a voice-ducked mix. Use when asked for a marketing, social, recap or blog video.
user-invocable: true
---

# Product Video

Make a 15–100 second video that walks a viewer through what SAM changed, framed around the problem they have and how SAM now removes it. The output is a 1920x1080 MP4 with voiceover, music and captions, delivered to the project Library for review. Never post anywhere without explicit approval.

Everything lives in a scratch dir (`.tmp/<video-name>/`). Copy `tools/` and `templates/` from this skill into it, and put screenshots, `Chillax-Variable.woff2` and `words.js` (`window.WORDS=` plus `words.json`) in `assets/`.

## Creative rules (from Raphaël, keep them)

- Frame every beat around what a user is trying to do: "you had an idea Monday, by Thursday it's scattered" before "ideas now derive status from linked work". Technical source material still gets user-goal language.
- Plain, straightforward wording in the script, captions and headlines.
- No eyebrows, kickers or decorative extras. No branding at the top of the frame; the URL and mark appear only on the close card.
- Motion has life: springs and nonlinear curves, never linear tweens. Everything floats slightly; nothing is ever perfectly still.
- Music is ethereal, swirling, sci-fi, a little eerie. Soft swooshes on scene changes.
- Show the real product: committed screenshots from `apps/www/public/images/docs/` (regenerate with the `apps/web/tests/playwright/docs-screenshots-*.spec.ts` specs if stale). Where no screenshot exists, use a typographic card that states what the screen does, never a fake UI.

## Why the October 27 voiceover sounded mechanical

That cut generated three separate sentences with `eleven_multilingual_v2` and pinned them to fixed timestamps the visuals had already chosen. Each sentence started from neutral prosody, the gaps were set by the animation rather than by breathing, and the script was written to be read rather than said. Its pitch range measured 11.5 semitones; the takes below measure 17–18. Fix all three:

1. **Write for the ear.** Talk to one person ("you"). Use contractions, fragments and questions ("So... where does it actually stand?"). Vary sentence length. Put the problem before the feature. Let the screen carry the details, so the voice doesn't list them. Spell names the way they're said ("Sam", not "SAM"). About 170 words per minute: 90 seconds is about 255 words.
2. **One continuous take.** Generate the whole script in one request so the prosody stays connected. Separate paragraphs with blank lines. Use ellipses for beats. Use sparse audio tags only where a human would change delivery (`[warmly]`, `[sighs]`, `[chuckles]`, `[upbeat]`). Fewer than one tag per paragraph.
3. **The picture follows the voice.** Ask for character timestamps (`/with-timestamps`) and key every visual cue to the word it belongs to. Never stretch or pin the voice to the animation.

## Workflow

### 1. Facts first

List what shipped (`git log origin/main --since=<date>`), then have an Explore sub-agent produce a user-centric fact sheet: for each item, the problem it removes, what the user sees (with doc citations), caveats the voiceover must not contradict (preview, opt-in, admin-only, limits), and the best screenshot. Drop anything that is preview/admin-only unless you can say so honestly. Pick 3 main stories plus a quick "a few more" beat.

### 2. Script

Write `script.md` with `[beat]` markers (stripped before TTS). Structure: hook (the shared pain) → one problem→solution story per feature → quick hits → short close. Keep the caveats true. Extract `beats.json` and `vo_text.txt`.

### 3. Voice: audition, then measure

ElevenLabs is reached through Composio. In `COMPOSIO_REMOTE_WORKBENCH`, `proxy_execute('POST', 'https://api.elevenlabs.io/v1/text-to-speech/<voice>/with-timestamps', 'ELEVENLABS', body=...)` returns `audio_base64` plus `alignment`. Use `model_id: eleven_v4` (most emotive; `eleven_v3` scored lower here), `stability` 0.35–0.5, `similarity_boost` 0.75, a fixed `seed` per take.

- Audition 4–6 conversational premade voices on one line first (good candidates: Roger, Chris, Eric, Will). Then generate 3 full takes of the top 2–3, with and without light tags.
- Move files out of the workbench with `upload_local_file(path)` and `curl -L` its `s3_url`.
- **We can't listen, so measure.** `tools/prosody_report.py` reports pitch spread, loudness movement, pace and pauses (needs `praat-parselmouth`; use a venv). Then ask `@cf/cloudflare/clef-omni` through SAM `run_ai_model`, which takes audio: score naturalness 0–4, and ask yes/no for conversational delivery, artifacts, spoken stage directions and overacting. Downsample to mono 16 kHz first. Calibrate against a known-bad take: the October 27 narration scored 1.3, the chosen October 28 take 2.8.
- Pick the best take, then `tools/words.py take.json > words.json` (strips `[tags]`).

### 4. Music and sound effects

`proxy_execute` drops binary bodies (it returns `{}`). For `/v1/music` and `/v1/sound-generation`, POST to the workbench's internal proxy directly (`$BACKEND_URL/api/v3/tool_router/internal/proxy_execute` with `{toolkit_slug, endpoint, method, body}`) and download `binary_data.url`. Music: `music_v1`, `force_instrumental: true`, length = film length + 2 s, prompt for sparse mid-range so the voice sits on top. SFX: two swoosh variants, one soft glass tick, one shimmer riser. Check the music with clef-omni against the brief (genre, vocals, busy, cheesy).

### 5. Scene

`templates/scene.html` is a deterministic 1920x1080 scene: `window.setTime(seconds)` draws one frame. It contains the reusable engine (`at(word, n)` cue lookup, `spring()`, `presence()`, a screenshot camera with spring-eased pan/zoom keyframes and highlight boxes in image coordinates, word-highlighted captions, a swirling background), followed by the October 28 weekly scenes as a worked example. Replace the scene sections; keep the engine.

- Cue from words, not seconds: `at('Monday.')`. `at()` normalizes punctuation, so check repeated words (`Now`, `you`, `that's`) and pass the occurrence number.
- Keep highlights to the thing the voice is naming, and zoom so UI text reads on a phone (camera scale ≥ 1.0 on dense screens).
- What the October 28 review caught, so check for it before review:
  - Show the subject in frame 0. A title card over an empty stage loses social viewers.
  - Bring something in on the first spoken word of every beat. No headline over an empty stage.
  - Use the headline sequencer (`HEADS`) so the old headline is gone before the new one arrives. Never cross-dissolve two headlines.
  - Every action the voice names needs a visible result: a press, then a new chat, or a row flipping to its new state.
  - A highlight must show exactly the claim. If the screenshot can't show it (for example a wait step), add a labeled chip that states it, or cut the claim.
  - Crop to whole components. A clipped button or half a word reads as sloppy. The view vignette softens edges, but it doesn't fix a bad crop.
  - Give each "a few more" item the full stage for its own beat. Shrinking several to thirds makes them unreadable.
  - End the film within about 1.5 s of the last word. Generated music often decays before its nominal length, so delay it (`music_delay`) until it is still audible at the cut, and check with `silencedetect`.
  - Don't caption-duplicate: if the caption already says it, the headline should say something shorter or different.
  - Replace documentation placeholders (`api.example.com`) with real values, and keep any overlay on a real screenshot to a real product state.
- Render stills first: `node tools/render.cjs scene.html --stills 3,12.5,...`, tile them with ffmpeg `xstack`, and look at every sheet. Then dump cues with `node tools/cues.cjs scene.html > cues.json` and render the full video: `node tools/render.cjs scene.html --video silent.mp4 --duration <s>` (about 10 minutes for 90 s at 30 fps).

### 6. Mix

`tools/mix.py <dir>` reads `mix.json` (voice, music, `music_delay`, `music_fade_out`, events keyed to cue names; see `templates/mix.example.json`) and does the mix: voice high-pass, compression and presence, music sidechain-ducked under the voice, swooshes about 0.55 s before each cut, quiet ticks on highlights, two-pass loudness to -14 LUFS / -1.5 dBTP, then muxes `final.mp4`. Check balance with clef-omni (music level, voice clarity, SFX level, pumping).

### 7. Review, revise, deliver

- Give the encoded MP4 to a local sub-agent (Agent tool, not a SAM task). It should extract frames at every cue with ffmpeg, judge them at desktop and phone size, check every claim against the fact sheet, and return prioritized fixes. Implement them and re-render.
- Upload `final.mp4`, a poster frame, `script.md`, a short post draft, and a zipped source folder to `/marketing/videos/<date>-<name>/` in the Library. Download it again and compare SHA-256 before reporting.
- Report what changed and the measured evidence, and say plainly which judgments are machine proxies for listening.

### 8. Posting to X (only after explicit approval)

The Composio workbench can't read workspace files, and X needs an `s3key`. Copy only the MP4 into an empty temp dir, serve that dir with `python3 -m http.server`, `expose_port` it, download the file inside `COMPOSIO_REMOTE_WORKBENCH` with the `port_token` URL, and write it to `/home/user/` (the `/mnt/files` mount fails on large writes). Check its SHA-256, then `upload_local_file()` it for an `s3key`. Stop the server and delete the temp dir straight away. Then call `TWITTER_UPLOAD_LARGE_MEDIA` (`media_category: tweet_video`; videos up to 140 s and 512 MB), wait for `processing_info.state == succeeded`, and post with `TWITTER_CREATION_OF_A_POST` and `media_media_ids`. Reply with the post URL.

## Prerequisites

- Composio ElevenLabs connection (check with `COMPOSIO_SEARCH_TOOLS`).
- `ffmpeg`, `sox` (`sudo apt-get install -y ffmpeg sox`); Playwright Chromium in `/tmp/render` (`npm i playwright && npx playwright install --with-deps chromium`), passed to the tools via `PLAYWRIGHT_DIR`.
- SAM AI models enabled for the project (clef-omni is in the recommended set).
