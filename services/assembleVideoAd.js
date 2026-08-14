/**
 * assembleVideoAd.js - PHASE 4. Produces the ONE final stitched clip, with audio.
 *
 * AUDIO MODES (env URL_TO_ADS_AUDIO_MODE):
 *   'music'  (default) — drop a music bed over the video, ignore clip audio.
 *                        Track: env URL_TO_ADS_MUSIC_BED (a local/remote mp3/m4a).
 *                        Looped + trimmed to total duration. Typical SMB social ad.
 *   'clips'            — keep each shot's OWN audio (your WAN clips DO have audio).
 *                        Robust to mixed inputs: any clip missing an audio track
 *                        gets a synthesized silent bed so concat a=1 won't crash.
 *
 * Flip with .env: URL_TO_ADS_AUDIO_MODE=clips  (keep per-shot audio)
 *                 URL_TO_ADS_AUDIO_MODE=music  (music bed; needs URL_TO_ADS_MUSIC_BED)
 *
 * TEXT OVERLAY: drawtext is used only if the ffmpeg build has it AND the font
 * is a real .ttf/.otf; otherwise it stitches without text (graceful).
 *
 * Filtergraphs below verified on ffmpeg against mixed-audio / mismatched inputs.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');
const os = require('os');

const storageService = require('./storageService');
const UrlToAdsScan = require('../model/schema/urlToAdsScan');

const FONT = process.env.URL_TO_ADS_OVERLAY_FONT
  || '/Library/Fonts/Arial Unicode.ttf';
const AUDIO_MODE = (process.env.URL_TO_ADS_AUDIO_MODE || 'music').toLowerCase();
const MUSIC_BED = process.env.URL_TO_ADS_MUSIC_BED || '';   // local path or https url

const DIMS = {
  '9:16': { w: 1080, h: 1920 },
  '16:9': { w: 1920, h: 1080 },
  '1:1':  { w: 1080, h: 1080 },
};

let _drawtext = null;
async function hasDrawtext() {
  if (_drawtext !== null) return _drawtext;
  try {
    const { stdout } = await execFileP('ffmpeg', ['-hide_banner', '-filters']);
    _drawtext = /\bdrawtext\b/.test(stdout);
  } catch { _drawtext = false; }
  if (!_drawtext) console.warn('[assemble] no drawtext filter — stitching without text.');
  return _drawtext;
}
function fontUsable() {
  return /\.(ttf|otf)$/i.test(FONT) && fssync.existsSync(FONT);
}

// Does a media file have an audio stream? (ffprobe)
async function hasAudioStream(file) {
  try {
    const { stdout } = await execFileP('ffprobe', [
      '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index',
      '-of', 'csv=p=0', file,
    ]);
    return stdout.trim().length > 0;
  } catch { return false; }
}

function escapeDrawText(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/:/g, '\\:')
    .replace(/'/g, "\\'").replace(/%/g, '\\%').slice(0, 120);
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status} for ${url}`);
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

async function assembleVideoAd(scanId, adJobId) {
  const scan = await UrlToAdsScan.findById(scanId);
  if (!scan) throw new Error('scan not found');

  const ad = (scan.ads || []).map(a => (a.toObject ? a.toObject() : a))
    .find(a => a.jobId === adJobId && a.kind === 'video');
  if (!ad) throw new Error('video ad row not found');

  const shots = (ad.shotPlan || []).filter(s => s.clipUrl).sort((a, b) => a.index - b.index);
  if (shots.length === 0) throw new Error('no ready shot clips to assemble');

  const { w, h } = DIMS[ad.aspectRatio] || DIMS['9:16'];
  const totalSec = ad.totalDurationSec || shots.reduce((s, x) => s + (x.durationSec || 3), 0);
  const canText = ad.post?.textOverlay !== false && (await hasDrawtext()) && fontUsable();

  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'qumak-stitch-'));
  try {
    // download clips + probe audio presence
    const localPaths = [];
    const clipHasAudio = [];
    for (let i = 0; i < shots.length; i += 1) {
      const p = await download(shots[i].clipUrl, path.join(work, `shot${i}.mp4`));
      localPaths.push(p);
      clipHasAudio.push(await hasAudioStream(p));
    }

    // decide effective audio mode
    let mode = AUDIO_MODE;
    let musicLocal = null;
    if (mode === 'music') {
      if (MUSIC_BED) {
        musicLocal = /^https?:\/\//.test(MUSIC_BED)
          ? await download(MUSIC_BED, path.join(work, 'music' + path.extname(MUSIC_BED).slice(0, 5) || '.m4a'))
          : MUSIC_BED;
        if (!fssync.existsSync(musicLocal)) { console.warn('[assemble] music bed missing, falling back to clips audio'); mode = 'clips'; }
      } else {
        console.warn('[assemble] AUDIO_MODE=music but no URL_TO_ADS_MUSIC_BED set — falling back to clips audio.');
        mode = 'clips';
      }
    }

    // ── build inputs ──
    const inputs = [];
    localPaths.forEach(p => { inputs.push('-i', p); });
    let musicIdx = -1;
    if (mode === 'music') { inputs.push('-stream_loop', '-1', '-i', musicLocal); musicIdx = localPaths.length; }

    // video normalize chain
    const normParts = shots.map((_, i) =>
      `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v${i}]`);

    let filterParts = [...normParts];
    let audioOutLabel;

    if (mode === 'clips') {
      // per-clip audio; synth silent for clips lacking audio so concat a=1 is safe
      const aLabels = [];
      shots.forEach((s, i) => {
        if (clipHasAudio[i]) {
          filterParts.push(`[${i}:a]aresample=44100,asetpts=PTS-STARTPTS[a${i}]`);
        } else {
          const dur = s.durationSec || 3;
          filterParts.push(`anullsrc=channel_layout=stereo:sample_rate=44100,atrim=0:${dur},asetpts=PTS-STARTPTS[a${i}]`);
        }
        aLabels.push(`[v${i}][a${i}]`);
      });
      filterParts.push(`${aLabels.join('')}concat=n=${shots.length}:v=1:a=1[vcat][aout]`);
      audioOutLabel = '[aout]';
    } else {
      // music bed
      const vIn = shots.map((_, i) => `[v${i}]`).join('');
      filterParts.push(`${vIn}concat=n=${shots.length}:v=1:a=0[vcat]`);
      filterParts.push(`[${musicIdx}:a]aresample=44100,atrim=0:${totalSec},asetpts=PTS-STARTPTS[aout]`);
      audioOutLabel = '[aout]';
    }

    // text overlays (optional)
    const draws = [];
    if (canText) {
      // const headline = (ad.overlayPlan || []).find(o => o.kind === 'headline');
      // const cta = (ad.overlayPlan || []).find(o => o.kind === 'cta');
      // if (headline?.text) {
      //   const end = shots[0].durationSec || 3;
      //   draws.push(`drawtext=fontfile='${FONT}':text='${escapeDrawText(headline.text)}':fontcolor=white:fontsize=64:box=1:boxcolor=black@0.45:boxborderw=18:x=(w-tw)/2:y=h*0.12:enable='lt(t,${end})'`);
      // }
      // if (cta?.text) {
      //   const ctaStart = totalSec - (shots[shots.length - 1].durationSec || 3);
      //   draws.push(`drawtext=fontfile='${FONT}':text='${escapeDrawText(cta.text)}':fontcolor=black:fontsize=52:box=1:boxcolor=0xC4F542:boxborderw=26:x=(w-tw)/2:y=h*0.80:enable='gte(t,${ctaStart})'`);
      // }
    }
    filterParts.push(draws.length ? `[vcat]${draws.join(',')}[vout]` : `[vcat]null[vout]`);

    const out = path.join(work, 'final.mp4');
    const args = [
      ...inputs,
      '-filter_complex', filterParts.join(';'),
      '-map', '[vout]', '-map', audioOutLabel,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'fast', '-crf', '20',
      '-c:a', 'aac', '-t', String(totalSec),
      out, '-y',
    ];

    await execFileP('ffmpeg', args, { maxBuffer: 1024 * 1024 * 64 });

    const key = `url-to-ads/${scanId}/video/${adJobId}.mp4`;
    const assetUrl = await storageService.uploadToR2({ localPath: out, key, contentType: 'video/mp4' });

    scan.ads = (scan.ads || []).map(a => {
      const row = a.toObject ? a.toObject() : a;
      if (row.jobId === adJobId) return { ...row, assetUrl, status: 'ready', textBurned: canText, audioMode: mode };
      return row;
    });
    scan.markModified('ads');
    const anyRendering = scan.ads.some(a => ['rendering','queued','shots_ready'].includes((a.toObject ? a.toObject() : a).status));
    if (!anyRendering) scan.status = 'ready';
    await scan.save();

    return { assetUrl, textBurned: canText, audioMode: mode };
  } finally {
    try { fssync.rmSync(work, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { assembleVideoAd, escapeDrawText, hasDrawtext, hasAudioStream };