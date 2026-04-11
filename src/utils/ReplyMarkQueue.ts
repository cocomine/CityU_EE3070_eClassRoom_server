import {ConnectionOptions, Queue, QueueEvents, Worker} from "bullmq";
import {REDIS_URL, RedisClient} from "../redis_service";
import {getLogger} from "log4js";
import {DB} from "../sql_service";
import {PutObjectCommand, S3Client} from "@aws-sdk/client-s3";
import {
    ChatMessageContent,
    OpenRouterChatCompletionResponse,
    S3_ACCESS_KEY_ID,
    S3_ENDPOINT,
    S3_PUBLIC_URL,
    S3_SECRET_ACCESS_KEY,
    SqlFileRow,
    SYSTEM_PROMPT
} from "./QuestionGenerateQueue";
import axios, {AxiosError} from "axios";
import xss from "xss";
import {SET_STATUS_LUA_SCRIPT} from "./LuaScript";


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

export interface ValidMarkedReplySet {
    score: number;
    understanding_level: "none" | "low" | "partial" | "good" | "excellent";
    key_point_feedback: {
        point: string,
        status: "full" | "partial" | "missing",
        comment: string,
    }[],
    one_sentence_summary: string;
    next_step: string;
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

export interface SqlQuestionListRow {
    question: string,
    expected_answer: string,
    key_points: string,
    misconception_tag: string
}


/* ==== Prompt === */
const USER_PROMPT = `
TASK: Grade the student answer and estimate understanding (0–100).

MATERIAL:
- All materials have been placed in the files.

QUESTION PACKAGE (authoritative):
%Question%

SCORING RUBRIC (apply exactly):
- Start at 0.
- For each key point:
  - fully correct: + (70 / number_of_key_points)
  - partially correct: + (40 / number_of_key_points)
  - missing/incorrect: +0
- Clarity bonus: +0 to +15 (clear, coherent, answers the question)
- Major misconception penalty: -0 to -25 (if the misconception_tag appears)
- Cap final score to [0, 100].

OUTPUT FORMAT (JSON only):
{
  "score": 0-100,
  "understanding_level": "none|low|partial|good|excellent",
  "key_point_feedback": [
    {"point":"...","status":"full|partial|missing","comment":"..."}
  ],
  "one_sentence_summary": "...",
  "next_step": "..."
}

IMPORTANT:
- If the student answer includes content not in LESSON EXCERPT, do not reward it.
- Do not be harsh on grammar. Judge meaning.
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
const LLM_MODEL = process.env.LLM_MODEL || "google/gemini-2.5-flash-lite";

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
    const metaKey = `course:${courseId}:question:${questionId}:reply:${replyId}:meta`;
    const cancelKey = `course:${courseId}:question:${questionId}:reply:${replyId}:cancel`;
    const hbKey = `course:${courseId}:question:${questionId}:reply:${replyId}:heartbeat`;
    const channelKey = `course:${courseId}:question:${questionId}:reply:${replyId}:status`;
    const resultKey = `course:${courseId}:question:${questionId}:reply:${replyId}:result`;
    const replyKey = `course:${courseId}:question:${questionId}:reply`;
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
            logger.warn(`Question generate task is cancelled. courseId: ${courseId}, questionId: ${questionId}`);
            await RedisClient.multi()
                .publish(channelKey, JSON.stringify({status: "CANCELLED"}))
                .del(metaKey)
                .del(resultKey)
                .del(cancelKey)
                .del(hbKey)
                .sRem(replyKey, replyId)
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
    const fileRows = await DB.all<SqlFileRow[]>("SELECT fb.mime, fb.blob, f.filename, fb.sha256 FROM file_blob fb JOIN files f ON fb.sha256 = f.sha256 WHERE f.courseID = ?", [courseId]);
    for (let row of fileRows) {
        // upload to CF R2
        const response = await S3.send(
            new PutObjectCommand({
                Bucket: "ee3070",
                Key: row.sha256,
                Body: row.blob,
                ContentType: row.mime,
            }),
        );

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

    // get question
    const questionListRow = await DB.get<SqlQuestionListRow>("SELECT question, expected_answer, key_points, misconception_tag FROM questions_list WHERE question_ID = ? AND sub_ID = ? LIMIT 1", [questionId, subQuestionId]);
    const questionPackage = `
    Question: ${questionListRow?.question}
    expected_answer: ${questionListRow?.expected_answer}
    key_points: ${questionListRow?.key_points}
    misconception_tag: ${questionListRow?.misconception_tag}
    `;

    // call LLM
    const requestBody = {
        model: LLM_MODEL,
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
        tools: [
            {
                type: "openrouter:datetime",
                parameters: {
                    timezone: "Asia/Hong_Kong"
                }
            }, {
                type: "function",
                function: {
                    name: "add",
                    description: "Add two numbers and return the sum.",
                    parameters: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            a: {type: "number"},
                            b: {type: "number"}
                        },
                        required: ["a", "b"]
                    }
                }
            }
        ],
        tool_choice: "auto",
        parallel_tool_calls: true,
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
                    text: USER_PROMPT.replace("%Question%", questionPackage)
                },
                ...fileList
            ]
        }, {
            role: "user",
            content: "STUDENT ANSWER:\n" + reply
        }] as any[]
    };

    // Create an Axios client instance with default headers
    const client = axios.create({
        baseURL: process.env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.OPENROUTER_KEY}`,
            "X-Title": "ee3070",
        },
    });

    /*Because the model may call tools and generate intermediate content before the final answer,
    we loop up to 10 times to get the final answer (finish_reason === "stop" or "length").
    In each loop, we check if there are tool_calls in the response.
    If yes, we execute the tool calls and push the tool results back to the model, then continue to the next loop.
    If no tool_calls, we check finish_reason to determine if it's a normal completion or an error/filtered/length-truncated case.*/
    const runChat = async () => {
        for (let step = 1; step <= 10; step++) {
            try {
                logger.info("Starting chat round " + step);
                const res = await client.post<OpenRouterChatCompletionResponse | undefined>("/chat/completions", requestBody);

                // check cancel
                if (await checkCanceled()) return null;
                logger.debug(res.data);

                // filter result
                const choice = res.data?.choices?.[0];
                if (!choice) throw new Error("No choices in response");

                const finishReason: string = choice.finish_reason;
                const msg = choice.message;
                logger.debug(msg);

                // tool call
                const toolCalls = msg.tool_calls ?? [];
                if (toolCalls.length > 0) {
                    requestBody.messages.push(msg); // push to history

                    // Execute each tool call, and then return the result using role=tool.
                    for (const tc of toolCalls) {
                        const toolName = tc.function?.name;
                        const rawArgs = tc.function?.arguments;

                        let args: any;
                        try {
                            args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;

                            const toolOutput = runTool(toolName, args);
                            requestBody.messages.push({
                                role: "tool",
                                tool_call_id: tc.id,
                                content: toolOutput,
                            });
                        } catch (e) {
                            requestBody.messages.push({
                                role: "tool",
                                tool_call_id: tc.id,
                                content: `Tool args JSON parse failed: ${rawArgs}`,
                            });
                        }
                    }
                    // Continue to the next round, letting the model use the tool result to generate the final answer.
                    continue;
                }

                // No tool_calls => This means the output has ended (or has been truncated/filtered).
                if (finishReason === "error") {
                    throw new Error("OpenRouter response error: " + msg.content);
                }
                if (finishReason === "content_filter") {
                    throw new Error("OpenRouter response is filtered by content filter: " + msg.content);
                }
                if (finishReason === "length") {
                    throw new Error("Model output truncated (finish_reason=length):" + msg.content);
                }

                // Normal situation: stop (complete)
                return msg.content;
            } catch (err) {
                logger.error(`Round ${step} - Failed to get valid response from OpenRouter:`, err);
            }
        }
        throw new Error("Failed to get valid response from OpenRouter.");
    }

    try {
        // get result
        const content = await runChat();
        if (!content) return;
        const result: MarkedReplySet = JSON.parse(xss(content));

        //check output
        if (result.score === undefined || !result.understanding_level || !result.key_point_feedback || !result.next_step || !result.one_sentence_summary) {
            throw new Error("Generated result is missing required fields.");
        }
        const validResult = result as ValidMarkedReplySet;

        if (validResult.score < 0 || validResult.score > 100) {
            throw new Error("Generated score is invalid.");
        }
        if (!["none", "low", "partial", "good", "excellent"].includes(validResult.understanding_level)) {
            throw new Error("Generated understanding_level is invalid.");
        }
        if (!Array.isArray(validResult.key_point_feedback)) {
            throw new Error("Generated key_point_feedback is invalid.");
        }
        if (validResult.key_point_feedback.some(item => (!item.point || !item.status || !item.comment))) {
            throw new Error("Generated key_point_feedback is invalid.");
        }
        if (validResult.key_point_feedback.some(item => !["full", "partial", "missing"].includes(item.status))) {
            throw new Error("Generated key_point_feedback has invalid status.");
        }

        // stop before DB write if cancellation arrives after LLM response
        if (await checkCanceled()) return;

        try {
            await DB.exec("BEGIN");
            // save database
            const statusUpdate = await DB.run(
                `UPDATE reply
                 SET status    = 1,
                     score     = ?,
                     summary   = ?,
                     understanding_level = ?,
                     next_step = ?
                 WHERE ID = ?
                   AND status != 3`,
                [validResult.score, validResult.one_sentence_summary, validResult.understanding_level, validResult.next_step, replyId]);
            if ((statusUpdate.changes ?? 0) === 0) {
                // canceled tasks must not persist generated content
                await DB.exec("ROLLBACK");
                logger.info(`Skip persisting generated result because question ${questionId} is cancelled.`);
                return;
            }

            // save reply keypoint
            const placeholders = validResult.key_point_feedback.map(() => "(?, ?, ?, ?, ?)").join(", ");
            const params = validResult.key_point_feedback.flatMap((item, index) =>
                [replyId, index, item.point, item.status, item.comment]);
            await DB.run(`INSERT INTO reply_keypoint (reply_ID, point_ID, point, status, comment)
                          VALUES ${placeholders}`, params);

            // save redis
            const multi = RedisClient.multi()
                .hSet(metaKey, {
                    score: validResult.score,
                    updateAt: new Date().toISOString(),
                    finishedAt: new Date().toISOString(),
                })
                .json.set(resultKey, "$", {...validResult}); // save question

            // update status
            await multi
                .eval(SET_STATUS_LUA_SCRIPT, {
                    keys: [metaKey],
                    arguments: ["GENERATING", "DONE"],
                })
                .publish(channelKey, JSON.stringify({ // pub/sub: publish status to channel
                    status: "DONE",
                    result: validResult
                }))
                .exec();
            await DB.exec("COMMIT");
        } catch (err) {
            await DB.exec("ROLLBACK");
            throw err;
        }
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
            const stmt = await DB.prepare("UPDATE reply SET status = 2 WHERE id = ? AND status != 3");
            await stmt.bind(replyId);
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

        logger.error(err);
        throw err;
    } finally {
        clearInterval(heartbeat);
    }
}, {connection, concurrency: 2});

/**
 *
 * @param name
 * @param args
 */
function runTool(name: string, args: any): string {
    logger.info(`Running tool for ${name}: `, args);
    if (name === "add") {
        const a = Number(args.a);
        const b = Number(args.b);
        if (!Number.isFinite(a) || !Number.isFinite(b)) {
            throw new Error(`Invalid args for add: ${JSON.stringify(args)}`);
        }
        return JSON.stringify({result: a + b});
    }
    throw new Error(`Unknown tool: ${name}`);
}

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
