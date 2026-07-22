#!/usr/bin/env python3
"""
adIngest.py — competitor ad URL/file -> {audio, frames, scenes, transcript}

This is the stage Qumak does NOT have yet. ffmpeg is installed but nothing
drives it to pull a competitor ad apart. This worker does the whole ingest:

  1. download    competitor ad (yt-dlp for hosted URLs, or local/CDN file)
  2. probe       duration / dimensions
  3. audio       extract 16kHz mono wav (whisper-optimal)
  4. scenes      PySceneDetect content cuts -> beat boundaries
  5. frames      sample 1 representative frame per scene (for vision-LLM)
  6. transcribe  faster-whisper -> word-level timestamps

Output is a single JSON manifest the Node teardown step consumes to build the
ad-spec. Designed to run as a queue worker (BullMQ shells out to it) OR be
ported to a Node child_process — kept as a CLI so it's trivial to call either way.

Cost posture: yt-dlp + ffmpeg + scenedetect are free; faster-whisper is the
only "model" and runs MIT-licensed on CPU with the `base` model (~1GB, fine
for sub-60s ads). No GPU required at this stage.

Usage:
  python3 adIngest.py --source <url|path> --out <dir> [--model base] [--max-frames 8]
  python3 adIngest.py --source ad.mp4 --out ./work --no-download   # local file
"""

import argparse, json, os, subprocess, sys, tempfile, shutil
from pathlib import Path


def run(cmd, **kw):
    """Run a subprocess, raising with stderr captured (the lesson from the
    ffmpeg 'no output produced' bug: never swallow stderr)."""
    p = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if p.returncode != 0:
        raise RuntimeError(f"cmd failed: {' '.join(cmd)}\n{p.stderr.strip()}")
    return p.stdout


# ── 1. download ──────────────────────────────────────────────────────────────
def download(source, workdir, allow_download=True):
    """If source is a local path, copy it. If a URL, yt-dlp it.
    yt-dlp handles FB/IG/TikTok/YouTube hosted ad creatives. For FB Ads Library
    video_sd_url / video_hd_url (which you already scrape into apifyData), pass
    that direct CDN URL and it downloads as a plain file."""
    dst = os.path.join(workdir, "source.mp4")
    if os.path.exists(source):
        shutil.copy(source, dst)
        return dst
    if not allow_download:
        raise RuntimeError(f"source is not a local file and downloads disabled: {source}")
    # Use sys.executable -m yt_dlp so it works regardless of PATH (pip install
    # puts the script in a user bin dir that may not be on the system PATH when
    # called from a Node child_process).
    run([sys.executable, "-m", "yt_dlp", "-q", "--no-playlist", "-f", "mp4/best",
         "-o", dst, source])
    if not os.path.exists(dst):
        # direct CDN link fallback (yt-dlp sometimes renames)
        cand = list(Path(workdir).glob("source.*"))
        if cand:
            os.rename(str(cand[0]), dst)
    if not os.path.exists(dst):
        raise RuntimeError("download produced no file")
    return dst


# ── 2. probe ─────────────────────────────────────────────────────────────────
def probe(path):
    out = run(["ffprobe", "-v", "error", "-of", "json",
               "-show_entries", "format=duration:stream=codec_type,width,height",
               path])
    info = json.loads(out)
    dur = float(info.get("format", {}).get("duration") or 0)
    v = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), {})
    has_audio = any(s.get("codec_type") == "audio" for s in info.get("streams", []))
    return {
        "duration": dur,
        "width": v.get("width"),
        "height": v.get("height"),
        "hasAudio": has_audio,
    }


# ── 3. audio (16kHz mono wav = whisper-optimal) ──────────────────────────────
def extract_audio(path, workdir, has_audio):
    if not has_audio:
        return None
    wav = os.path.join(workdir, "audio.wav")
    run(["ffmpeg", "-y", "-i", path, "-vn",
         "-ac", "1", "-ar", "16000", "-f", "wav", wav, "-loglevel", "error"])
    return wav


# ── 4. scene boundaries (PySceneDetect) ──────────────────────────────────────
def detect_scenes(path, duration):
    """Returns [{index,start,end,mid}] — the beat skeleton for the ad-spec."""
    from scenedetect import detect, ContentDetector
    try:
        scene_list = detect(path, ContentDetector(threshold=27.0))
    except Exception as e:
        scene_list = []
        print(f"[adIngest] scenedetect soft-fail: {e}", file=sys.stderr)

    scenes = []
    if scene_list:
        for i, (start, end) in enumerate(scene_list):
            # scenedetect 0.6+ uses get_seconds(); older versions had .seconds
            s = start.get_seconds() if hasattr(start, 'get_seconds') else start.seconds
            e = end.get_seconds() if hasattr(end, 'get_seconds') else end.seconds
            scenes.append({"index": i, "start": round(s, 2), "end": round(e, 2),
                           "mid": round((s + e) / 2, 2)})
    else:
        # fallback: even thirds so downstream always has beats
        n = 3
        seg = (duration or 9) / n
        for i in range(n):
            s = i * seg
            e = (i + 1) * seg
            scenes.append({"index": i, "start": round(s, 2), "end": round(e, 2),
                           "mid": round((s + e) / 2, 2)})
    return scenes


# ── 5. one representative frame per scene (for vision-LLM) ───────────────────
def sample_frames(path, scenes, workdir, max_frames=8):
    frames_dir = os.path.join(workdir, "frames")
    os.makedirs(frames_dir, exist_ok=True)
    picked = scenes[:max_frames]
    out = []
    for sc in picked:
        fp = os.path.join(frames_dir, f"scene_{sc['index']:02d}.jpg")
        # -ss before -i = fast seek; grab the scene midpoint
        run(["ffmpeg", "-y", "-ss", str(sc["mid"]), "-i", path,
             "-frames:v", "1", "-q:v", "3", fp, "-loglevel", "error"])
        out.append({"sceneIndex": sc["index"], "t": sc["mid"], "path": fp})
    return out


# ── 6. transcribe (faster-whisper, word timestamps) ──────────────────────────
def transcribe(wav, model_name="base"):
    if not wav:
        return {"text": "", "words": [], "segments": [], "language": None}

    whisper_api = os.environ.get("WHISPER_API_URL", "").strip()
    if whisper_api:
        # Use the faster-whisper HTTP server (docker-compose whisper service).
        # Compatible with the OpenAI /v1/audio/transcriptions endpoint.
        import urllib.request
        boundary = "----QumakBoundary"
        with open(wav, "rb") as f:
            audio_data = f.read()
        body = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="model"\r\n\r\nbase\r\n'
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n'
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="timestamp_granularities[]"\r\n\r\nword\r\n'
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n'
            f"Content-Type: audio/wav\r\n\r\n"
        ).encode() + audio_data + f"\r\n--{boundary}--\r\n".encode()
        req = urllib.request.Request(
            f"{whisper_api}/v1/audio/transcriptions",
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                result = json.loads(resp.read())
            words = [{"word": w["word"].strip(), "start": round(w["start"], 2), "end": round(w["end"], 2)}
                     for w in result.get("words", [])]
            segs = [{"start": round(s["start"], 2), "end": round(s["end"], 2), "text": s["text"].strip()}
                    for s in result.get("segments", [])]
            return {
                "text": result.get("text", "").strip(),
                "words": words, "segments": segs,
                "language": result.get("language"), "model": model_name,
            }
        except Exception as e:
            print(f"[adIngest] whisper API call failed, falling back to in-process: {e}", file=sys.stderr)

    # In-process faster-whisper (dev / no WHISPER_API_URL)
    from faster_whisper import WhisperModel
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, info = model.transcribe(wav, word_timestamps=True)
    words, segs, text_parts = [], [], []
    for seg in segments:
        segs.append({"start": round(seg.start, 2), "end": round(seg.end, 2),
                     "text": seg.text.strip()})
        text_parts.append(seg.text.strip())
        for w in (seg.words or []):
            words.append({"word": w.word.strip(),
                          "start": round(w.start, 2), "end": round(w.end, 2)})
    return {
        "text": " ".join(text_parts).strip(),
        "words": words,
        "segments": segs,
        "language": info.language,
        "model": model_name,
    }


# ── 7. per-beat audio slices (one WAV per scene, for beat-level voiceover) ────
def slice_audio_beats(wav, scenes, workdir):
    """Cut the full audio track into one file per scene/beat.
    These are uploaded to private R2 by the Node caller so users can hear
    the competitor's audio-per-beat alongside their own voiceover recording."""
    if not wav or not scenes:
        return []
    audio_dir = os.path.join(workdir, "audio_beats")
    os.makedirs(audio_dir, exist_ok=True)
    segments = []
    for sc in scenes:
        out_path = os.path.join(audio_dir, f"beat_{sc['index']:02d}.wav")
        duration = round(sc["end"] - sc["start"], 3)
        if duration <= 0:
            continue
        try:
            run(["ffmpeg", "-y", "-i", wav,
                 "-ss", str(sc["start"]), "-t", str(duration),
                 "-ac", "1", "-ar", "16000", out_path, "-loglevel", "error"])
            segments.append({
                "beatIndex": sc["index"],
                "start": sc["start"],
                "end": sc["end"],
                "path": out_path,
            })
        except Exception as e:
            print(f"[adIngest] beat audio slice {sc['index']} failed: {e}", file=sys.stderr)
    return segments


# ── orchestrate ──────────────────────────────────────────────────────────────
def ingest(source, out_dir, model="base", max_frames=8, allow_download=True):
    os.makedirs(out_dir, exist_ok=True)
    src = download(source, out_dir, allow_download)
    meta = probe(src)
    wav = extract_audio(src, out_dir, meta["hasAudio"])
    scenes = detect_scenes(src, meta["duration"])
    frames = sample_frames(src, scenes, out_dir, max_frames)
    tr = transcribe(wav, model)
    audio_beats = slice_audio_beats(wav, scenes, out_dir)

    manifest = {
        "source": source,
        "localPath": src,          # Node uploads this to private R2, then deletes
        "meta": meta,
        "audioPath": wav,          # full audio; also uploaded to private R2
        "audioBeats": audio_beats, # per-beat slices for beat-level voiceover control
        "scenes": scenes,
        "frames": frames,          # paths; Node uploads to R2 + sends to vision-LLM
        "transcript": tr,
        "ok": True,
    }
    mpath = os.path.join(out_dir, "manifest.json")
    with open(mpath, "w") as f:
        json.dump(manifest, f, indent=2)
    return manifest, mpath


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="base")
    ap.add_argument("--max-frames", type=int, default=8)
    ap.add_argument("--no-download", action="store_true")
    args = ap.parse_args()
    try:
        manifest, mpath = ingest(args.source, args.out, args.model,
                                 args.max_frames, not args.no_download)
        # machine-readable line for the Node caller to parse
        print(json.dumps({"ok": True, "manifest": mpath,
                          "duration": manifest["meta"]["duration"],
                          "scenes": len(manifest["scenes"]),
                          "words": len(manifest["transcript"]["words"]),
                          "frames": len(manifest["frames"])}))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()