import {Router} from "express";
import {getLogger} from "log4js";
import {CourseRequest} from "../index";
import {RedisClient} from "../../../../redis_service";
import {QuestionGenerateTaskQueue} from "../../../../utils/QuestionGenerateQueue";
import {DB} from "../../../../sql_service";
import {SET_IDEM_LUA_SCRIPT} from "../../../../utils/LuaScript";
import xss from "xss";

const router = Router({mergeParams: true});
const logger = getLogger("/course/[courseId]/question");

export interface PostQuestionRequest extends CourseRequest {
    body: {
        prompt?: string | null | any;
        clientTaskId?: string | any;
    }
}

export interface GetQuestionRequestQuery {
    visibility?: "0" | "1" | string;
    status?: "PENDING" | "GENERATING" | "DONE" | "ERROR" | "CANCELLED" | "STALE" | string;
}

/*=======router======*/

// path: /course/[courseId]/question
// GET: list question
router.get("/", async (req: CourseRequest, res) => {
    const {courseId} = req.params;
    const query: GetQuestionRequestQuery = req.query;
    const questionKey = `course:${courseId}:question`;
    const metaList = [];

    // check exists
    if (await RedisClient.exists(questionKey) === 0) {
        return res.status(404).json({code: 404, message: `No any question found in course ${courseId}.`});
    }

    // get all question meta
    const questionIdList = await RedisClient.sMembers(questionKey);
    for (let questionId of questionIdList) {
        const metaKey = `course:${courseId}:question:${questionId}:meta`;
        const meta = await RedisClient.hGetAll(metaKey);

        if (Object.keys(meta).length === 0) continue;

        // filter
        if (query.status) {
            const t = query.status.split(":");
            if (!t.includes(meta.status ?? "")) continue;
        }
        if (query.visibility && meta.visibility !== query.visibility) continue;

        metaList.push({...meta, visibility: parseInt(meta.visibility ?? "0")});
    }

    res.json({code: 200, message: "All question meta get successfully.", data: metaList});
});

// path: /course/[courseId]/question
// POST: create question
router.post("/", async (req: PostQuestionRequest, res) => {
    const courseId = req.params.courseId;
    const prompt = xss(req.body.prompt || "").trim();
    const clientTaskId = req.body.clientTaskId;
    const questionKey = `course:${courseId}:question`;

    // Check clientTaskId
    if (!clientTaskId) {
        return res.status(400).json({code: 400, message: "Client task id is required"});
    }

    // check clientTaskId format match UUID format
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(clientTaskId)) {
        return res.status(400).json({code: 400, message: "clientTaskId must use UUID format"});
    }

    // Key
    const questionId = crypto.randomUUID();
    const metaKey = `course:${courseId}:question:${questionId}:meta`;

    // Idempotency
    const idemKey = `idem:question:${clientTaskId}`;
    const idem = await RedisClient.eval(SET_IDEM_LUA_SCRIPT, {
        keys: [idemKey],
        arguments: [questionId]
    });
    if (idem) {
        // already have task
        return res.status(202).json({
            code: 202,
            message: "Request already receive", data: {
                questionId: idem
            }
        });
    }

    // new task
    const title = prompt !== "" ? prompt.slice(0, 100) : "New Question (" + questionId.slice(0, 8) + ")";

    try {
        await DB.exec("BEGIN");
        // save database
        const stmt = await DB.prepare(
            `INSERT INTO questions (id, courseID, title, prompt)
             VALUES (?, ?, ?, ?)`);
        await stmt.bind(questionId, courseId, title, prompt);
        await stmt.run();

        // save meta
        await RedisClient.multi()
            .hSet(metaKey, {
                courseId,
                title,
                prompt,
                questionId,
                status: "PENDING",
                visibility: 0, // default private
                createAt: new Date().toISOString(),
                startAt: "",
                finishedAt: "",
                errorMessage: "",
                updateAt: new Date().toISOString()
            })
            .sAdd(questionKey, questionId)
            .exec();
        await DB.exec("COMMIT");
    } catch (err) {
        await DB.exec("ROLLBACK");
        logger.error(err);
        return res.status(500).json({code: 500, message: "Failed to create question."});
    }

    // Immediately response to client
    res.status(201).json({
        code: 201,
        message: "Question generate request enqueued.",
        data: {
            questionId,
            title,
            status: "PENDING",
        }
    });

    // Enqueue Job
    await QuestionGenerateTaskQueue.add("QuestionGenerateTask", {questionId, courseId, prompt}, {
        jobId: questionId,
        removeOnComplete: true,
        removeOnFail: true,
        attempts: 5,
        backoff: {
            type: "exponential",
            delay: 1000,
        }
    });
});

// path: /course/[courseId]/question/[questionId]/*
router.use("/:questionId", require("./[questionId]"));
logger.info("Loaded /course/[courseId]/question/[questionId]");


module.exports = router;