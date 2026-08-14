fal-ai/kling-video/o3/4k/image-to-video

Image to Video (4K)
Kling's Native 4K is a video generation model that directly outputs professional-grade 4K video in one step, eliminating the need for post-production upscaling
Inference
Commercial use
Partner

Schema
LLMs

Input

Form
Prompt
Three weathered Irish countrymen lean on a mossy stone wall under a grey overcast sky in green highlands. Elderly man in herringbone flat cap points to distant hills, gravelly voice: 'Ye see that ridge, lad? Yer grandfather broke his back clearin' stone there.' Freckled boy in oversized cap clutches a stone, listening wide-eyed. Soft wind, muted tones, 35mm film grain, cinematic period drama.
Image Url*
https://v3b.fal.media/files/b/0a95930d/B9sO3YPPn-wGwN2x3Qi1X_7n8rWtHE.png
Choose...
Hint: Drag and drop image files from your computer, images from web pages, paste from clipboard (Ctrl/Cmd+V), or provide a URL. Accepted file types: jpg, jpeg, png, webp, gif, avif


End Image Url
Add an image file or provide a URL
Choose...
Hint: Drag and drop image files from your computer, images from web pages, paste from clipboard (Ctrl/Cmd+V), or provide a URL. Accepted file types: jpg, jpeg, png, webp, gif, avif


Duration

5
Generate Audio

Multi Prompt
Add item
Additional Settings

More
Customize your input with more control.

Reset

Run
⌘
↵
Result
Idle

Preview

JSON
What would you like to do next?
Download
For every second of video you generated, you will be charged $0.42 regardless of whether audio is on or off. For example, a 5s video will cost $2.10.

Run Kling Video O3 4K Image To Video API on fal
Kling's Native 4K is the world's first AI video model with native 4K output — cinema-grade visuals generated in a single step, with no post-production upscaling or third-party tools required. The O3 4K image-to-video endpoint animates a starting frame (and optionally an ending frame) with a bias toward stylized and anime-leaning motion, straight to delivery-ready 4K. Built for: Animating stylized and anime key frames, character walkthroughs and reveals, concept-art motion, and transition shots anchored by a start and end image.

Pricing
Kling V3-Omni in 4K mode is billed per second of generated video.

Configuration	Price per second
4K mode, without video input, without native audio generation	$0.42
4K mode, without video input, with native audio generation	$0.42
A 5-second clip at 4K therefore costs $2.10; a 10-second clip costs $4.20.

Features
Kling O3 4K Image-to-Video turns a static image into cinema-grade 4K motion in a single pass, tuned for stylized and anime-style output. It preserves the input image's subject identity, line work, color palette, and lighting while adding natural, physically plausible movement. You can anchor both the first and last frame of the clip with image_url and end_image_url to drive a specific transition, and sequence distinct shots through multi_prompt. Durations run from 3 to 15 seconds, audio is opt-in via generate_audio, and reference consistency is maintained throughout 4K generation so the stylistic look of the source frame carries all the way through the clip. If you want to learn more visit our kling o3 image-to-video page.

Default prompt template
Scene: [environment continuation from the input image, style cues — anime, cel-shaded, painterly]

Subject motion: [how the subject moves — walking, turning, expression changes, gestures, impact poses]

Camera: [static / slow push / pull / follow-behind / pan / handheld feel]

Important details: [lens, lighting continuity with the source image, color palette, pacing, effects]

Audio: [dialogue, ambient sound, music cues — if generate_audio is enabled]

Constraints: [preserve subject identity / preserve background / no watermark / no logos]

Technical Specifications
Spec	Details
Architecture	Kling Video O3 (Native 4K)
Input Formats	Start image URL (required), optional end image URL, text prompt or multi-shot prompt list
Output Format	MP4 video via URL
Resolution	Native 4K, no post-processing upscale
Duration Range	3 to 15 seconds
Aspect Ratio	Inherited from the input image
Audio	Optional native audio generation
License	Commercial use via fal Partner agreement
API Documentation

What's New in Kling O3 4K Image-to-Video
Industry-First Native 4K from a Still
One-click animation at commercial 4K resolution directly from the source image. No upscaling pass, no chained models, no third-party tools.

Stylized and Anime-Ready
Tuned for expressive, stylized animation. Anime, cel-shaded, painterly, and illustrative looks hold together at 4K without losing line clarity or flattening toward a photoreal bias.

Cinema-Grade Clarity
Ultra-clear visuals that faithfully carry every intricate detail from the input image into motion. Sharpness, atmosphere, and lighting stay at the bar for large-screen display and professional production workflows.

Greater Refinement
Richer color gradations and smoother transitions extend the source image's grade naturally into movement, preserving dimensionality and avoiding banding in subtle lighting areas.

Start + End Frame Control
Anchor both ends of the clip with image_url and end_image_url to drive a specific transition between two states — useful for reveals, transformations, and match cuts — rather than free-form motion.

Stable Reference Consistency
During 4K generation the model preserves the input image's stylistic expression, color, lighting, and overall mood — crucial when the still establishes a specific look that the clip must inherit.

Multi-Shot Composition
Pass a list of prompts via multi_prompt to build a sequenced clip with distinct shots. shot_type controls whether cuts are user-defined (customize) or planned by the model.

Opt-In Native Audio
generate_audio defaults to false on O3 — turn it on when you want speech or ambient sound rendered with the video. Supports Chinese and English; other languages are translated to English automatically.

Quick Start
Install the client
bash

npm install --save @fal-ai/client
Set your API key
bash

export FAL_KEY="YOUR_API_KEY"
Image to video
javascript

import { fal } from "@fal-ai/client";

const result = await fal.subscribe("fal-ai/kling-video/o3/4k/image-to-video", {
  input: {
    image_url: "...",
    prompt: "The character walks forward slowly, with the camera following from behind.",
    duration: "5",
    generate_audio: false,
  },
  logs: true,
  onQueueUpdate: (update) => {
    if (update.status === "IN_PROGRESS") {
      update.logs.map((log) => log.message).forEach(console.log);
    }
  },
});

console.log(result.data.video.url);
Start-to-end frame control
javascript

const result = await fal.subscribe("fal-ai/kling-video/o3/4k/image-to-video", {
  input: {
    image_url: "...",
    end_image_url: "...",
    prompt: "Smooth, stylized transition between the two states, steady camera.",
    duration: "10",
  },
});
Multi-shot from a single starting image
javascript

const result = await fal.subscribe("fal-ai/kling-video/o3/4k/image-to-video", {
  input: {
    image_url: "...",
    multi_prompt: [
      { prompt: "Wide shot — character stands, wind in their hair, anime style.", duration: "3" },
      { prompt: "Camera pushes in on the character's eyes narrowing.", duration: "3" },
      { prompt: "Character sprints forward, motion lines, dynamic framing.", duration: "4" },
    ],
    shot_type: "customize",
    generate_audio: true,
  },
});
API Reference
Input
Parameter	Type	Default	Description
image_url	string	required	URL of the image used as the first frame
end_image_url	string	optional	URL of the image used as the last frame
prompt	string	optional	Text prompt describing the motion. Either prompt or multi_prompt must be provided, not both
multi_prompt	array	optional	List of per-shot prompts for multi-shot generation
duration	enum	"5"	Video duration in seconds. One of "3"–"15"
generate_audio	boolean	false	Generate native audio alongside the video
shot_type	string	"customize"	Multi-shot mode, used with multi_prompt
Output
json

{
  "video": {
    "file_name": "output.mp4",
    "content_type": "video/mp4",
    "url": "https://v3b.fal.media/files/...",
    "file_size": 12037975
  }
}
Use Cases
Anime and stylized shorts -- Animate key frames into full scenes at delivery-grade 4K, with stylistic detail preserved.

Character walkthroughs and reveals -- Follow-behind, push-in, and pull-back shots driven from a single character still.

Concept art to motion -- Turn static illustrations and concept frames into moving pre-visualization shots at production resolution.

Transition and morph shots -- Drive a specific start-to-end change using image_url + end_image_url, ideal for reveals and match cuts.

Poster-quality motion loops -- Short stylized clips derived from a hero frame, suitable for thumbnails, key art motion, and social campaigns.

Multi-shot storytelling -- Sequence multiple shots from a single hero frame with multi_prompt and shot_type.

Long-Running Requests
Video generation is a long-running job. Use the Queue API to submit asynchronously and retrieve results via webhook or polling.

javascript

const { request_id } = await fal.queue.submit("fal-ai/kling-video/o3/4k/image-to-video", {
  input: { image_url: "..." },
  webhookUrl: "https://your-server.com/webhook",
});

const status = await fal.queue.status("fal-ai/kling-video/o3/4k/image-to-video", {
  requestId: request_id,
  logs: true,
});

const result = await fal.queue.result("fal-ai/kling-video/o3/4k/image-to-video", {
  requestId: request_id,
});