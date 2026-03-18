import {Router} from "express";
import {getLogger} from "log4js";
import {CourseRequest} from "../index";
import {RedisClient} from "../../../../redis_service";
import {QuestionGenerateTaskQueue} from "../../../../utils/QuestionGenerateQueue";
import {DB} from "../../../../sql_service";

const router = Router({mergeParams: true});
const logger = getLogger("/course/[courseId]/question");

export interface PostQuestionRequest extends CourseRequest {
    body: {
        prompt?: string | null;
        clientTaskId?: string;
    } | undefined;
}

/*=======router======*/
// path: /course/[courseId]/question/[questionId]/*
router.use("/:questionId", require("./[questionId]"));

// path: /course/[courseId]/question
// GET: list question (complete generate)
router.get("/", (req: CourseRequest, res) => {
    // todo
    console.debug(req.params.courseId);
    res.status(200).json({code: 200, message: "This is course " + req.params.courseId + " question!"});
});

// path: /course/[courseId]/question
// POST: create question
router.post("/", async (req: PostQuestionRequest, res) => {
    const courseId = req.params.courseId;
    const prompt = req.body?.prompt || null;
    const clientTaskId = req.body?.clientTaskId;

    // Check clientTaskId
    if (!clientTaskId) {
        return res.status(400).json({code: 400, message: "Client task id is required"});
    }

    // check clientTaskId format match UUID format
    if (!clientTaskId || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(clientTaskId)) {
        return res.status(400).json({code: 400, message: "clientTaskId must use UUID format"});
    }

    // Idempotency
    const idem = await RedisClient.get("idem:task:" + clientTaskId);
    if (idem) {
        // already have task
        return res.json({
            code: 200,
            message: "Request already receive", data: {
                taskId: idem,
                questionId: idem,
                statusStreamUrl: `/task/${idem}/stream`,
                resultUrl: `/task/${idem}/result`,
            }
        });
    }

    const taskId = crypto.randomUUID();

    // new task
    await RedisClient.set("idem:task:" + clientTaskId, taskId, {EX: 86400, NX: true}); //set for Idempotency
    const title = prompt ? prompt.slice(0, 100) : "New Question (" + taskId.slice(0, 8) + ")";

    // save meta
    await RedisClient.hSet("task:" + taskId + ":meta", {
        courseId,
        title,
        questionId: taskId,
        status: "PENDING",
        createAt: Date.now(),
        startAt: NaN,
        finishedAt: NaN,
        errorMessage: ""
    });
    await RedisClient.set("course:" + courseId + ":activeTask", taskId); //save activeTask ID

    // save database
    try {
        const stmt = await DB.prepare(`INSERT INTO questions (id, title)
                                       VALUES (?, ?)`);
        await stmt.bind(taskId, title);
        await stmt.run();
    } catch (err) {
        logger.error(err);
        return res.status(500).json({code: 500, message: "Failed to create question."});
    }

    // Immediately response to client
    res.json({
        code: 200,
        message: "Question generate request enqueued.",
        data: {
            taskId,
            title,
            questionId: taskId,
            status: "PENDING",
            statusStreamUrl: `/task/${taskId}/stream`,
            resultUrl: `/task/${taskId}/result`,
        }
    });

    // Enqueue Job
    await QuestionGenerateTaskQueue.add("QuestionGenerateTask", {taskId, courseId, prompt});
});

module.exports = router;