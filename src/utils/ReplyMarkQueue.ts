import {ConnectionOptions, Queue, QueueEvents, Worker} from "bullmq";
import {REDIS_URL, RedisClient} from "../redis_service";
import {getLogger} from "log4js";
import axios, {AxiosError} from "axios";
import {DB} from "../sql_service";
import {SET_STATUS_LUA_SCRIPT} from "./LuaScript";
import xss from "xss";
import {PutObjectCommand, S3Client} from "@aws-sdk/client-s3";
import {
    S3_ACCESS_KEY_ID,
    S3_ENDPOINT,
    S3_PUBLIC_URL,
    S3_SECRET_ACCESS_KEY,
    SYSTEM_PROMPT
} from "./QuestionGenerateQueue";


export interface MarkingJobDate {
    courseId: string;
    questionId: string;
    subQuestionId: number;
    reply: string;
    replyId: string;
}

export interface MarkedReplySet {
    score?: number;
    understanding_level?: "none" | "low" | "partial" | "good" | "excellent";
    key_point_feedback?: {
        point?: string,
        status?: "full" | "partial" | "missing",
        comment?: string,
    }[],
    one_sentence_summary?: string;
    next_step?: string;
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
const USER_PROMPT = `
TASK: Grade the student answer and estimate understanding (0–100).

SCORING RUBRIC (apply exactly):
- Start at 0.
- For each key point:
  - fully correct: + (70 / number_of_key_points)
  - partially correct: + (40 / number_of_key_points)
  - missing/incorrect: +0
- Clarity bonus: +0 to +15 (clear, coherent, answers the question)
- Major misconception penalty: -0 to -25 (if the misconception_tag appears)
- Cap final score to [0, 100].

IMPORTANT:
- If the student answer includes content not in LESSON EXCERPT, do not reward it.
- Do not be harsh on grammar. Judge meaning.

MATERIAL:
- All materials have been placed in the files.

QUESTION PACKAGE (authoritative):
%Question%

STUDENT ANSWER:
`;
const RESPONSE_FORMAT = {
    type: "json_schema",
    json_schema: {
        name: "GradingResult",
        strict: true,
        schema: {
            type: "object",
            additionalProperties: false,
            required: ["score", "understanding_level", "key_point_feedback", "one_sentence_summary", "next_step"],
            properties: {
                score: {type: "integer", minimum: 0, maximum: 100},
                understanding_level: {type: "string", enum: ["none", "low", "partial", "good", "excellent"]},
                key_point_feedback: {
                    type: "array",
                    items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["point", "status", "comment"],
                        properties: {
                            point: {type: "string"},
                            status: {type: "string", enum: ["full", "partial", "missing"]},
                            comment: {type: "string"}
                        }
                    }
                },
                one_sentence_summary: {"type": "string"},
                next_step: {type: "string"}
            }
        }
    }
};

// Check not undefined
if (!S3_SECRET_ACCESS_KEY || !S3_PUBLIC_URL || !S3_ACCESS_KEY_ID || !S3_ENDPOINT) {
    throw new Error("S3 configuration is missing. Please set S3_PUBLIC_URL, S3_ENDPOINT, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY environment variables.");
}

const connection: ConnectionOptions = {
    url: REDIS_URL
};
const MarkingTaskQueue = new Queue("MarkingTaskQueue", {connection});
const MarkingTaskQueueEvents = new QueueEvents("MarkingTaskQueue", {connection});
const logger = getLogger("/utils/MarkingTaskQueue");
const S3 = new S3Client({
    region: "auto",
    endpoint: S3_ENDPOINT,
    credentials: {
        accessKeyId: S3_ACCESS_KEY_ID,
        secretAccessKey: S3_SECRET_ACCESS_KEY,
    },
});


/**
 * GenerateTaskQueueWorker processes jobs from the "MarkingTaskQueue".
 */
const MarkingTaskQueueWorker = new Worker<MarkingJobDate>("MarkingTaskQueue", async (job) => {
    const {courseId, questionId, subQuestionId, reply, replyId} = job.data;
    const metaKey = `course:${courseId}:question:${questionId}:meta`;
    const cancelKey = `course:${courseId}:question:${questionId}:reply:${replyId}:cancel`;
    const hbKey = `course:${courseId}:question:${questionId}:reply:${replyId}:heartbeat`;
    const channelKey = `course:${courseId}:question:${questionId}:reply:${replyId}:status`;
    const resultKey = `course:${courseId}:question:${questionId}:reply:${replyId}:result`;
    logger.info(`Processing reply marking task. courseId: ${courseId}, taskId: ${questionId}, subQuestionID: ${subQuestionId}, replyId: ${replyId}, attempt: ${job.attemptsStarted}`);

    // heartbeat to prevent stale
    await RedisClient.set(hbKey, new Date().toISOString(), {EX: 60});
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
    let result: MarkedReplySet;
    //todo
    const requestBody = {
        model: /*"google/gemini-2.5-flash"*/ "google/gemini-2.5-flash-lite",
        stream: false,
        temperature: 0.2,
        session_id: courseId,
        top_p: 0.9,
        reasoning: {effort: "medium"},
        modalities: ["text"],
        metadata: {courseId, questionId, replyId},
        response_format: RESPONSE_FORMAT,
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
            role: "system",
            content: "You are a strict grader. Output JSON ONLY that matches the provided schema. No markdown, no extra text. Follow the scoring rubric exactly. Score must be an integer 0-100."
        }, {
            role: "user",
            content: [
                {
                    type: "text",
                    text: USER_PROMPT.replace("%Question%", "") + reply //todo
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

        if (await checkCanceled())
            return;
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

        //todo
        /*try {
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
        }*/
    } catch
        (err: AxiosError | Error | any) {
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
}, {connection, concurrency: 2});

/**
 * Shutdown the MarkingTaskQueue gracefully.
 */
async function shutdownMarkingTaskQueue() {
    try {
        await MarkingTaskQueueWorker.close();
        await MarkingTaskQueue.close();
        await MarkingTaskQueueEvents.close();
        logger.info("Marking task queue closed.");
    } catch (err) {
        logger.error("Failed to close marking task queue.");
        throw err;
    }
}

// event listeners
MarkingTaskQueueEvents.on("completed", (job) => {
    logger.info(`Job ${job.jobId} completed successfully.`);
});
MarkingTaskQueueEvents.on("failed", (job) => {
    logger.error(`Job ${job.jobId} is failed: `, job.failedReason);
});
MarkingTaskQueueEvents.on("removed", (job) => {
    logger.warn(`Job ${job.jobId} is removed from the queue.`);
});
MarkingTaskQueueEvents.on("added", (job) => {
    logger.info(`Job ${job.jobId} is added to the queue.`);
});

export {MarkingTaskQueue, MarkingTaskQueueEvents, shutdownMarkingTaskQueue};
;
;
;
