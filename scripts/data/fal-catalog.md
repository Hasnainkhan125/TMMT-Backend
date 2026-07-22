# Fal.ai Catalog for Qumak

Scraped from https://fal.ai/explore on 2026-04-22T00:00:00.000Z.

- Total models: 97
- text-to-image: 23
- text-to-video: 23
- image-to-video: 19
- image-to-image: 16
- text-to-audio: 16

## Warnings

- fal-ai/runway-gen3/turbo/image-to-video returned 404; runway-gen3 endpoints do not appear to be currently listed on fal.ai. Excluded from catalog.
- fal-ai/kling-video/v1.5/standard/image-to-video returned 404; fal.ai appears to have replaced the v1.5 standard endpoint with v1.6. v1.6 is included instead.
- fal-ai/flux-pro (the original legacy pro endpoint) is marked deprecated on its model page but is still addressable. Kept for completeness.
- fal-ai/luma-dream-machine is marked deprecated on its model page but is still addressable. Kept for completeness.
- Search result pages show 24 trending items per category; catalog contains the curated subset required by the brief plus strongly-represented trending models. Full fal.ai inventory is substantially larger (e.g. 162 text-to-image, 95 text-to-video).
- Input fields (aspect ratios, resolutions, durations) are populated only when observed directly in a model's API schema. Fields left null indicate the schema was not fetched/verified; do not infer defaults.

## text-to-image

| Model ID | Display Name | Family | Pricing | Notes |
|---|---|---|---|---|
| `fal-ai/flux/schnell` | FLUX.1 [schnell] | flux | $0.003/MP | 12B flow transformer, 1–4 step fast generation; commercial use. |
| `fal-ai/flux/dev` | FLUX.1 [dev] | flux | $0.025/MP | 12B FLUX.1 [dev]; higher quality than schnell, 28 default steps. |
| `fal-ai/flux-pro` | _deprecated_ FLUX.1 [pro] (legacy) | flux | $0.05/MP | Legacy FLUX.1 [pro]; marked deprecated on fal.ai. |
| `fal-ai/flux-pro/v1.1` | FLUX1.1 [pro] | flux | $0.04/MP | Enhanced FLUX pro; superior composition and fidelity. |
| `fal-ai/flux-pro/v1.1-ultra` | FLUX1.1 [pro] ultra | flux | $0.06/img | Up to 2K resolution, improved photorealism; default aspect 16:9; optional image_url prompt. |
| `fal-ai/flux-lora` | FLUX.1 [dev] with LoRA | flux |  | Fast FLUX.1 [dev] endpoint with LoRA support for personalization/styles. |
| `fal-ai/flux-2` | FLUX.2 [dev] | flux-2 |  | FLUX.2 dev text-to-image; enhanced realism and text rendering. |
| `fal-ai/flux-2-pro` | FLUX.2 [pro] | flux-2 |  | FLUX.2 pro; premium image editing and sequential edits. |
| `fal-ai/flux-2/turbo` | FLUX.2 [dev] turbo | flux-2 |  | Turbo-speed FLUX.2 dev text-to-image. |
| `fal-ai/stable-diffusion-v3-medium` | Stable Diffusion 3 Medium | stable-diffusion | $0.035/img | SD3 Medium MMDiT; 28 default steps, CFG 5. |
| `fal-ai/stable-diffusion-v35-large` | Stable Diffusion 3.5 Large | stable-diffusion | $0.065/MP | SD 3.5 Large MMDiT; LoRA + ControlNet + IP-Adapter support; 28 default steps. |
| `fal-ai/ideogram/v2` | Ideogram V2 | ideogram | $0.08/img | Ideogram V2; strong typography and realism; style: auto/general/realistic/design/render_3D/anime. |
| `fal-ai/ideogram/v3` | Ideogram V3 | ideogram | $0.06/img, $0.03/img (turbo), $0.09/img (quality) | Ideogram V3; rendering speed TURBO/BALANCED/QUALITY; supports style_codes, color_palette, style_preset. |
| `fal-ai/recraft/v3/text-to-image` | Recraft V3 | recraft | $0.04/img, $0.08/img (vector) | SOTA vector + brand-style T2I; vector styles cost 2×; 90+ named sub-styles. |
| `fal-ai/bytedance/seedream/v4/text-to-image` | ByteDance Seedream 4.0 | seedream | $0.03/img | Unified gen+edit; up to 4096×4096; enhance_prompt_mode standard/fast. |
| `fal-ai/bytedance/seedream/v4.5/text-to-image` | ByteDance Seedream 4.5 | seedream |  | Seedream 4.5; unified gen+edit architecture. |
| `fal-ai/bytedance/seedream/v5/lite/text-to-image` | ByteDance Seedream 5.0 Lite | seedream |  | Fast lite variant of Seedream 5.0 with multi-input support. |
| `fal-ai/nano-banana` | Nano Banana | nano-banana |  | Google's original image gen/edit model. |
| `fal-ai/nano-banana-pro` | Nano Banana Pro | nano-banana |  | Google Nano Banana Pro; strong realism and typography. |
| `fal-ai/nano-banana-2` | Nano Banana 2 | nano-banana |  | Google Nano Banana 2; SOTA fast image generation and editing. |
| `openai/gpt-image-2` | OpenAI GPT Image 2 | gpt-image |  | ChatGPT Images 2.0; fine typography and high-detail generation. |
| `fal-ai/imagen4/preview` | Google Imagen 4 (preview) | imagen |  | Google's highest-quality image generation model (preview). |
| `xai/grok-imagine-image` | xAI Grok Imagine Image | grok-imagine |  | Highly aesthetic images from xAI. |

## text-to-video

| Model ID | Display Name | Family | Pricing | Notes |
|---|---|---|---|---|
| `fal-ai/kling-video/v1/standard/text-to-video` | Kling 1.0 Standard (T2V) | kling | $0.045/s | Kling 1.0 text-to-video; CFG range 0–1 (default 0.5); camera presets. |
| `fal-ai/kling-video/v1.6/standard/text-to-video` | Kling 1.6 Standard (T2V) | kling |  | Kling 1.6 standard T2V. |
| `fal-ai/kling-video/v2/master/text-to-video` | Kling 2.0 Master (T2V) | kling | $1.4/5s, $0.28/s (extra) | Kling 2.0 Master T2V; 5s base $1.40, +$0.28/s. |
| `fal-ai/kling-video/v2.5-turbo/pro/text-to-video` | Kling 2.5 Turbo Pro (T2V) | kling |  | Top-tier motion fluidity, cinematic visuals. |
| `fal-ai/kling-video/v2.6/pro/text-to-video` | Kling 2.6 Pro (T2V) | kling |  | Top-tier T2V with native audio generation. |
| `fal-ai/kling-video/v3/pro/text-to-video` | Kling 3.0 Pro (T2V) | kling |  | Kling 3.0 Pro; native audio + multi-shot support. |
| `fal-ai/kling-video/v3/standard/text-to-video` | Kling 3.0 Standard (T2V) | kling |  | Kling 3.0 Standard; cost-efficient variant with audio + multi-shot. |
| `fal-ai/kling-video/o3/pro/text-to-video` | Kling O3 Pro (T2V) | kling |  | Realistic video generation from Kling O3. |
| `fal-ai/veo3` | Google Veo 3 | veo | $0.2/s, $0.4/s (+audio) | Veo 3 with native audio option; $0.20/s (off) or $0.40/s (on). |
| `fal-ai/veo3/fast` | Google Veo 3 Fast | veo |  | Cheaper/faster variant of Veo 3. |
| `fal-ai/veo3.1` | Google Veo 3.1 | veo |  | Latest Veo model with sound on. |
| `fal-ai/veo3.1/fast` | Google Veo 3.1 Fast | veo |  | Faster/cheaper Veo 3.1. |
| `fal-ai/veo3.1/lite` | Google Veo 3.1 Lite | veo |  | Veo 3.1 Lite; supports T2V and I2V. |
| `fal-ai/luma-dream-machine` | _deprecated_ Luma Dream Machine v1.5 | luma | $0.5/call | Luma Dream Machine v1.5 T2V; $0.50/video; deprecated — successor is Luma Ray 2. |
| `fal-ai/bytedance/seedance/v1/pro/text-to-video` | ByteDance Seedance 1.0 Pro (T2V) | seedance |  | Seedance 1.0 Pro high-quality T2V. |
| `fal-ai/bytedance/seedance/v1.5/pro/text-to-video` | ByteDance Seedance 1.5 Pro (T2V) | seedance |  | Seedance 1.5 Pro T2V with audio. |
| `bytedance/seedance-2.0/text-to-video` | ByteDance Seedance 2.0 (T2V) | seedance |  | Most advanced Seedance: native audio, multi-shot, director-level camera. Note slug lacks fal-ai/ prefix. |
| `bytedance/seedance-2.0/fast/text-to-video` | ByteDance Seedance 2.0 Fast (T2V) | seedance |  | Seedance 2.0 Fast tier; lower latency and cost. |
| `fal-ai/sora-2/text-to-video` | OpenAI Sora 2 (T2V) | sora |  | Sora 2 T2V with audio. |
| `fal-ai/sora-2/text-to-video/pro` | OpenAI Sora 2 Pro (T2V) | sora |  | Sora 2 Pro T2V. |
| `xai/grok-imagine-video/text-to-video` | xAI Grok Imagine Video (T2V) | grok-imagine |  | Grok Imagine Video T2V with audio. |
| `fal-ai/wan/v2.7/text-to-video` | Wan 2.7 (T2V) | wan |  | Wan 2.7 latest-gen AI video model. |
| `wan/v2.6/text-to-video` | Wan 2.6 (T2V) | wan |  | Wan 2.6 T2V; slug lacks fal-ai/ prefix. |

## image-to-video

| Model ID | Display Name | Family | Pricing | Notes |
|---|---|---|---|---|
| `fal-ai/kling-video/v1.6/standard/image-to-video` | Kling 1.6 Standard (I2V) | kling | $0.056/s | Kling 1.6 I2V (std); $0.056/s; CFG range 0–1. |
| `fal-ai/kling-video/v2/master/image-to-video` | Kling 2.0 Master (I2V) | kling | $1.4/5s, $0.28/s (extra) | Kling 2.0 Master I2V; 5s base $1.40, +$0.28/s. |
| `fal-ai/kling-video/v2.1/standard/image-to-video` | Kling 2.1 Standard (I2V) | kling |  | Cost-efficient Kling 2.1 I2V. |
| `fal-ai/kling-video/v2.1/pro/image-to-video` | Kling 2.1 Pro (I2V) | kling |  | Professional-grade Kling 2.1 I2V with camera movement control. |
| `fal-ai/kling-video/v2.5-turbo/pro/image-to-video` | Kling 2.5 Turbo Pro (I2V) | kling |  | Top-tier Kling 2.5 Turbo Pro I2V. |
| `fal-ai/kling-video/v2.6/pro/image-to-video` | Kling 2.6 Pro (I2V) | kling |  | Kling 2.6 Pro I2V with native audio. |
| `fal-ai/kling-video/v3/pro/image-to-video` | Kling 3.0 Pro (I2V) | kling |  | Kling 3.0 Pro I2V with audio and custom element support. |
| `fal-ai/kling-video/v3/standard/image-to-video` | Kling 3.0 Standard (I2V) | kling |  | Kling 3.0 Standard I2V. |
| `fal-ai/kling-video/o3/pro/image-to-video` | Kling O3 Pro (I2V — first/last frame) | kling |  | Kling O3 Pro first/last frame animation. |
| `fal-ai/veo3.1/image-to-video` | Google Veo 3.1 (I2V) | veo |  | Veo 3.1 I2V. |
| `fal-ai/veo3.1/fast/image-to-video` | Google Veo 3.1 Fast (I2V) | veo |  | Veo 3.1 Fast I2V. |
| `fal-ai/veo3.1/first-last-frame-to-video` | Google Veo 3.1 (First/Last Frame → Video) | veo |  | Veo 3.1 first/last frame transition animation. |
| `bytedance/seedance-2.0/image-to-video` | ByteDance Seedance 2.0 (I2V) | seedance |  | Seedance 2.0 I2V with start/end frame control and synced audio. |
| `bytedance/seedance-2.0/fast/image-to-video` | ByteDance Seedance 2.0 Fast (I2V) | seedance |  | Seedance 2.0 Fast tier I2V. |
| `fal-ai/bytedance/seedance/v1/pro/image-to-video` | ByteDance Seedance 1.0 Pro (I2V) | seedance |  | Seedance 1.0 Pro I2V. |
| `fal-ai/bytedance/seedance/v1.5/pro/image-to-video` | ByteDance Seedance 1.5 Pro (I2V) | seedance |  | Seedance 1.5 Pro I2V with start+end frame and audio. |
| `fal-ai/minimax/hailuo-02/standard/image-to-video` | MiniMax Hailuo-02 Standard (I2V) | hailuo | $0.045/s (768p), $0.017/s (512p) | Hailuo-02 standard I2V; 768p $0.045/s, 512p $0.017/s; optional end_image_url. |
| `fal-ai/sora-2/image-to-video` | OpenAI Sora 2 (I2V) | sora |  | Sora 2 I2V with audio. |
| `xai/grok-imagine-video/image-to-video` | xAI Grok Imagine Video (I2V) | grok-imagine |  | Grok Imagine Video I2V with audio. |

## image-to-image

| Model ID | Display Name | Family | Pricing | Notes |
|---|---|---|---|---|
| `fal-ai/flux-pro/kontext` | FLUX.1 Kontext [pro] | flux |  | Text + reference image for targeted local edits and scene transforms. |
| `fal-ai/flux-pro/kontext/max` | FLUX.1 Kontext [max] | flux |  | Kontext [max]: improved prompt adherence and typography, premium consistency. |
| `fal-ai/flux/dev/image-to-image` | FLUX.1 [dev] Image-to-Image | flux |  | FLUX.1 [dev] I2I for style transfers and image modifications. |
| `fal-ai/flux-2/edit` | FLUX.2 [dev] Edit | flux-2 |  | FLUX.2 dev image edit with natural-language and hex-color control. |
| `fal-ai/flux-2-pro/edit` | FLUX.2 [pro] Edit | flux-2 |  | FLUX.2 pro edit: maximum quality photorealism and artistic edits. |
| `fal-ai/nano-banana/edit` | Nano Banana Edit | nano-banana |  | Google's original image editing model. |
| `fal-ai/nano-banana-pro/edit` | Nano Banana Pro Edit | nano-banana |  | Google Nano Banana Pro edit; strong realism and typography. |
| `fal-ai/nano-banana-2/edit` | Nano Banana 2 Edit | nano-banana |  | Google Nano Banana 2 edit. |
| `fal-ai/bytedance/seedream/v4/edit` | ByteDance Seedream 4.0 Edit | seedream |  | Seedream 4.0 editing with unified architecture. |
| `fal-ai/bytedance/seedream/v4.5/edit` | ByteDance Seedream 4.5 Edit | seedream |  | Seedream 4.5 edit. |
| `openai/gpt-image-2/edit` | OpenAI GPT Image 2 Edit | gpt-image |  | ChatGPT Images 2.0 fine-grained edits. |
| `fal-ai/bria/background/remove` | Bria RMBG 2.0 — Remove Background | bria |  | Licensed-data background removal, safe for commercial. |
| `fal-ai/birefnet/v2` | BiRefNet v2 | birefnet |  | High-res dichotomous image segmentation / background removal. |
| `fal-ai/topaz/upscale/image` | Topaz Image Upscale | topaz |  | Topaz upscaler for high-fidelity enhancement. |
| `fal-ai/clarity-upscaler` | Clarity Upscaler | clarity |  | High-fidelity image upscaler. |
| `fal-ai/esrgan` | ESRGAN | esrgan |  | Factor-based image upscaling. |

## text-to-audio

| Model ID | Display Name | Family | Pricing | Notes |
|---|---|---|---|---|
| `fal-ai/elevenlabs/tts/eleven-v3` | ElevenLabs TTS v3 | elevenlabs |  | Text-to-speech with ElevenLabs Eleven v3. |
| `fal-ai/elevenlabs/tts/multilingual-v2` | ElevenLabs TTS Multilingual v2 | elevenlabs |  | Multilingual TTS from ElevenLabs. |
| `fal-ai/elevenlabs/music` | ElevenLabs Music | elevenlabs |  | Realistic music with fine controls. |
| `fal-ai/elevenlabs/sound-effects/v2` | ElevenLabs Sound Effects v2 | elevenlabs |  | ElevenLabs SFX v2. |
| `fal-ai/elevenlabs/text-to-dialogue/eleven-v3` | ElevenLabs Text-to-Dialogue v3 | elevenlabs |  | Generate realistic dialogues with ElevenLabs v3. |
| `fal-ai/stable-audio` | Stable Audio Open | stable-audio | free ($0/compute-s) | Open-source SA; duration range 0–47s, default 30s. |
| `fal-ai/stable-audio-25/text-to-audio` | Stable Audio 2.5 | stable-audio |  | SA 2.5 for music + SFX from StabilityAI. |
| `fal-ai/mmaudio-v2/text-to-audio` | MMAudio v2 (Text→Audio) | mmaudio | $0.001/s | MMAudio synchronized audio generation; duration 1–30s, default 8s. |
| `fal-ai/minimax-music` | MiniMax Music | minimax-music |  | Music generation from text prompts. |
| `fal-ai/minimax-music/v1.5` | MiniMax Music v1.5 | minimax-music |  | MiniMax Music v1.5. |
| `fal-ai/minimax-music/v2` | MiniMax Music v2.0 | minimax-music |  | MiniMax Music 2.0. |
| `fal-ai/minimax-music/v2.6` | MiniMax Music v2.6 | minimax-music |  | Full tracks with singing, backing music, arrangement. |
| `fal-ai/lyria2` | Google Lyria 2 | lyria |  | Google's Lyria 2 general music generation. |
| `fal-ai/ace-step` | ACE-Step (music with lyrics) | ace-step |  | Music with lyrics from text using ACE-Step. |
| `fal-ai/kokoro/american-english` | Kokoro TTS — American English | kokoro |  | Lightweight fast TTS. |
| `fal-ai/gemini-tts` | Google Gemini TTS | gemini-tts |  | Gemini TTS text-to-speech. |
