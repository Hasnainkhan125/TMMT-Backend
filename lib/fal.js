// src/lib/fal.js
import { fal } from "@fal-ai/client";

fal.config({ credentials: process.env.QUMAK_FLUX_API_KEY });

export async function generateAdVideo({ prompt, aspectRatio = "16:9", duration = 5 }) {
  const result = await fal.subscribe("fal-ai/kling-video/v2/standard/text-to-video", {
    input: {
      prompt,
      aspect_ratio: aspectRatio,
      duration: String(duration),
    },
    logs: true,
  });
  return result.data.video.url;
}