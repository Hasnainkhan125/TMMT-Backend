fal-ai/kling-video/o3/4k/reference-to-video

Reference to Video (4K)
Kling's Native 4K is a video generation model that directly outputs professional-grade 4K video in one step, eliminating the need for post-production upscaling
Inference
Commercial use
Partner

Schema
LLMs

Input

Form
Prompt
The scene opens in a warm, sunlit kitchen on a crisp autumn morning. A hammered copper gooseneck kettle sits on a black cast-iron gas stove, its polished surface catching the golden morning light and scattering dappled reflections across the white subway tile backsplash. Through the slightly open window beside it, rain-speckled glass frames a blurred view of yellow autumn leaves swaying outside. Soft steam begins to curl lazily from the kettle's slender spout.The camera opens on a wide establishing shot of the kettle and window, then slowly dollies in toward the stove. As it approaches, the steam thickens and rises, and a faint whistle begins to build. The camera arcs gently around the kettle in a slow 180-degree orbit, catching the light bouncing off the hammered copper texture from every angle, the reflections dancing across the tiles like scattered embers.The camera then glides left, drifting away from the stove and smoothly transitioning across the kitchen. Sunlight streaks through the lens in a soft anamorphic flare as the shot lands on a rustic wooden cutting board resting on a farmhouse table. On it, @Element1 — a beautifully rustic artisan sourdough boule with a deeply scored, crackled mahogany-brown crust dusted in pale flour, intricate ear-like scoring patterns along its domed top, resting on a wrinkled natural linen cloth — sits steaming gently, fresh from the oven. Beside it, a pale ceramic proofing bowl holds a small pile of flour, and wisps of flour dust drift lazily through the shafts of window light.
Multi Prompt
Add item
Start Image Url
https://v3b.fal.media/files/b/0a959325/CnKMhglU8EpktDkhMPYdR_9wwdAqBX.png
Choose...
Hint: Drag and drop image files from your computer, images from web pages, paste from clipboard (Ctrl/Cmd+V), or provide a URL. Accepted file types: jpg, jpeg, png, webp, gif, avif


End Image Url
Add an image file or provide a URL
Choose...
Hint: Drag and drop image files from your computer, images from web pages, paste from clipboard (Ctrl/Cmd+V), or provide a URL. Accepted file types: jpg, jpeg, png, webp, gif, avif


Image Urls
Add Image
Add image from URL or paste from clipboard
Add URL
Hint: Drag and drop files from your computer, images from web pages, paste from clipboard (Ctrl/Cmd+V), or provide a URL.

Elements
Frontal Image Url
https://v3b.fal.media/files/b/0a959323/FRSAFvww7N3rwt2zwzouQ_X6wum1Vf.png
Choose...
Hint: Drag and drop image files from your computer, images from web pages, paste from clipboard (Ctrl/Cmd+V), or provide a URL. Accepted file types: jpg, jpeg, png, webp, gif, avif


Reference Image Urls
Add Image
Add image from URL or paste from clipboard
Add URL
Hint: Drag and drop files from your computer, images from web pages, paste from clipboard (Ctrl/Cmd+V), or provide a URL.


1 image added
Video Url
Add a video file or provide a URL
Choose...
Hint: Drag and drop video files from your computer, video from web pages, paste from clipboard (Ctrl/Cmd+V), or provide a URL. Accepted file types: mp4, mov, webm, m4v, gif

Voice Id

Add item
Generate Audio

Duration

5
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

Run Kling Video O3 4K Reference To Video API on fal
Kling's Native 4K is the world's first AI video model with native 4K output — cinema-grade visuals generated in a single step, with no post-production upscaling or third-party tools required. The O3 4K reference-to-video endpoint composes a clip from multiple references — characters, objects, and style images — addressed directly in the prompt via @Element1, @Image1, and so on. Built for: Combining specific characters, props, and style references into a single 4K clip — ideal for storyboarding with known subjects, brand-consistent spots, multi-character scenes, and look-development work.

Pricing
Kling V3-Omni in 4K mode is billed per second of generated video.

Configuration	Price per second
4K mode, without video input, without native audio generation	$0.42
4K mode, without video input, with native audio generation	$0.42
A 5-second clip at 4K therefore costs $2.10; a 10-second clip costs $4.20.

Reference inputs passed via elements as image sets (frontal_image_url + reference_image_urls) or via image_urls do not count as a "video input" for billing purposes. Video-based reference elements (video_url inside elements) may be priced under a separate tier — confirm on fal.ai pricing before a production rollout.

Features
Kling O3 4K Reference-to-Video composes a cinema-grade 4K clip from a set of references rather than a single source frame. Pass elements for characters or objects (each a frontal+reference image set or a reference video) and image_urls for style and appearance references, then address them in the prompt as @Element1, @Element2, @Image1, @Image2, and so on. Combined, elements + image_urls may total up to 7 references. Optionally anchor the clip with start_image_url and end_image_url. Durations run from 3 to 15 seconds, aspect ratios cover 16:9, 9:16, and 1:1, audio is opt-in via generate_audio, and reference consistency is maintained throughout 4K generation so subjects and style stay faithful across the entire clip. If you want to learn more visit our kling o3 reference-to-video page.

Default prompt template
Scene: [where this happens, time of day, background, environment, style cues]

Subjects: [@Element1, @Element2, ... — who enters, what they do, how they interact]

Style references: [@Image1, @Image2, ... — palette, lighting style, art direction to follow]

Camera: [static / follow / push / pull / pan / framing choices]

Important details: [pacing, atmosphere, effects, material response]

Audio: [dialogue, ambient sound, music cues — if generate_audio is enabled]

Constraints: [preserve element identity / preserve style / no watermark / no logos]

Technical Specifications
Spec	Details
Architecture	Kling Video O3 (Native 4K)
Input Formats	Text prompt or multi-shot prompt list, up to 7 combined references (elements + style images), optional start and end frame images
Output Format	MP4 video via URL
Resolution	Native 4K, no post-processing upscale
Duration Range	3 to 15 seconds
Aspect Ratios	16:9, 9:16, 1:1
Audio	Optional native audio generation
License	Commercial use via fal Partner agreement
API Documentation

What's New in Kling O3 4K Reference-to-Video
Industry-First Native 4K
One-click export for professional-grade 4K video. Output goes straight from the model at commercial 4K resolution — no separate upscaling pipeline, no quality degradation from chained models, and no third-party tools.

Multi-Reference Composition
Combine up to 7 references — any mix of elements (characters/objects) and image_urls (style/appearance). Each is addressable by position in the prompt: @Element1, @Element2, @Image1, @Image2, and so on. Useful when a scene needs specific characters, props, and a specific look at the same time.

Character and Object Elements
elements accept either an image set (frontal + reference images) or an entire reference video. The model extracts identity, silhouette, wardrobe, and styling from these references and keeps them consistent across the generated clip.

Style and Appearance References
image_urls drive palette, lighting, material feel, and overall art direction without acting as a specific subject. Pair with @Image1 references in the prompt to steer the look.

Optional Start and End Frames
start_image_url and end_image_url anchor the clip's first and last frame when you need a specific opening or closing state. Both are optional — use them for transitions, reveals, and match cuts.

Cinema-Grade Clarity and Refinement
Ultra-clear visuals, richer color gradations, and smoother transitions. Sharpness, atmosphere, and lighting hit the bar for large-screen display and professional production workflows out of the box.

Stable Reference Consistency
Throughout 4K generation, element features, stylistic expression, color, lighting, and overall mood remain faithful to the provided references — key when a scene must hold a specific look or subject identity across shots.

Multi-Shot Composition
Pass a list of prompts via multi_prompt to build a sequenced clip with distinct shots. shot_type controls whether cuts are user-defined (customize) or planned by the model.

Opt-In Native Audio
generate_audio defaults to false — turn it on when you want speech or ambient sound rendered with the video. Supports Chinese and English; other languages are translated to English automatically.

Quick Start
Install the client
bash

npm install --save @fal-ai/client
Set your API key
bash

export FAL_KEY="YOUR_API_KEY"
Reference to video
javascript

import { fal } from "@fal-ai/client";

const result = await fal.subscribe("fal-ai/kling-video/o3/4k/reference-to-video", {
  input: {
    prompt: "@Element1 and @Element2 enter the scene from two sides. The elephant starts to play with the ball.",
    elements: [
      { video_url: "..." },
      {
        frontal_image_url: "...",
        reference_image_urls: ["..."],
      },
    ],
    duration: "8",
    aspect_ratio: "16:9",
  },
  logs: true,
  onQueueUpdate: (update) => {
    if (update.status === "IN_PROGRESS") {
      update.logs.map((log) => log.message).forEach(console.log);
    }
  },
});

console.log(result.data.video.url);
Elements + style references
javascript

const result = await fal.subscribe("fal-ai/kling-video/o3/4k/reference-to-video", {
  input: {
    prompt: "@Element1 walks through the scene in the palette and mood of @Image1 and @Image2.",
    elements: [
      {
        frontal_image_url: "...",
        reference_image_urls: ["..."],
      },
    ],
    image_urls: [
      "...",
      "...",
    ],
    duration: "6",
    aspect_ratio: "16:9",
  },
});
Start + end frame with references
javascript

const result = await fal.subscribe("fal-ai/kling-video/o3/4k/reference-to-video", {
  input: {
    prompt: "@Element1 transitions from the opening state to the closing state, cinematic camera.",
    start_image_url: "...",
    end_image_url: "...",
    elements: [
      {
        frontal_image_url: "...",
        reference_image_urls: ["..."],
      },
    ],
    duration: "8",
    aspect_ratio: "16:9",
  },
});
Multi-shot with references
javascript

const result = await fal.subscribe("fal-ai/kling-video/o3/4k/reference-to-video", {
  input: {
    multi_prompt: [
      { prompt: "@Element1 enters from the left, styled like @Image1.", duration: "3" },
      { prompt: "@Element2 enters from the right and meets @Element1.", duration: "3" },
      { prompt: "They walk forward together into the distance.", duration: "4" },
    ],
    shot_type: "customize",
    elements: [
      { video_url: "..." },
      { video_url: "..." },
    ],
    image_urls: ["..."],
    aspect_ratio: "16:9",
    generate_audio: true,
  },
});
API Reference
Input
Parameter	Type	Default	Description
prompt	string	optional	Text prompt for video generation. Either prompt or multi_prompt must be provided, not both
multi_prompt	array	optional	List of per-shot prompts for multi-shot generation
elements	array	optional	Characters/objects. Each entry is either an image set (frontal_image_url + reference_image_urls) or a video_url. Reference in prompt as @Element1, @Element2, etc.
image_urls	array	optional	Style/appearance reference images. Reference in prompt as @Image1, @Image2, etc.
start_image_url	string	optional	Image used as the first frame
end_image_url	string	optional	Image used as the last frame
duration	enum	"5"	Video duration in seconds. One of "3"–"15"
aspect_ratio	enum	"16:9"	16:9, 9:16, or 1:1
generate_audio	boolean	false	Generate native audio alongside the video
shot_type	string	"customize"	Multi-shot mode, used with multi_prompt
Combined reference limit: elements.length + image_urls.length ≤ 7.

Element structure
Each entry in elements takes one of two shapes:

json

{
  "frontal_image_url": "https://.../subject_front.png",
  "reference_image_urls": [
    "https://.../subject_back.png",
    "https://.../subject_side.png"
  ]
}
or

json

{
  "video_url": "https://.../reference_clip.mp4"
}
Elements are referenced positionally in prompts as @Element1, @Element2, etc. Style references in image_urls are addressed as @Image1, @Image2, etc.

Output
json

{
  "video": {
    "file_name": "output.mp4",
    "content_type": "video/mp4",
    "url": "https://v3b.fal.media/files/...",
    "file_size": 18468404
  }
}
Use Cases
Brand-consistent spots -- Combine a specific character, a specific product, and a specific art-direction reference in one 4K clip.

Storyboarding with known subjects -- Drop in character and prop references and iterate on blocking, staging, and camera language.

Multi-character scenes -- Address each subject explicitly with @Element1, @Element2 so each keeps their identity across the shot.

Look-development -- Lock a palette or lighting style with image_urls references and explore motion within that look.

Transition shots with references -- Use start_image_url + end_image_url to drive a specific transition while keeping referenced subjects consistent.

Multi-shot reference reels -- Build sequenced clips where the same characters and style references persist across beats via multi_prompt.

Long-Running Requests
Video generation is a long-running job. Use the Queue API to submit asynchronously and retrieve results via webhook or polling.

javascript

const { request_id } = await fal.queue.submit("fal-ai/kling-video/o3/4k/reference-to-video", {
  input: { prompt: "...", elements: [/* ... */] },
  webhookUrl: "https://your-server.com/webhook",
});

const status = await fal.queue.status("fal-ai/kling-video/o3/4k/reference-to-video", {
  requestId: request_id,
  logs: true,
});

const result = await fal.queue.result("fal-ai/kling-video/o3/4k/reference-to-video", {
  requestId: request_id,
});