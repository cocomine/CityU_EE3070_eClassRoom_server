import {ConnectionOptions, Queue, QueueEvents, Worker} from "bullmq";
import {REDIS_URL, RedisClient} from "../redis_service";
import {getLogger} from "log4js";
import axios, {AxiosError} from "axios";
import {DB} from "../sql_service";
import {SET_STATUS_LUA_SCRIPT} from "./LuaScript";
import xss from "xss";
import {PutObjectCommand, S3Client} from "@aws-sdk/client-s3";

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

export interface GeneratedQuestionSet {
    question?: string[];
    title?: string;
}

export interface ChatMessageContentItemFile {
    type: "file" | string,
    file: {
        file_data: string,
        filename?: string
    }
}

export interface ChatMessageContentItemImage {
    type: "image_url",
    image_url: {
        url: string,
        detail: "auto" | "low" | "high"
    }
}

export interface ChatMessageContentItemText {
    type: "text",
    text: string;
    cache_control?: {
        type: "ephemeral",
        ttl: "5m" | "1h"
    }
}

export type ChatMessageContent =
    string
    | ChatMessageContentItemImage
    | ChatMessageContentItemFile
    | ChatMessageContentItemText;

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
export const SYSTEM_PROMPT = `
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
- You must read the provided files.

OTHER REQUIREMENTS:
- Markdown Support.
-`;

// S3 Config
export const S3_PUBLIC_URL = process.env.S3_PUBLIC_URL;
export const S3_ENDPOINT = process.env.S3_ENDPOINT;
export const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID;
export const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY;

// Check not undefined
if (!S3_SECRET_ACCESS_KEY || !S3_PUBLIC_URL || !S3_ACCESS_KEY_ID || !S3_ENDPOINT) {
    throw new Error("S3 configuration is missing. Please set S3_PUBLIC_URL, S3_ENDPOINT, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY environment variables.");
}

const connection: ConnectionOptions = {
    url: REDIS_URL
};
const QuestionGenerateTaskQueue = new Queue("QuestionGenerateTaskQueue", {connection});
const QuestionGenerateTaskQueueEvents = new QueueEvents("QuestionGenerateTaskQueue", {connection});
const logger = getLogger("/utils/QuestionGenerateQueue");
const S3 = new S3Client({
    region: "auto",
    endpoint: S3_ENDPOINT,
    credentials: {
        accessKeyId: S3_ACCESS_KEY_ID,
        secretAccessKey: S3_SECRET_ACCESS_KEY,
    },
});

/**
 * GenerateTaskQueueWorker processes jobs from the "QuestionGenerateTaskQueue".
 */
const GenerateTaskQueueWorker = new Worker<QuestionGenerateJobDate>("QuestionGenerateTaskQueue", async (job) => {
    const {courseId, questionId, prompt} = job.data;
    const metaKey = `course:${courseId}:question:${questionId}:meta`;
    const hbKey = `course:${courseId}:question:${questionId}:heartbeat`;
    const channelKey = `course:${courseId}:question:${questionId}:status`;
    const resultKey = `course:${courseId}:question:${questionId}:result`;
    const cancelKey = `course:${courseId}:question:${questionId}:cancel`;
    logger.info(`Processing question generate task. courseId: ${courseId}, taskId: ${questionId}, prompt: ${prompt}, attempt: ${job.attemptsStarted}`);

    // heartbeat to prevent stale
    const heartbeat = setInterval(async () => {
        await RedisClient.set(hbKey, new Date().toISOString(), {
            EX: 60
        });
    }, 3000);

    /**
     * Check status is canceled
     * @return true = canceled, false = not canceled
     */
    const checkCanceled = async () => {
        const status = await RedisClient.exists(cancelKey);
        if (status > 0) {
            logger.info(`Question generate task is cancelled. courseId: ${courseId}, questionId: ${questionId}`);
            await RedisClient.multi()
                .hSet(metaKey, {status: "CANCELLED"})
                .publish(channelKey, JSON.stringify({status: "CANCELLED"}))
                .exec();
            clearInterval(heartbeat);
            return true;
        }
        return false;
    };

    if (await checkCanceled()) return;

    // update status
    await RedisClient.hSet(metaKey, {
        status: "GENERATING",
        startAt: new Date().toISOString(),
        updateAt: new Date().toISOString()
    });

    // pub/sub: publish status to channel "course:{courseId}:question:{questionId}:status"
    await RedisClient.publish(channelKey, JSON.stringify({
        status: "GENERATING"
    }));

    // get all files in course
    const fileList: ChatMessageContent[] = [];
    const SqlResult = await DB.all<{
        mime: string,
        blob: Buffer,
        filename: string,
        sha256: string
    }[]>("SELECT fb.mime, fb.blob, f.filename, fb.sha256 FROM file_blob fb JOIN files f ON fb.sha256 = f.sha256 WHERE f.courseID = ?", [courseId]);
    for (let row of SqlResult) {
        // upload to CF R2
        const response = await S3.send(
            new PutObjectCommand({
                Bucket: "ee3070",
                Key: row.sha256,
                Body: row.blob,
                ContentType: row.mime,
            }),
        );
        console.debug(response);

        if (row.mime.includes("image/")) {
            // image file
            fileList.push({
                type: "image_url",
                image_url: {
                    url: S3_PUBLIC_URL + row.sha256,
                    detail: "high"
                }
            });
        } else {
            // other file
            fileList.push({
                type: "file",
                file: {
                    file_data: S3_PUBLIC_URL + row.sha256,
                    filename: row.filename
                }
            });
        }
    }

    // call LLM
    let result: GeneratedQuestionSet;
    const requestBody = {
        model: /*"google/gemini-2.5-flash"*/ "google/gemini-2.5-flash-lite",
        stream: false,
        temperature: 0.5,
        session_id: courseId,
        top_p: 0.9,
        reasoning: {effort: "medium"},
        modalities: ["text"],
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
                            maxLength: 500,
                            description: "A short title about these 4 questions. Must be within 20 words."
                        }
                    },
                    required: ["question", "title"],
                    additionalProperties: false
                }
            }
        },
        plugins: [{
            id: "response-healing"
        }, {
            id: "file-parser",
            pdf: {
                engine: "native",
            },
        }],
        messages: [{
            role: "system",
            content: SYSTEM_PROMPT
        }, {
            role: "user",
            content: [
                {
                    type: "text",
                    text: USER_PROMPT + prompt + "\n--- NO MORE OTHER REQUIREMENTS ---"
                },
                ...fileList
            ]
        }]
    };
    try {
        const res = await axios.post<OpenRouterChatCompletionResponse>("https://nginx-253730240080.us-central1.run.app/chat/completions", requestBody, {
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${process.env.OPENROUTER_KEY}`
            }
        });

        if (await checkCanceled()) return;
        logger.debug(res.data.choices);

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
        result = JSON.parse(xss(content));

        // stop before DB write if cancellation arrives after LLM response
        if (await checkCanceled()) return;

        try {
            await DB.exec("BEGIN");
            // save database
            const statusUpdate = await DB.run(`UPDATE questions
                                               SET status = 1
                                               WHERE ID = ?
                                                 AND status != 3`, questionId);
            if ((statusUpdate.changes ?? 0) === 0) {
                // canceled tasks must not persist generated content
                await DB.exec("ROLLBACK");
                logger.info(`Skip persisting generated result because question ${questionId} is cancelled.`);
                return;
            }

            // save question
            if (result.question && result.question.length > 0) {
                const placeholders = result.question.map(() => "(?, ?, ?)").join(", ");
                const params = result.question.flatMap((question, index) => [questionId, index, question]);
                await DB.run(`INSERT INTO questions_list (question_ID, sub_ID, question)
                              VALUES ${placeholders}`, params);
            }

            // save title
            if (result.title && result.title.length > 0) {
                await DB.run("UPDATE questions SET title = ? WHERE ID = ?", result.title, questionId);
            }

            // save redis
            const multi = RedisClient.multi();
            multi.hSet(metaKey, {
                updateAt: new Date().toISOString(),
                finishedAt: new Date().toISOString(),
            });
            if (result.question && result.question.length > 0) {
                multi.json.set(resultKey, "$", result.question); // save question
            }
            if (result.title && result.title.length > 0) {
                multi.hSet(metaKey, {title: result.title}); // save title
            }

            // update status
            await multi
                .eval(SET_STATUS_LUA_SCRIPT, {
                    keys: ["course:" + courseId + ":question:" + questionId + ":meta"],
                    arguments: ["GENERATING", "DONE"],
                })
                .publish(channelKey, JSON.stringify({ // pub/sub: publish status to channel
                    status: "DONE",
                    title: result.title
                }))
                .exec();
            await DB.exec("COMMIT");
        } catch (err) {
            await DB.exec("ROLLBACK");
            throw err;
        }
    } catch (err: AxiosError | Error | any) {
        // if status is "CANCELLED"
        if (await checkCanceled()) return;


        // if attempts >= 5
        if (job.attemptsStarted >= (job.opts.attempts ?? 5)) {
            // update status
            await RedisClient.multi()
                .eval(SET_STATUS_LUA_SCRIPT, {
                    keys: [metaKey],
                    arguments: ["GENERATING", "ERROR"],
                })
                .hSet(metaKey, {
                    updateAt: new Date().toISOString(),
                    finishedAt: new Date().toISOString(),
                    errorMessage: err.message
                })
                .exec();

            // pub/sub: publish status to channel "course:{courseId}:question:{questionId}:status"
            await RedisClient.publish(channelKey, JSON.stringify({
                status: "ERROR",
            }));

            // update DB
            const stmt = await DB.prepare("UPDATE questions SET status = 2 WHERE id = ? AND status != 3");
            await stmt.bind(questionId);
            await stmt.run();
        } else {
            // attempts < 5
            await RedisClient.eval(SET_STATUS_LUA_SCRIPT, {
                keys: [metaKey],
                arguments: ["GENERATING", "PENDING"],
            });

            // pub/sub: publish status to channel "course:{courseId}:question:{questionId}:status"
            await RedisClient.publish(channelKey, JSON.stringify({
                status: "PENDING"
            }));
        }

        logger.error(err.response.data);
        throw err;
    } finally {
        clearInterval(heartbeat);
    }
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
    logger.info(`Job ${job.jobId} completed successfully.`);
});
QuestionGenerateTaskQueueEvents.on("failed", (job) => {
    logger.error(`Job ${job.jobId} is failed: `, job.failedReason);
});
QuestionGenerateTaskQueueEvents.on("removed", (job) => {
    logger.warn(`Job ${job.jobId} is removed from the queue.`);
});
QuestionGenerateTaskQueueEvents.on("added", (job) => {
    logger.info(`Job ${job.jobId} is added to the queue.`);
});

export {QuestionGenerateTaskQueue, QuestionGenerateTaskQueueEvents, shutdownQuestionGenerateTaskQueue};
