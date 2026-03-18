import {ConnectionOptions, Queue, QueueEvents, Worker} from "bullmq";
import {REDIS_URL} from "../redis_service";
import {getLogger} from "log4js";

export interface QuestionGenerateJobDate {
    courseId: string;
    taskId: string;
    prompt: string;
}

const connection: ConnectionOptions = {
    url: REDIS_URL
};
const QuestionGenerateTaskQueue = new Queue("QuestionGenerateTaskQueue", {connection});
const QuestionGenerateTaskQueueEvents = new QueueEvents("QuestionGenerateTaskQueue", {connection});
const logger = getLogger("/utils/QuestionGenerateQueue");

const GenerateTaskQueueWorker = new Worker<QuestionGenerateJobDate>("QuestionGenerateTaskQueue", async (job) => {
    // todo
    console.log(job.data);
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

export {QuestionGenerateTaskQueue, QuestionGenerateTaskQueueEvents, shutdownQuestionGenerateTaskQueue};