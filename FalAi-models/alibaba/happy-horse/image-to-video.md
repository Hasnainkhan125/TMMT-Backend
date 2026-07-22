alibaba/happy-horse/image-to-video

Image to Video
Alibaba's #1-ranked Happy Horse 1.0 — generate 1080p video with synchronized native audio and multilingual lip-sync from text prompts or images.
Learn more about Happy Horse
Inference
Commercial use
Partner

Schema
LLMs

Try in Sandbox
Input

Form
Image Url*
https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20250925/wpimhv/rap.png
Choose...
Hint: Drag and drop image files from your computer, images from web pages, paste from clipboard (Ctrl/Cmd+V), or provide a URL. Accepted file types: jpg, jpeg, png, webp, gif, avif


Prompt
Bring the scene in the image to life.
Resolution

1080p
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
For every second of 720p video you generated, you will be charged $0.14/second. For 1080p video you will be charged $0.28/second.

Run Happy Horse 1.0: Image to Video API
Animate any still image into a 1080p video with synchronized native audio, Foley sounds, and multilingual lip-sync. No GPU management required.

Model ID: alibaba/happy-horse/image-to-video
Provider: fal.ai
Commercial rights: Full commercial rights on all outputs

Specifications
Property	Value
Resolution	720p, 1080p
Duration	3–15 seconds
Aspect ratios	16:9, 9:16, 1:1, 4:3, 3:4
Input image min size	400px on shortest side (720p+ recommended)
Input image max size	10 MB
Input formats	JPEG, JPG, PNG, BMP, WEBP
Prompt length	Up to 2,500 characters
Lip-sync languages	English, Mandarin, Cantonese, Japanese, Korean, German, French
Pricing
Resolution	Price
720p	$0.14 / second
1080p	$0.28 / second
A 10-second clip at 1080p costs $2.80.

Quickstart
Install
JavaScript:

bash

npm install @fal-ai/client
Python:

bash

pip install fal-client
Set your API key
bash

export FAL_KEY="YOUR_API_KEY"
Submit a request
JavaScript:

js

import { fal } from "@fal-ai/client";

const result = await fal.subscribe("alibaba/happy-horse/image-to-video", {
  input: {
    image_url: "https://example.com/your-image.jpg",
    prompt: "Bring the scene to life with natural motion and sound.",
    resolution: "1080p",
    duration: 5,
  },
  logs: true,
  onQueueUpdate: (update) => {
    if (update.status === "IN_PROGRESS") {
      update.logs.map((log) => log.message).forEach(console.log);
    }
  },
});

console.log(result.data.video.url);
Python:

python

import fal_client

def on_queue_update(update):
    if isinstance(update, fal_client.InProgress):
        for log in update.logs:
            print(log["message"])

result = fal_client.subscribe(
    "alibaba/happy-horse/image-to-video",
    arguments={
        "image_url": "https://example.com/your-image.jpg",
        "prompt": "Bring the scene to life with natural motion and sound.",
        "resolution": "1080p",
        "duration": 5,
    },
    with_logs=True,
    on_queue_update=on_queue_update,
)

print(result["video"]["url"])
Note: The image_url is used as the first frame. Use a publicly accessible URL, or upload via the client storage helpers below.

Input parameters
Parameter	Type	Default	Description
image_url	string	required	First-frame image URL. Min 400px shortest side, max 10 MB. JPEG, PNG, BMP, or WEBP.
prompt	string	—	Text description guiding the animation. Max 2,500 characters.
resolution	"720p" | "1080p"	"1080p"	Output video resolution.
duration	integer (3–15)	5	Clip length in seconds.
seed	integer (0–2,147,483,647)	—	Set for reproducible outputs.
enable_safety_checker	boolean	true	Content moderation on input and output.
Output
json

{
  "video": {
    "url": "https://...",
    "content_type": "video/mp4",
    "file_name": "output.mp4",
    "file_size": 4404019,
    "width": 1920,
    "height": 1080,
    "fps": 24,
    "duration": 5.0,
    "num_frames": 120
  },
  "seed": 1234567
}
Queue API (long-running requests)
For clips longer than a few seconds, use the queue API to avoid blocking.

JavaScript:

js

import { fal } from "@fal-ai/client";

// Submit
const { request_id } = await fal.queue.submit("alibaba/happy-horse/image-to-video", {
  input: {
    image_url: "https://example.com/your-image.jpg",
    duration: 15,
    resolution: "1080p",
  },
  webhookUrl: "https://your-server.com/webhook",
});

// Poll status
const status = await fal.queue.status("alibaba/happy-horse/image-to-video", {
  requestId: request_id,
  logs: true,
});

// Fetch result once complete
const result = await fal.queue.result("alibaba/happy-horse/image-to-video", {
  requestId: request_id,
});

console.log(result.data.video.url);





## Schema
{
  "openapi": "3.0.4",
  "info": {
    "title": "Queue OpenAPI for alibaba/happy-horse/image-to-video",
    "version": "1.0.0",
    "description": "The OpenAPI schema for the alibaba/happy-horse/image-to-video queue.",
    "x-fal-metadata": {
      "endpointId": "alibaba/happy-horse/image-to-video",
      "category": "image-to-video",
      "thumbnailUrl": "https://v3b.fal.media/files/b/0a975556/jB--KHf1a0VK5l_IML8nX_9a0d18b9f1cf4292a33907002e02a1ba.jpg",
      "playgroundUrl": "https://fal.ai/models/alibaba/happy-horse/image-to-video",
      "documentationUrl": "https://fal.ai/models/alibaba/happy-horse/image-to-video/api"
    }
  },
  "components": {
    "securitySchemes": {
      "apiKeyAuth": {
        "type": "apiKey",
        "in": "header",
        "name": "Authorization",
        "description": "Fal Key"
      }
    },
    "schemas": {
      "QueueStatus": {
        "type": "object",
        "properties": {
          "status": {
            "type": "string",
            "enum": [
              "IN_QUEUE",
              "IN_PROGRESS",
              "COMPLETED"
            ]
          },
          "request_id": {
            "type": "string",
            "description": "The request id."
          },
          "response_url": {
            "type": "string",
            "description": "The response url."
          },
          "status_url": {
            "type": "string",
            "description": "The status url."
          },
          "cancel_url": {
            "type": "string",
            "description": "The cancel url."
          },
          "logs": {
            "type": "object",
            "description": "The logs.",
            "additionalProperties": true
          },
          "metrics": {
            "type": "object",
            "description": "The metrics.",
            "additionalProperties": true
          },
          "queue_position": {
            "type": "integer",
            "description": "The queue position."
          }
        },
        "required": [
          "status",
          "request_id"
        ]
      },
      "HappyHorseImageToVideoInput": {
        "required": [
          "image_url"
        ],
        "description": "Input for Happy Horse image-to-video generation (first frame only).",
        "type": "object",
        "title": "HappyHorseImageToVideoInput",
        "properties": {
          "image_url": {
            "description": "URL of the first frame image. Formats: JPEG, JPG, PNG, BMP, WEBP. Dimensions must be at least 300px. Aspect ratio must be between 1:2.5 and 2.5:1. Max 10 MB.",
            "type": "string",
            "title": "Image Url",
            "examples": [
              "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20250925/wpimhv/rap.png"
            ]
          },
          "prompt": {
            "examples": [
              "Bring the scene in the image to life."
            ],
            "description": "Optional text prompt guiding the animation. Max 2500 characters.",
            "title": "Prompt",
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "resolution": {
            "description": "Output video resolution tier.",
            "default": "1080p",
            "title": "Resolution",
            "enum": [
              "720p",
              "1080p"
            ],
            "type": "string"
          },
          "enable_safety_checker": {
            "description": "Enable content moderation for input and output.",
            "default": true,
            "title": "Enable Safety Checker",
            "type": "boolean"
          },
          "duration": {
            "default": 5,
            "description": "Output video duration in seconds (3-15).",
            "type": "integer",
            "title": "Duration",
            "enum": [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
            "examples": [5, 10, 15]
          },
          "seed": {
            "description": "Random seed for reproducibility (0-2147483647).",
            "title": "Seed",
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "x-fal-order-properties": [
          "image_url",
          "prompt",
          "resolution",
          "duration",
          "seed",
          "enable_safety_checker"
        ]
      },
      "HappyHorseImageToVideoOutput": {
        "required": [
          "video",
          "seed"
        ],
        "description": "Output for Happy Horse video generation.",
        "type": "object",
        "title": "HappyHorseOutput",
        "properties": {
          "seed": {
            "description": "The seed used for generation.",
            "type": "integer",
            "title": "Seed"
          },
          "video": {
            "description": "The generated video file.",
            "$ref": "#/components/schemas/VideoFile"
          }
        },
        "x-fal-order-properties": [
          "video",
          "seed"
        ]
      },
      "VideoFile": {
        "required": [
          "url"
        ],
        "type": "object",
        "title": "VideoFile",
        "properties": {
          "duration": {
            "description": "The duration of the video",
            "title": "Duration",
            "anyOf": [
              {
                "type": "number"
              },
              {
                "type": "null"
              }
            ]
          },
          "width": {
            "description": "The width of the video",
            "title": "Width",
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "file_name": {
            "examples": [
              "z9RV14K95DvU.png"
            ],
            "description": "The name of the file. It will be auto-generated if not provided.",
            "title": "File Name",
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "url": {
            "description": "The URL where the file can be downloaded from.",
            "type": "string",
            "title": "Url"
          },
          "content_type": {
            "examples": [
              "image/png"
            ],
            "description": "The mime type of the file.",
            "title": "Content Type",
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "num_frames": {
            "description": "The number of frames in the video",
            "title": "Num Frames",
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "file_size": {
            "examples": [4404019],
            "description": "The size of the file in bytes.",
            "title": "File Size",
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "height": {
            "description": "The height of the video",
            "title": "Height",
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "fps": {
            "description": "The FPS of the video",
            "title": "Fps",
            "anyOf": [
              {
                "type": "number"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "x-fal-order-properties": [
          "url",
          "content_type",
          "file_name",
          "file_size",
          "width",
          "height",
          "fps",
          "duration",
          "num_frames"
        ]
      }
    }
  },
  "paths": {
    "/alibaba/happy-horse/image-to-video/requests/{request_id}/status": {
      "get": {
        "parameters": [
          {
            "name": "request_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string",
              "description": "Request ID"
            }
          },
          {
            "name": "logs",
            "in": "query",
            "required": false,
            "schema": {
              "type": "number",
              "description": "Whether to include logs (`1`) in the response or not (`0`)."
            }
          }
        ],
        "responses": {
          "200": {
            "description": "The request status.",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/QueueStatus"
                }
              }
            }
          }
        }
      }
    },
    "/alibaba/happy-horse/image-to-video/requests/{request_id}/cancel": {
      "put": {
        "parameters": [
          {
            "name": "request_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string",
              "description": "Request ID"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "The request was cancelled.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": {
                      "type": "boolean",
                      "description": "Whether the request was cancelled successfully."
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/alibaba/happy-horse/image-to-video": {
      "post": {
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/HappyHorseImageToVideoInput"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "The request status.",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/QueueStatus"
                }
              }
            }
          }
        }
      }
    },
    "/alibaba/happy-horse/image-to-video/requests/{request_id}": {
      "get": {
        "parameters": [
          {
            "name": "request_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string",
              "description": "Request ID"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Result of the request.",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/HappyHorseImageToVideoOutput"
                }
              }
            }
          }
        }
      }
    }
  },
  "servers": [
    {
      "url": "https://queue.fal.run"
    }
  ],
  "security": [
    {
      "apiKeyAuth": []
    }
  ]
}
Apollo.io

# Happy Horse

> Generate 1080p video with synchronized native audio from a text prompt and references. Aspect ratios: 16:9, 9:16, 1:1, 4:3, 3:4. Duration: 3–15s.


## Overview

- **Endpoint**: `https://fal.run/alibaba/happy-horse/reference-to-video`
- **Model ID**: `alibaba/happy-horse/reference-to-video`
- **Category**: image-to-video
- **Kind**: inference
**Tags**: stylized, transform, lipsync



## Pricing

For every second of 720p video you generated, you will be charged **$0.14/second**.  For 1080p video you will be charged **$0.28/second**.

For more details, see [fal.ai pricing](https://fal.ai/pricing).

## API Information

This model can be used via our HTTP API or more conveniently via our client libraries.
See the input and output schema below, as well as the usage examples.


### Input Schema

The API accepts the following input parameters:


- **`prompt`** (`string`, _required_):
  Text prompt describing the desired video. Reference subjects from your images using ``character1``, ``character2``, ... up to ``character9`` (the order matches the order of ``image_urls``). Max 2500 characters.
  - Examples: "A dance battle between character1 and character2, cinematic lighting, smooth camera movement."

- **`image_urls`** (`list<string>`, _required_):
  Reference images for subject consistency (1-9 images). Formats: JPEG, JPG, PNG, WEBP. Shortest side must be at least 400 px (720P or higher recommended). Max 10 MB each.
  - Array of string
  - Examples: ["https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20250925/wpimhv/rap.png"]

- **`aspect_ratio`** (`AspectRatioEnum`, _optional_):
  Aspect ratio of the generated video. Default value: `"16:9"`
  - Default: `"16:9"`
  - Options: `"16:9"`, `"9:16"`, `"1:1"`, `"4:3"`, `"3:4"`

- **`resolution`** (`ResolutionEnum`, _optional_):
  Output video resolution tier. Default value: `"1080p"`
  - Default: `"1080p"`
  - Options: `"720p"`, `"1080p"`

- **`duration`** (`DurationEnum`, _optional_):
  Output video duration in seconds (3-15). Default value: `"5"`
  - Default: `5`
  - Options: `3`, `4`, `5`, `6`, `7`, `8`, `9`, `10`, `11`, `12`, `13`, `14`, `15`
  - Examples: 5, 10, 15

- **`seed`** (`integer`, _optional_):
  Random seed for reproducibility (0-2147483647).

- **`enable_safety_checker`** (`boolean`, _optional_):
  Enable content moderation for input and output. Default value: `true`
  - Default: `true`



**Required Parameters Example**:

```json
{
  "prompt": "A dance battle between character1 and character2, cinematic lighting, smooth camera movement.",
  "image_urls": [
    "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20250925/wpimhv/rap.png"
  ]
}
```

**Full Example**:

```json
{
  "prompt": "A dance battle between character1 and character2, cinematic lighting, smooth camera movement.",
  "image_urls": [
    "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20250925/wpimhv/rap.png"
  ],
  "aspect_ratio": "16:9",
  "resolution": "1080p",
  "duration": 5,
  "enable_safety_checker": true
}
```


### Output Schema

The API returns the following output format:

- **`video`** (`VideoFile`, _required_):
  The generated video file.

- **`seed`** (`integer`, _required_):
  The seed used for generation.



**Example Response**:

```json
{
  "video": {
    "url": "",
    "content_type": "image/png",
    "file_name": "z9RV14K95DvU.png",
    "file_size": 4404019
  }
}
```


## Usage Examples

### cURL

```bash
curl --request POST \
  --url https://fal.run/alibaba/happy-horse/reference-to-video \
  --header "Authorization: Key $FAL_KEY" \
  --header "Content-Type: application/json" \
  --data '{
     "prompt": "A dance battle between character1 and character2, cinematic lighting, smooth camera movement.",
     "image_urls": [
       "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20250925/wpimhv/rap.png"
     ]
   }'
```

### Python

Ensure you have the Python client installed:

```bash
pip install fal-client
```

Then use the API client to make requests:

```python
import fal_client

def on_queue_update(update):
    if isinstance(update, fal_client.InProgress):
        for log in update.logs:
           print(log["message"])

result = fal_client.subscribe(
    "alibaba/happy-horse/reference-to-video",
    arguments={
        "prompt": "A dance battle between character1 and character2, cinematic lighting, smooth camera movement.",
        "image_urls": ["https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20250925/wpimhv/rap.png"]
    },
    with_logs=True,
    on_queue_update=on_queue_update,
)
print(result)
```

### JavaScript

Ensure you have the JavaScript client installed:

```bash
npm install --save @fal-ai/client
```

Then use the API client to make requests:

```javascript
import { fal } from "@fal-ai/client";

const result = await fal.subscribe("alibaba/happy-horse/reference-to-video", {
  input: {
    prompt: "A dance battle between character1 and character2, cinematic lighting, smooth camera movement.",
    image_urls: ["https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20250925/wpimhv/rap.png"]
  },
  logs: true,
  onQueueUpdate: (update) => {
    if (update.status === "IN_PROGRESS") {
      update.logs.map((log) => log.message).forEach(console.log);
    }
  },
});
console.log(result.data);
console.log(result.requestId);
```


## Additional Resources

### Documentation

- [Model Playground](https://fal.ai/models/alibaba/happy-horse/reference-to-video)
- [API Documentation](https://fal.ai/models/alibaba/happy-horse/reference-to-video/api)
- [OpenAPI Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=alibaba/happy-horse/reference-to-video)

### fal.ai Platform

- [Platform Documentation](https://docs.fal.ai)
- [Python Client](https://docs.fal.ai/clients/python)
- [JavaScript Client](https://docs.fal.ai/clients/javascript)