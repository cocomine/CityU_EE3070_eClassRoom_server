# SQL

questions → visibility: 0 = private, 1 = public

questions → status & reply → status: 0 = PENDING, 1 = DONE, 2 = ERROR, 3 = CANCELLED

reply_keypoint → status: 0 = full, 1 = partial, 2 = missing

# Questions Gen Status

PENDING, GENERATING, DONE, ERROR, CANCELLED, STALE

# Redis Lua Script

```lua
-- KEYS[1] = task:{taskId}:meta (hash)
-- ARGV[1] = expected current status (e.g. "GENERATING")
-- ARGV[2] = next status (e.g. "DONE")
local cur = redis.call("HGET", KEYS[1], "status")
if cur == ARGV[1] then
  redis.call("HSET", KEYS[1], "status", ARGV[2])
  return 1
end
return 0
```

# LLM Response

```json
{
    "id": "gen-1773951258-RtfDGmJ1oY5rKXC8vqQ0",
    "object": "chat.completion",
    "created": 1773951258,
    "model": "google/gemini-2.5-flash-lite",
    "provider": "Google",
    "system_fingerprint": null,
    "choices": [
        {
            "index": 0,
            "logprobs": null,
            "finish_reason": "stop",
            "native_finish_reason": "STOP",
            "message": {
                "role": "assistant",
                "content": "{\n  \"question\": [\n    \"Based on the lesson content, explain why the process of photosynthesis is crucial for maintaining atmospheric oxygen levels. Describe how the inputs and outputs of photosynthesis contribute to this balance.\",\n    \"Imagine a scenario where a plant is deprived of sunlight for an extended period. According to the provided material, how would this lack of sunlight specifically impact the plant's ability to produce glucose, and what would be the immediate consequences for its energy reserves?\",\n    \"The lesson excerpt discusses the role of chlorophyll in photosynthesis. Interpret why chlorophyll's specific light absorption properties are essential for capturing light energy. How does this absorption relate to the overall energy conversion process described in the text?\",\n    \"Considering the information presented, compare and contrast the energy requirements and outcomes of the light-dependent reactions versus the light-independent reactions (Calvin cycle) in photosynthesis. Explain why both sets of reactions are interdependent for the complete synthesis of glucose.\"\n  ],\n  \"title\": \"Photosynthesis Understanding Check\"\n}",
                "refusal": null,
                "reasoning": "**Generating Understanding Questions**\n\nI am currently focused on crafting four distinct understanding-check questions, each adhering to a strict length of 1-3 sentences and 40-90 words, directly derived from the provided lesson excerpt and learning objectives.\n\n**Developing Insightful Questions**\n\nI am currently working on formulating four probing questions. My focus is on ensuring each question is concise, falling within the specified sentence and word count limits, and directly aligns with the core learning objectives presented in the lesson material.\n\n**Requesting Missing Materials**\n\nI'm currently unable to generate the required understanding-check questions as the lesson excerpt and learning objectives have not been provided. I need these materials to proceed with the analysis and question formulation.\n\n**Requesting Necessary Inputs**\n\nI'm currently unable to generate the understanding-check questions as the essential lesson excerpt and learning objectives have not been provided. I require these materials to proceed with analyzing the content and formulating the required questions.\n\n",
                "reasoning_details": [
                    {
                        "type": "reasoning.text",
                        "text": "**Generating Understanding Questions**\n\nI am currently focused on crafting four distinct understanding-check questions, each adhering to a strict length of 1-3 sentences and 40-90 words, directly derived from the provided lesson excerpt and learning objectives.\n\n**Developing Insightful Questions**\n\nI am currently working on formulating four probing questions. My focus is on ensuring each question is concise, falling within the specified sentence and word count limits, and directly aligns with the core learning objectives presented in the lesson material.\n\n**Requesting Missing Materials**\n\nI'm currently unable to generate the required understanding-check questions as the lesson excerpt and learning objectives have not been provided. I need these materials to proceed with the analysis and question formulation.\n\n**Requesting Necessary Inputs**\n\nI'm currently unable to generate the understanding-check questions as the essential lesson excerpt and learning objectives have not been provided. I require these materials to proceed with analyzing the content and formulating the required questions.\n\n",
                        "format": "google-gemini-v1",
                        "index": 0
                    }
                ]
            }
        }
    ],
    "usage": {
        "prompt_tokens": 364,
        "completion_tokens": 958,
        "total_tokens": 1322,
        "cost": 0.0004196,
        "is_byok": false,
        "prompt_tokens_details": {
            "cached_tokens": 0,
            "cache_write_tokens": 0,
            "audio_tokens": 0,
            "video_tokens": 0
        },
        "cost_details": {
            "upstream_inference_cost": 0.0004196,
            "upstream_inference_prompt_cost": 0.0000364,
            "upstream_inference_completions_cost": 0.0003832
        },
        "completion_tokens_details": {
            "reasoning_tokens": 749,
            "image_tokens": 0,
            "audio_tokens": 0
        }
    }
}
```

# Question Meta

```json5
{
    "visibility": "0",
    // 0 = private, 1 = public
    "createAt": "2026-03-22T16:11:28.997Z",
    // ISO 8601 format
    "finishedAt": "",
    // ISO 8601 format, empty if not finished
    "errorMessage": "",
    // error message if status is ERROR, empty otherwise
    "questionId": "bc5e102c-4861-4306-8190-713b99991b86",
    // UUID format
    "updateAt": "2026-03-22T16:11:29.019Z",
    // ISO 8601 format
    "title": "New Question (xxxx)",
    // title of the question
    "prompt": "",
    // the prompt used to generate the question, can be empty if not applicable
    "startAt": "2026-03-22T16:11:29.019Z",
    // ISO 8601 format, when the question generation started, can be empty if not started
    "status": "GENERATING",
    // PENDING, GENERATING, DONE, ERROR, CANCELLED, STALE
    "courseId": "546644f3-9632-42b1-a916-79c1657f9938"
    // UUID format, the course this question belongs to
}
```