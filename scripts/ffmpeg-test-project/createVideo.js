const fs = require("fs");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileP = promisify(execFile);

const DIR = __dirname;
const p = (f) => `${DIR}/${f}`;

// ---------- drawtext escaping ----------
function esc(text) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%")
    .replace(/,/g, "\\,");
}

async function ffprobeJson(file) {
  const { stdout } = await execFileP("ffprobe", [
    "-v","error","-show_entries","format=duration:stream=codec_type,width,height",
    "-of","json", file,
  ]);
  return JSON.parse(stdout);
}
const hasStream = (info, t) => info.streams.some((s) => s.codec_type === t);

// ---------- group flat word list into lines (break on sentence-ending punctuation) ----------
function groupIntoLines(words, maxWordsPerLine = 4) {
  const lines = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    const endsSentence = /[.!?]$/.test(w.word);
    if (endsSentence || cur.length >= maxWordsPerLine) {
      lines.push(cur);
      cur = [];
    }
  }
  if (cur.length) lines.push(cur);
  return lines.map((ws) => ({
    words: ws,
    start: ws[0].start,
    end: ws[ws.length - 1].end + 0.4, // linger after last word
  }));
}

// ---------- build per-word drawtext filters (karaoke build-up) ----------
// Each word appears at its own start time, stays until the line's end, laid out left-to-right.
// FFmpeg can't measure prior words' widths dynamically, so we approximate x with a per-word
// fixed advance based on character count. Good enough for short ad captions.
function buildWordDrawFilters(lines, fontPath) {
  const filters = [];
  const FS = 64;                  // fontsize px (tuned for 1080w)
  const CHAR_W = FS * 0.52;       // approx glyph advance
  const SPACE_W = FS * 0.30;
  const yExpr = "h-360";

  for (const line of lines) {
    // total line width to center it
    const totalW = line.words.reduce(
      (acc, w) => acc + w.word.length * CHAR_W + SPACE_W, 0
    ) - SPACE_W;
    let cursor = 0;
    for (const w of line.words) {
      const wWidth = w.word.length * CHAR_W;
      const xExpr = `(w-${totalW.toFixed(0)})/2+${cursor.toFixed(0)}`;
      const color = w.emphasis ? "yellow" : "white";
      filters.push(
        `drawtext=fontfile=${fontPath.replace(/:/g,"\\:")}:` +
        `text='${esc(w.word)}':` +
        `fontcolor=${color}:fontsize=${FS}:` +
        `borderw=6:bordercolor=black:` +
        `x=${xExpr}:y=${yExpr}:` +
        `enable='between(t,${w.start.toFixed(3)},${line.end.toFixed(3)})'`
      );
      cursor += wWidth + SPACE_W;
    }
  }
  return filters;
}

// ---------- build whoosh SFX inputs + filters for emphasis words ----------
function buildEmphasisAudio(words, whooshInputIndex) {
  // Returns { extraInputs:[file repeated], filterLabels:[], delays:[ms] }
  const emphasis = words.filter((w) => w.emphasis);
  const labels = [];
  const filters = [];
  emphasis.forEach((w, i) => {
    const delayMs = Math.round(w.start * 1000);
    const inIdx = whooshInputIndex + i; // each emphasis word gets its own whoosh input
    const label = `wh${i}`;
    filters.push(`[${inIdx}:a]adelay=${delayMs}:all=1[${label}]`);
    labels.push(`[${label}]`);
  });
  return { count: emphasis.length, filters, labels };
}


async function hasDrawText() {
    const { stdout } = await execFileP("ffmpeg", [
      "-hide_banner",
      "-filters",
    ]);
  
    return stdout.includes("drawtext");
  }
async function preflight() {
  // 1. required input files present?
  const required = ["input.mp4", "voice.mp3", "music.mp3", "whoosh.mp3", "font.ttf", "words.json"];
  const missing = required.filter((f) => !fs.existsSync(p(f)));
  if (missing.length) {
    throw new Error("Missing files in " + DIR + ":\n  " + missing.join("\n  "));
  }
  // 2. ffmpeg built with the features drawtext + x264 need?
  let conf = "";
  try { conf = (await execFileP("ffmpeg", ["-hide_banner", "-buildconf"])).stdout; } catch {}
  if (!/freetype/i.test(conf)) {
    throw new Error("Your ffmpeg has NO libfreetype -> drawtext will fail.\n" +
      "Fix (macOS):  brew uninstall ffmpeg && brew install ffmpeg  (Homebrew build includes it)");
  }
  if (!/libx264/i.test(conf)) {
    throw new Error("Your ffmpeg has NO libx264 -> -c:v libx264 will fail.\n" +
      "Fix (macOS):  brew install ffmpeg");
  }
  if (!(await hasDrawText())) {
    throw new Error(
      "drawtext filter not available. Install FFmpeg with libfreetype."
    );
  }
}

async function main() {
  await preflight();
  const words = JSON.parse(fs.readFileSync(p("words.json"), "utf8")).words;
  const lines = groupIntoLines(words);

  const inInfo = await ffprobeJson(p("input.mp4"));
  const inputHasAudio = hasStream(inInfo, "audio");

  const drawFilters = buildWordDrawFilters(lines, p("font.ttf"));

  // ---- assemble ffmpeg inputs ----
  // 0: input.mp4, 1: voice.mp3 (VO), 2: music.mp3 (looped), 3..: whoosh per emphasis word
  const inputs = [
    "-i", p("input.mp4"),
    "-i", p("voice.mp3"),
    "-stream_loop","-1","-i", p("music.mp3"),
  ];
  const whooshStart = 3;
  const emphasisCount = words.filter((w) => w.emphasis).length;
  for (let i = 0; i < emphasisCount; i++) inputs.push("-i", p("whoosh.mp3"));

  const emo = buildEmphasisAudio(words, whooshStart);

  // ---- audio graph ----
  // original video sound ducked (0.25), VO at 1.0, music at 0.12, whooshes at 0.7
  const audioParts = [];
  const mixInputs = [];
  if (inputHasAudio) {
    audioParts.push(`[0:a]volume=0.25[orig]`);
    mixInputs.push("[orig]");
  }
  audioParts.push(`[1:a]volume=1.0[vo]`);    mixInputs.push("[vo]");
  audioParts.push(`[2:a]volume=0.12[mus]`);  mixInputs.push("[mus]");
  emo.filters.forEach((f) => audioParts.push(f));
  emo.labels.forEach((l) => mixInputs.push(l));
  emo.labels.forEach((_, i) => {
    audioParts[audioParts.length - emo.labels.length + i]; // (whoosh volume applied below)
  });
  // apply volume to whooshes: rewrite labels through a volume stage
  // simpler: bump whoosh volume inside adelay chain
  const whooshVol = emo.labels.map((l, i) => {
    const src = l.replace(/[\[\]]/g, "");
    return `[${src}]volume=0.7[${src}v]`;
  });
  whooshVol.forEach((f) => audioParts.push(f));
  const mixInputsFinal = mixInputs.map((l) => {
    const name = l.replace(/[\[\]]/g, "");
    return emo.labels.some((el) => el === l) ? `[${name}v]` : l;
  });

  const nMix = mixInputsFinal.length;
  audioParts.push(
    `${mixInputsFinal.join("")}amix=inputs=${nMix}:normalize=0,alimiter=limit=0.95[a]`
  );

  const filterComplex = [
    `[0:v]${drawFilters.join(",")}[v]`,
    ...audioParts,
  ].join(";");

  fs.writeFileSync(p("filtergraph.txt"), filterComplex); // for debugging

  let ffmpegErr = null;
  try {
    await execFileP("ffmpeg", [
      ...inputs,
      "-filter_complex", filterComplex,
      "-map","[v]","-map","[a]",
      "-c:v","libx264","-preset","medium","-crf","20","-pix_fmt","yuv420p",
      "-c:a","aac","-b:a","192k",
      "-shortest",
      p("final.mp4"), "-y",
    ], { maxBuffer: 1024*1024*50 });
  } catch (e) {
    // stream_loop+shortest exits nonzero EVEN ON SUCCESS, so the code alone lies.
    // Keep stderr: if no valid output exists, this holds the real reason.
    ffmpegErr = e;
  }

  // ---- validate output instead of trusting exit code ----
  if (!fs.existsSync(p("final.mp4"))) {
    const detail = ffmpegErr ? (ffmpegErr.stderr || ffmpegErr.message) : "(no ffmpeg error captured)";
    throw new Error("ffmpeg produced no output. Real error:\n" + detail);
  }
  const out = await ffprobeJson(p("final.mp4"));
  if (!hasStream(out,"video")) throw new Error("no video stream in output");
  if (!hasStream(out,"audio")) throw new Error("no audio stream in output");
  await execFileP("ffmpeg", ["-v","error","-i",p("final.mp4"),"-f","null","-"]);
  console.log(`Finished -> final.mp4 (${Number(out.format.duration).toFixed(2)}s, ` +
    `${lines.length} lines, ${emphasisCount} emphasis whooshes, ` +
    `orig audio: ${inputHasAudio ? "yes" : "no"})`);
}

main().catch((e) => { console.error("FAILED:", e.stderr || e.message || e); process.exit(1); });