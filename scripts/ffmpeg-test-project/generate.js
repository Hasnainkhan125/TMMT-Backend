// generate.js — OpenAI: ad copy -> TTS voiceover -> Whisper word timestamps -> words.json
// Run on YOUR machine (needs OPENAI_API_KEY). Produces voice.mp3 + words.json,
// which render.js then consumes. This sandbox can't reach OpenAI, so this is
// untested here by design — but the shapes match what render.js expects.

const fs = require("fs");
const OpenAI = require("openai");
// ✅ Using environment variable
const client = new OpenAI({ 
  apiKey: process.env.OPENAI_API_KEY 
});

const DIR = __dirname;
const p = (f) => `${DIR}/${f}`;

// ---- 1. Ad copy: model writes script + marks emphasis words ----
async function writeCopy(brand) {
  const sys = `You are a short-form video ad copywriter. Write a punchy voiceover
script of 3-4 short lines (max ~25 words total) for the brand below. Then return
STRICT JSON only, no markdown, no preamble:
{"script":"<the full VO text as one string>","emphasis":["word1","word2",...]}
"emphasis" lists 3-5 key words from the script that deserve a sound-effect accent
(brand name, benefit verbs, the CTA). Words must appear verbatim in "script".`;

  const res = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: sys },
      { role: "user", content: `Brand info:\n${JSON.stringify(brand, null, 2)}` },
    ],
    temperature: 0.8,
  });
  const raw = res.choices[0].message.content.replace(/```json|```/g, "").trim();
  return JSON.parse(raw); // { script, emphasis:[] }
}

// ---- 2. TTS: script -> voice.mp3 ----
async function synthVoice(script) {
  const speech = await client.audio.speech.create({
    model: "gpt-4o-mini-tts",   // or "tts-1"
    voice: "alloy",
    input: script,
    response_format: "mp3",
  });
  const buf = Buffer.from(await speech.arrayBuffer());
  fs.writeFileSync(p("./voice.mp3"), buf);
}

// ---- 3. Whisper: voice.mp3 -> word-level timestamps ----
async function transcribeWords(emphasisWords) {
  const tr = await client.audio.transcriptions.create({
    file: fs.createReadStream(p("./voice.mp3")),
    model: "whisper-1",
    response_format: "verbose_json",
    timestamp_granularities: ["word"],
  });

  // Whisper gives [{word, start, end}]. Tag emphasis by matching (case/punct-insensitive).
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const emphSet = new Set(emphasisWords.map(norm));

  const words = tr.words.map((w) => ({
    word: w.word,
    start: w.start,
    end: w.end,
    emphasis: emphSet.has(norm(w.word)),
  }));

  fs.writeFileSync(p("./words.json"), JSON.stringify({ words }, null, 2));
  return words.length;
}

async function main() {
  // EDIT THIS with the real brand info, or read it from argv / a file.
  const brand = {
    name: "GlamSecret",
    product: "hydrating skincare serum",
    audience: "women 25-40 in the Gulf",
    tone: "confident, premium, warm",
    cta: "Try GlamSecret today",
  };

  console.log("1/3 writing copy...");
  const { script, emphasis } = await writeCopy(brand);
  console.log("   script:", script);
  console.log("   emphasis:", emphasis);

  console.log("2/3 synthesizing voiceover...");
  await synthVoice(script);

  console.log("3/3 transcribing word timestamps...");
  const n = await transcribeWords(emphasis);
  console.log(`Done. voice.mp3 + words.json (${n} words). Now run: node render.js`);
}

main().catch((e) => { console.error("generate.js FAILED:", e.message || e); process.exit(1); });