/**
 * Qumak Instagram Cover Generator — GPT-Image-2 (Edit Mode)
 *
 * Strategy:
 * - Uses Higgsfield covers as STYLE REFERENCE images
 * - Uses actual Qumak logo as BRAND REFERENCE
 * - Sends both as input images to gpt-image-alpha edit endpoint
 * - Generates 10 Qumak-branded reel covers in Higgsfield visual style
 *
 * SETUP:
 *   npm init -y && npm install openai
 *   export OPENAI_API_KEY=sk-...
 *
 * FILE STRUCTURE EXPECTED:
 *   ./references/higgsfield/    ← put your downloaded Higgsfield covers here
 *   ./references/logo/          ← put Qumak logo files here
 *       logo_dark.png           ← white/black Q logo (on white bg)
 *       logo_orange.png         ← white Q logo on orange bg
 *       logo_watermark.png      ← transparent/dark bg version
 *
 * RUN:
 *   node qumak_cover_generator.js
 */


 
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import https from "https";
import sharp from "sharp";
 
const openai = new OpenAI({ apiKey:"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" });

const DIRS = {
  higgsfieldRefs: "./topCoversImages",
  logoRefs: "./logos",
  fonts: "../fonts",
  output: "./qumak_covers",
};
 
if (!fs.existsSync(DIRS.output)) fs.mkdirSync(DIRS.output, { recursive: true });
 
const W = 1080;
const H = 1920;
 
// ─── Helpers ──────────────────────────────────────────────────────────────────
 
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
 
function saveBase64(b64, filepath) {
  fs.writeFileSync(filepath, Buffer.from(b64, "base64"));
  return filepath;
}
 
async function downloadImage(url, filepath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filepath);
    https.get(url, (res) => {
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(filepath); });
    }).on("error", reject);
  });
}
 
function listRefs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /\.(png|jpe?g|webp)$/i.test(f))
    .map(f => path.join(dir, f));
}
 
function pickOne(files) {
  if (!files.length) return null;
  return files[Math.floor(Math.random() * files.length)];
}
 
// Escape text for SVG
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
 
// ─── Text + logo compositing (crisp, never distorted) ─────────────────────────
// Builds an SVG overlay with the headline/subtext, then composites the real logo PNG.
 
async function compositeOverlay(baseImageBuf, job, logoFile) {
  // Position text in the TOP zone over the clean negative space we asked for.
  const headline = esc(job.headline);
  const sub = esc(job.subtext || "");
  const tag = esc(job.tag || "");
 
  // Word-wrap headline manually (SVG has no auto-wrap)
  const words = headline.split(" ");
  const lines = [];
  let line = "";
  const maxChars = 18; // tuned for ~84px bold on 1080 width
  for (const w of words) {
    if ((line + " " + w).trim().length > maxChars) {
      lines.push(line.trim());
      line = w;
    } else {
      line = (line + " " + w).trim();
    }
  }
  if (line) lines.push(line.trim());
 
  const headlineStartY = 230;
  const lineHeight = 96;
  const headlineSvg = lines.map((l, i) =>
    `<text x="80" y="${headlineStartY + i * lineHeight}" font-family="Orbitron, Arial Black, sans-serif"
       font-size="84" font-weight="800" fill="#FFFFFF" letter-spacing="-1">${l}</text>`
  ).join("\n");
 
  const subY = headlineStartY + lines.length * lineHeight + 30;
  const subSvg = sub
    ? `<text x="82" y="${subY}" font-family="Poppins, Arial, sans-serif" font-size="38"
         font-weight="500" fill="#E8E8E8">${sub}</text>` : "";
 
  const tagSvg = tag
    ? `<g>
         <rect x="78" y="130" rx="22" ry="22" width="${30 + tag.length * 20}" height="46" fill="#FF5A1F"/>
         <text x="${78 + 22}" y="161" font-family="Poppins, Arial, sans-serif" font-size="26"
           font-weight="600" fill="#0D0F14">${tag}</text>
       </g>` : "";
 
  const svg = `
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <!-- subtle top gradient scrim so text always reads on any photo -->
      <defs>
        <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#000000" stop-opacity="0.75"/>
          <stop offset="45%" stop-color="#000000" stop-opacity="0.15"/>
          <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="${W}" height="760" fill="url(#scrim)"/>
      ${tagSvg}
      ${headlineSvg}
      ${subSvg}
    </svg>`;
 
  const layers = [{ input: Buffer.from(svg), top: 0, left: 0 }];
 
  // Composite the real logo bottom-left, fixed size, never distorted
  if (logoFile && fs.existsSync(logoFile)) {
    const logoW = 150;
    const logoBuf = await sharp(logoFile)
      .resize({ width: logoW, withoutEnlargement: false })
      .png()
      .toBuffer();
    const logoMeta = await sharp(logoBuf).metadata();
    layers.push({
      input: logoBuf,
      top: H - (logoMeta.height || logoW) - 70,
      left: 80,
    });
  }
 
  return sharp(baseImageBuf).composite(layers).png().toBuffer();
}
 
// ─── Core generator (TRUE image-to-image) ─────────────────────────────────────
 
async function generateCover(job, logoFile, styleRef) {
  console.log(`\n⚡ [${job.id}/${COVERS.length}] ${job.name}`);
  if (styleRef) console.log(`   style anchor: ${path.basename(styleRef)}`);
 
  try {
    let baseBuf;
 
    if (styleRef && fs.existsSync(styleRef)) {
      // TRUE image-to-image: pass the Higgsfield cover as the edit base.
      const res = await openai.images.edit({
        model: "gpt-image-1",            // edit endpoint model
        image: fs.createReadStream(styleRef),
        prompt: job.prompt,
        size: "1024x1536",               // closest portrait to 9:16
        quality: "high",
      });
      const item = res.data[0];
      baseBuf = item.b64_json
        ? Buffer.from(item.b64_json, "base64")
        : await fetchToBuffer(item.url);
    } else {
      // Fallback: text-to-image if no reference available
      const res = await openai.images.generate({
        model: "gpt-image-1",
        prompt: job.prompt,
        size: "1024x1536",
        quality: "high",
      });
      const item = res.data[0];
      baseBuf = item.b64_json
        ? Buffer.from(item.b64_json, "base64")
        : await fetchToBuffer(item.url);
    }
 
    // Normalize to exact 1080x1920 canvas
    baseBuf = await sharp(baseBuf).resize(W, H, { fit: "cover" }).png().toBuffer();
 
    // Composite crisp text + real logo on top
    const finalBuf = await compositeOverlay(baseBuf, job, logoFile);
 
    const filepath = path.join(DIRS.output, job.file);
    fs.writeFileSync(filepath, finalBuf);
    console.log(`   ✅ Saved → ${filepath}`);
    return { success: true, filepath, styleRef: styleRef ? path.basename(styleRef) : null };
 
  } catch (err) {
    console.error(`   ❌ Error: ${err.message}`);
    return { success: false, error: err.message };
  }
}
 
async function fetchToBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}
// ─── Cover definitions ────────────────────────────────────────────────────────


const PROMPT_BASE = `
Transform this into a clean cinematic vertical photograph for a premium tech brand reel cover.
Photographic realism, shot on 35mm, shallow depth of field, soft natural lighting, refined
muted color grade with a single warm orange accent in the scene. Keep the TOP THIRD of the
frame visually clean and simple (negative space) so a text headline can sit there. Do NOT add
any text, letters, words, logos, watermarks, UI panels, dashboards, charts, or graphics.
Single clear subject, real environment, editorial quality. Composition is vertical 9:16.
SUBJECT AND SCENE:
`;
const COVERS = [
  {
    id: 1,
    name: "Founder at Desk",
    file: "instagram_0015.jpg",
    headline: "Introducing Qumak",
    subtext: "Gulf marketing intelligence, decoded.",
    prompt: PROMPT_BASE + `
      A young Gulf entrepreneur (late 20s, smart-casual) sitting calmly at a minimalist
      desk near a large window with warm Dubai evening light. A single laptop, slightly
      out of focus. Confident, composed expression. Clean uncluttered background, warm
      orange rim light from the window. Lower half holds the subject; top third is soft
      empty wall space.
    `,
  },
  {
    id: 2,
    name: "Competitor Intel",
    file: "instagram_0016.jpg",
    tag: "Competitor Intelligence",
    headline: "Your competitors' best ads, exposed",
    prompt: PROMPT_BASE + `
      A close-up of a single smartphone held in one hand, screen glowing softly (screen
      content blurred/abstract, no readable text), shot in a dim modern office with a
      warm orange desk lamp bokeh in the background. Cinematic, moody, shallow focus.
      Top third dark and clean for text.
    `,
  },
  {
    id: 3,
    name: "Gulf Skyline",
    file: "instagram_0202.jpg",
    headline: "The Gulf's missing marketing layer",
    subtext: "Arabic-first. Built for MENA.",
    prompt: PROMPT_BASE + `
      A clean cinematic wide shot of the Dubai skyline at golden hour from a high vantage,
      warm orange haze, soft gradient sky. Minimal, calm, premium. Lots of clean sky in
      the top third for a headline. No text, no overlays.
    `,
  },
  {
    id: 4,
    name: "URL to Ads",
    file: "instagram_0023.jpg",
    tag: "URL-to-Ads",
    headline: "URL in. Ad creative out.",
    prompt: PROMPT_BASE + `
      A single sleek laptop on a clean concrete desk, half-open, glowing softly, in a
      bright minimalist studio with one warm orange accent light. Product-photography
      feel, shallow depth of field. Clean empty space above the laptop for a headline.
    `,
  },
  {
    id: 5,
    name: "Agency Owner",
    file: "instagram_0037.jpg",
    headline: "10 clients. One dashboard.",
    subtext: "AED 999/mo · unlimited brands.",
    prompt: PROMPT_BASE + `
      A confident Gulf marketing-agency owner (30s) standing with arms loosely crossed in
      a bright modern studio office, soft daylight, slight orange accent in wardrobe or
      background. Relaxed authority. Clean wall behind, upper third open for text.
    `,
  },
  {
    id: 6,
    name: "Brand Roast",
    file: "instagram_0044.jpg",
    headline: "We roasted 50 Gulf brand ads",
    subtext: "Here's what they got wrong.",
    prompt: PROMPT_BASE + `
      A single matchstick with a small warm flame against a clean dark neutral background,
      macro shot, cinematic, one bright orange glow as the only light source. Minimal and
      striking. Plenty of clean dark space in the top third for a headline.
    `,
  },
  {
    id: 7,
    name: "Arabic First",
    file: "instagram_0216.jpg",
    tag: "Language Intelligence",
    headline: "Arabic-first ads win in the Gulf",
    prompt: PROMPT_BASE + `
      A clean flat-lay style photo from above of a single open notebook and a pen on a warm
      neutral desk, soft daylight, one small orange object (a sticky note) as accent. Calm,
      editorial, minimal. Top third clean.
    `,
  },
  {
    id: 8,
    name: "Autonomous",
    file: "instagram_0243.jpg",
    headline: "Your marketing runs itself",
    subtext: "Autonomous Gulf ad intelligence.",
    prompt: PROMPT_BASE + `
      A single sleek robotic/automated arm or a clean modern desk robot figurine on a
      minimalist surface, soft studio lighting, one warm orange accent light, shallow
      depth of field. Futuristic but calm and premium. Clean negative space up top.
    `,
  },
  {
    id: 9,
    name: "The Numbers",
    file: "instagram_0172.jpg",
    headline: "The numbers don't lie",
    prompt: PROMPT_BASE + `
      A single clean cup of coffee on a minimalist desk beside a closed laptop in warm
      morning light, shot cinematically with shallow focus and a subtle orange glow.
      Calm, premium, lots of clean space above for text.
    `,
  },
  {
    id: 10,
    name: "Cinematic Launch",
    file: "instagram_0271.jpg",
    headline: "Qumak",
    subtext: "Gulf marketing intelligence.",
    prompt: PROMPT_BASE + `
      A clean minimalist abstract scene: a single smooth dark sphere resting on a reflective
      surface with one warm orange light streak crossing behind it, deep soft shadows,
      product-photography lighting. Calm, premium, Apple-keynote minimalism. Center the
      sphere low; keep the upper area clean and simple.
    `,
  },
];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🚀 Qumak Cover Generator — GPT-Image-2");
  console.log("========================================\n");

  // Check logo files exist
  const logoFiles = {
    dark: path.join(DIRS.logoRefs, "./logo_dark.png"),
    orange: path.join(DIRS.logoRefs, "./logo_orange.png"),
    watermark: path.join(DIRS.logoRefs, "./logo_watermark.png"),
  };
  const logoCandidates = [
    path.join(DIRS.logoRefs, "./logo_white.png"),
    path.join(DIRS.logoRefs, "./logo_dark.png"),
    path.join(DIRS.logoRefs, "./logo_watermark.png"),
  ];

  const logoFile = logoCandidates.find(f => fs.existsSync(f)) || null;
  console.log(logoFile ? `✅ Logo: ${logoFile}` : "⚠️  No logo PNG found — will skip logo overlay");
 
  const refs = listRefs(DIRS.higgsfieldRefs);
  console.log(`✅ Higgsfield style anchors: ${refs.length}`);
  if (!refs.length) {
    console.warn("⚠️  No Higgsfield refs — falling back to text-to-image (weaker style match).");
  }
  const results = [];

  for (const cover of COVERS) {
    const styleRef = pickOne(refs);
    const r = await generateCover(cover, logoFile, styleRef);
    results.push({ id: cover.id, name: cover.name, file: cover.file, ...r });
    if (cover.id < COVERS.length) { console.log("   ⏳ 3s..."); await sleep(3000); }
  }

  // Summary
  const ok = results.filter(r => r.success);
  const fail = results.filter(r => !r.success);

  console.log("\n\n📊 RESULTS");
  console.log("===========");
  console.log(`✅ Generated: ${ok.length}/${COVERS.length}`);
  if (fail.length > 0) {
    console.log(`❌ Failed: ${fail.map(f => f.name).join(", ")}`);
  }

  // Save manifest
  const manifest = {
    generated_at: new Date().toISOString(),
    total: results.length,
    succeeded: ok.length,
    covers: results,
  };
  fs.writeFileSync(
    path.join(DIRS.output, "_manifest.json"),
    JSON.stringify(manifest, null, 2)
  );

  console.log(`\n📁 Output: ${path.resolve(DIRS.output)}`);
  console.log("📋 Manifest: _manifest.json");
  console.log("\n💡 NEXT STEPS:");
  console.log("  1. Review all 10 covers in qumak_covers/");
  console.log("  2. Pick your top 5 based on Higgsfield-style match");
  console.log("  3. In Canva: overlay your real Qumak logo PNG on top (brand kit)");
  console.log("  4. Write caption using Higgsfield formula + comment bait");
  console.log("  5. Post 1/day for 10 days, track engagement per cover type");
  console.log("\n💰 Estimated cost: ~$0.40 total (10 × $0.04/image)");
}

main().catch(console.error);









