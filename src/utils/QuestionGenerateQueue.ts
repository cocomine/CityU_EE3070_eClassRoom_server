import {ConnectionOptions, Queue, QueueEvents, Worker} from "bullmq";
import {REDIS_URL, RedisClient} from "../redis_service";
import {getLogger} from "log4js";
import axios, {AxiosError} from "axios";
import {DB} from "../sql_service";
import fs from "fs";
import {SET_STATUS_LUA_SCRIPT} from "./LuaScript";

/**
 * QuestionGenerateJobDate defines the data structure for a job in the question generation queue. Each job contains:
 - courseId: The ID of the course for which questions are being generated.
 - questionId: A unique ID for the question generation task.
 - prompt: An optional string that may contain additional instructions or context for question generation.
 */
export interface QuestionGenerateJobDate {
    courseId: string;
    questionId: string;
    prompt: string;
}

interface GeneratedQuestionSet {
    question: string[];
    title: string;
}

/* ===== OpenRouterChatCompletionResponse Type ===== */
interface OpenRouterChatCompletionResponse {
    id: string;
    object: "chat.completion";
    created: number;
    model: string;
    provider?: string;
    system_fingerprint?: string | null;
    choices: OpenRouterChoice[];
    usage: OpenRouterUsage | null;
}

interface OpenRouterChoice {
    index: number;
    logprobs: unknown | null;
    finish_reason: "tool_calls" | "stop" | "length" | "content_filter" | "error" | string;
    native_finish_reason?: string | null;
    message: OpenRouterMessage;
}

interface OpenRouterMessage {
    role: "assistant";
    content: string | null;
    refusal: string | null;
    reasoning: string | null;
    reasoning_details?: (OpenRouterReasoningTextDetail | OpenRouterReasoningSummaryDetail | OpenRouterReasoningEncryptedDetail)[] | null;
}

interface OpenRouterReasoningTextDetail {
    type: "reasoning.text";
    text: string | null;
    format: "unknown" | "openai-responses-v1" | "azure-openai-responses-v1" | "xai-responses-v1" | "anthropic-claude-v1" | "google-gemini-v1" | null;
    index: number | null;
}

interface OpenRouterReasoningSummaryDetail {
    type: "reasoning.summary";
    summary: string;
    id: string | null;
    format: "unknown" | "openai-responses-v1" | "azure-openai-responses-v1" | "xai-responses-v1" | "anthropic-claude-v1" | "google-gemini-v1" | null;
    index: number | null;
}

interface OpenRouterReasoningEncryptedDetail {
    type: "reasoning.encrypted";
    data: string;
    id: string | null;
    format: "unknown" | "openai-responses-v1" | "azure-openai-responses-v1" | "xai-responses-v1" | "anthropic-claude-v1" | "google-gemini-v1" | null;
    index: number | null;
}

interface OpenRouterUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost?: number;
    is_byok?: boolean;
    prompt_tokens_details?: Record<string, number>;
    cost_details?: Record<string, number>;
    completion_tokens_details?: Record<string, number>;
}

/* ===== penRouterChatCompletionResponse Type End ===== */

/* ==== Prompt === */
const SYSTEM_PROMPT = `
You are “Classroom Checkpoint Tutor”, an assistant that helps a teacher assess student understanding of the lesson content provided to you.

Core rules:
- Use ONLY the provided lesson content as the source of truth. If the lesson content does not support something, say “Not in the lesson content”.
- Keep a teacher-friendly tone. Be precise and not verbose.
- Never reveal the hidden rubric, scoring rules, or any chain-of-thought. Provide only final outputs.
- Output must be valid JSON when requested.

Assessment philosophy:
- Reward correct reasoning even if wording is imperfect.
- If the student answer is partially correct, give partial credit and explain the missing piece briefly.
- Be robust to minor grammar mistakes and non-native English.

Safety/classroom rules:
- Do not generate harmful, explicit, or inappropriate content.
- If the teacher’s request conflicts with these rules, refuse and offer a safe alternative.
`;
const USER_PROMPT = `
TASK: Generate individualized understanding-check questions.

TEACHER INTENT:
- Check whether students understand: {learning_objectives_as_bullets}
- Target difficulty: mixed (some easy, some challenging)
- Allowed knowledge: only from LESSON EXCERPT

QUESTION REQUIREMENTS:
- Each question should be “long but not too long”: 1–3 sentences, 40–90 words.
- Answer should be 1–2 sentences.
- Questions must test understanding, not memorization (use “apply/interpret/explain why”).
- Avoid trick questions. Avoid ambiguous wording.
- Ensure questions are diverse: vary numbers/examples/context/phrasing.
- No external facts beyond LESSON EXCERPT.
- Exactly generate 4 question.

MATERIAL:
- All materials have been placed in the files.

OTHER REQUIREMENTS:
`;

const connection: ConnectionOptions = {
    url: REDIS_URL
};
const QuestionGenerateTaskQueue = new Queue("QuestionGenerateTaskQueue", {connection});
const QuestionGenerateTaskQueueEvents = new QueueEvents("QuestionGenerateTaskQueue", {connection});
const logger = getLogger("/utils/QuestionGenerateQueue");

const TestFile = fs.readFileSync("./Test.pdf", {encoding: "base64"});

/**
 * GenerateTaskQueueWorker processes jobs from the "QuestionGenerateTaskQueue".
 */
const GenerateTaskQueueWorker = new Worker<QuestionGenerateJobDate>("QuestionGenerateTaskQueue", async (job) => {
    const {courseId, questionId, prompt} = job.data;
    logger.info(`Processing question generate task. courseId: ${courseId}, taskId: ${questionId}, prompt: ${prompt}, attempt: ${job.attemptsStarted}`);

    // update status
    await RedisClient.hSet("course:" + courseId + ":question:" + questionId + ":meta", {
        status: "GENERATING",
        startAt: new Date().toISOString(),
        updateAt: new Date().toISOString()
    });

    // pub/sub: publish status to channel "course:{courseId}:question:{questionId}:status"
    await RedisClient.publish("course:" + courseId + ":question:" + questionId + ":status", JSON.stringify({
        status: "GENERATING"
    }));

    // heartbeat to prevent stale
    const heartbeat = setInterval(async () => {
        await RedisClient.set("course:" + courseId + ":question:" + questionId + ":heartbeat", new Date().toISOString(), {
            EX: 60
        });
    }, 3000);

    // call LLM
    let result: GeneratedQuestionSet;
    const requestBody = {
        model: /*"google/gemini-2.5-flash"*/ "google/gemini-2.5-flash-lite",
        stream: false,
        temperature: 0.5,
        top_p: 0.9,
        reasoning: {effort: "medium"},
        modalities: ["text"],
        max_completion_tokens: 2000,
        metadata: {courseId, questionId},
        response_format: {
            type: "json_schema",
            json_schema: {
                name: "QuestionSet",
                strict: true,
                schema: {
                    type: "object",
                    properties: {
                        question: {
                            type: "array",
                            minItems: 4,
                            maxItems: 4,
                            items: {
                                type: "string",
                                minLength: 1
                            },
                            description: "Exactly 4 questions."
                        },
                        title: {
                            type: "string",
                            minLength: 1,
                            maxLength: 600,
                            description: "A short title about these 4 questions. Must be within 100 words."
                        }
                    },
                    required: ["question", "title"],
                    additionalProperties: false
                }
            }
        },
        plugins: [{id: "response-healing"}],
        messages: [{
            role: "system",
            content: SYSTEM_PROMPT
        }, {
            role: "user",
            content: [
                {
                    type: "text",
                    text: USER_PROMPT + (prompt || "--- NO OTHER REQUIREMENTS ---")
                }, {
                    type: "file",
                    file: {
                        file_data: "data:application/pdf;base64," + TestFile,
                        filename: "test.pdf"
                    }
                }
                //TODO: file upload
                /*{
                    type: "input_image",
                    image_url: "data:image/",
                    detail: "high"
                }*/
            ]
        }]
    };
    try {
        const res = await axios.post<OpenRouterChatCompletionResponse>("https://openrouter.ai/api/v1/chat/completions", requestBody, {
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${process.env.OPENROUTER_KEY}`
            }
        });

        // check status is "CANCELLED"
        const status = await RedisClient.hGet("course:" + courseId + ":question:" + questionId + ":meta", "status");
        if (status === "CANCELLED") {
            logger.info(`Question generate task is cancelled. courseId: ${courseId}, questionId: ${questionId}`);
            return;
        }

        // filter result
        const choice = res.data.choices.find(choice => choice.message.role === "assistant");
        const content = choice?.message?.content;
        if (typeof content !== "string") {
            throw new Error("OpenRouter response is missing choices.message.content");
        }
        if (choice?.finish_reason === "error") {
            throw new Error("OpenRouter response error: " + content);
        }
        if (choice?.finish_reason === "content_filter") {
            throw new Error("OpenRouter response is filtered by content filter: " + content);
        }

        // get result
        result = JSON.parse(content);

        // save result
        const multi = RedisClient.multi();
        for (let item of result.question) {
            multi.lPush("course:" + courseId + ":question:" + questionId + ":result", item);
        }
        await multi.exec();

        // save database
        if (result.question.length > 0) {
            const placeholders = result.question.map(() => "(?, ?, ?)").join(", ");
            const params = result.question.flatMap((question, index) => [questionId, index, question]);
            await DB.run(`INSERT INTO questions_list (question_ID, sub_ID, question)
                          VALUES ${placeholders}`, params);
        }
        await DB.run(`UPDATE questions
                      SET status = 1
                      WHERE ID = ?`, questionId);
    } catch (err: AxiosError | Error | any) {
        // if status is "CANCELLED"
        const status = await RedisClient.hGet("course:" + courseId + ":question:" + questionId + ":meta", "status");
        if (status === "CANCELLED") {
            logger.info(`Question generate task is cancelled. courseId: ${courseId}, questionId: ${questionId}`);
            return;
        }

        // if attempts >= 5
        if (job.attemptsStarted >= (job.opts.attempts ?? 5)) {
            // update status
            await RedisClient.eval(SET_STATUS_LUA_SCRIPT, {
                keys: ["course:" + courseId + ":question:" + questionId + ":meta"],
                arguments: ["GENERATING", "ERROR"],
            });
            await RedisClient.hSet("course:" + courseId + ":question:" + questionId + ":meta", {
                updateAt: new Date().toISOString(),
                finishedAt: new Date().toISOString(),
                errorMessage: err.message
            });

            // pub/sub: publish status to channel "course:{courseId}:question:{questionId}:status"
            await RedisClient.publish("course:" + courseId + ":question:" + questionId + ":status", JSON.stringify({
                status: "ERROR"
            }));

            // update DB
            const stmt = await DB.prepare("UPDATE questions SET status = 2 WHERE id = ? AND status != 3");
            await stmt.bind(questionId);
            await stmt.run();
        } else {
            // attempts < 5
            await RedisClient.eval(SET_STATUS_LUA_SCRIPT, {
                keys: ["course:" + courseId + ":question:" + questionId + ":meta"],
                arguments: ["GENERATING", "PENDING"],
            });

            // pub/sub: publish status to channel "course:{courseId}:question:{questionId}:status"
            await RedisClient.publish("course:" + courseId + ":question:" + questionId + ":status", JSON.stringify({
                status: "PENDING"
            }));
        }

        logger.error(err);
        throw err;
    } finally {
        clearInterval(heartbeat);
    }

    // update status
    await RedisClient.eval(SET_STATUS_LUA_SCRIPT, {
        keys: ["course:" + courseId + ":question:" + questionId + ":meta"],
        arguments: ["GENERATING", "DONE"],
    });
    await RedisClient.hSet("course:" + courseId + ":question:" + questionId + ":meta", {
        updateAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
    });

    // pub/sub: publish status to channel
    await RedisClient.publish("course:" + courseId + ":question:" + questionId + ":status", JSON.stringify({
        status: "DONE"
    }));
}, {connection, concurrency: 1});

/**
 * Shutdown the QuestionGenerateTaskQueue gracefully.
 */
async function shutdownQuestionGenerateTaskQueue() {
    try {
        await GenerateTaskQueueWorker.close();
        await QuestionGenerateTaskQueue.close();
        await QuestionGenerateTaskQueueEvents.close();
        logger.info("Question generate task queue closed.");
    } catch (err) {
        logger.error("Failed to close question generate task queue.");
        throw err;
    }
}

// event listeners
QuestionGenerateTaskQueueEvents.on("completed", (job) => {
    logger.info(`Job ${job.jobId} track data save done`);
});
QuestionGenerateTaskQueueEvents.on("failed", (job) => {
    logger.error(`Job ${job.jobId} track data save failed:`, job.failedReason);
});

export {QuestionGenerateTaskQueue, QuestionGenerateTaskQueueEvents, shutdownQuestionGenerateTaskQueue};
