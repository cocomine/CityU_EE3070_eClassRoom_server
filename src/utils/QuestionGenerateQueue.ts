import {ConnectionOptions, Queue, QueueEvents, Worker} from "bullmq";
import {REDIS_URL, RedisClient} from "../redis_service";
import {getLogger} from "log4js";
import axios from "axios";

export interface QuestionGenerateJobDate {
    courseId: string;
    questionId: string;
    prompt: string;
}

const connection: ConnectionOptions = {
    url: REDIS_URL
};
const QuestionGenerateTaskQueue = new Queue("QuestionGenerateTaskQueue", {connection});
const QuestionGenerateTaskQueueEvents = new QueueEvents("QuestionGenerateTaskQueue", {connection});
const logger = getLogger("/utils/QuestionGenerateQueue");

const GenerateTaskQueueWorker = new Worker<QuestionGenerateJobDate>("QuestionGenerateTaskQueue", async (job) => {
    const {courseId, questionId, prompt} = job.data;
    logger.info(`Processing question generate task. courseId: ${courseId}, taskId: ${questionId}, prompt: ${prompt}`);

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
    let res;
    const requestBody = {
        model: "google/gemini-2.5-flash",
        stream: false,
        temperature: 0.4,
        top_p: 0.9,
        reasoning: {effort: "medium"},
        modalities: ["text"],
        max_output_tokens: 5000,
        metadata: {courseId, taskId: questionId},
        text: {
            format: {
                type: "json_schema",
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
        instructions: SYSTEM_PROMPT,
        input: [{
            type: "message",
            role: "user",
            content: [{
                type: "input_text",
                text: USER_PROMPT + (prompt || "--- NO OTHER REQUIREMENTS ---")
            }/*,{
                    type: 'input_image',
                    image_url: 'data:image/',
                    detail: 'high'
                },{
                    type: 'input_file',
                    file_data: 'data:application/',
                    filename: ''
                }*/
            ]
        }]
    };
    try {
        res = await axios.post("https://openrouter.ai/api/v1/responses", requestBody, {
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${process.env.OPENROUTER_KEY}`
            }
        });
    } catch (err) {
        //todo: fail set meta
        if (job.attemptsStarted >= (job.opts.attempts ?? 5)) {

        }

        logger.error(err);
        throw err;
    }

    // todo: get result
    console.log(res);
    console.log(res.data.output);
    console.log(res.data.output[0].content);
    console.log(res.data.output[1].content);
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

QuestionGenerateTaskQueueEvents.on("completed", (job) => {
    logger.info(`Job ${job.jobId} track data save done`);
});
QuestionGenerateTaskQueueEvents.on("failed", (job) => {
    logger.error(`Job ${job.jobId} track data save failed:`, job.failedReason);
});

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
- Target difficulty: {easy | medium | mixed}
- Allowed knowledge: only from LESSON EXCERPT

QUESTION REQUIREMENTS:
- Each question should be “long but not too long”: 1–3 sentences, 40–90 words.
- Answer should be 1–2 sentences.
- Questions must test understanding, not memorization (use “apply/interpret/explain why”).
- Avoid trick questions. Avoid ambiguous wording.
- Ensure questions are diverse: vary numbers/examples/context/phrasing.
- No external facts beyond LESSON EXCERPT.
- Generate 4 question

MATERIAL:
- All materials have been placed in the files.

OTHER REQUIREMENTS:
`;

export {QuestionGenerateTaskQueue, QuestionGenerateTaskQueueEvents, shutdownQuestionGenerateTaskQueue};