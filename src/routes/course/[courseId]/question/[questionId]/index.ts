import {Router} from "express";
import {getLogger} from "log4js";
import {CourseRequest} from "../../index";
import {RedisClient} from "../../../../../redis_service";
import {SET_STATUS_LUA_SCRIPT} from "../../../../../utils/LuaScript";
import {QuestionGenerateTaskQueue} from "../../../../../utils/QuestionGenerateQueue";
import {DB} from "../../../../../sql_service";

const router = Router({mergeParams: true});
const logger = getLogger("/course/[courseId]/question/[questionId]");

interface CourseQuestionRequest extends CourseRequest {
    params: {
        courseId: string;
        questionId: string;
    };
}

interface PutCourseQuestionRequest extends CourseQuestionRequest {
    body: {
        visibility?: "public" | "private";
    };
}

/*======middleware======*/
router.use(async (req: CourseQuestionRequest, res, next) => {
    const {courseId, questionId} = req.params;

    // check courseId format match UUID format
    if (!questionId || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(questionId)) {
        return res.status(400).json({code: 400, message: "Invalid course ID format"});
    }

    // get form redis
    const course = await RedisClient.sIsMember("course:" + courseId + ":question", questionId);
    if (course === 0) {
        return res.status(404).json({code: 404, message: `No question found in course ${courseId}.`});
    }

    next();
});


/*=======router======*/
// path: /course/[courseId]/question/[questionId]
// GET: Returns the final question when DONE & return student mark (200).
//      If task is not finished yet, returns 202 Accepted with current status (meta).
router.get("/", async (req: CourseQuestionRequest, res) => {
    const {courseId, questionId} = req.params;
    const metaKey = `course:${courseId}:question:${questionId}:meta`;
    const resultKey = `course:${courseId}:question:${questionId}:result`;

    // get meta
    const meta = await RedisClient.hGetAll(metaKey);
    if (!meta || !meta.status) {
        return res.status(404).json({
            code: 404,
            message: `Question ${questionId} not found in course ${courseId}.`
        });
    }

    if (meta.status === "DONE") {
        // finish, get result
        const result = await RedisClient.json.get(resultKey);
        return res.status(200).json({
            code: 200,
            message: `Question ${questionId} is DONE.`,
            data: {
                meta,
                question: result,
                mark: null //TODO: student mark
            }
        });
    } else {
        // not finish, show meta
        return res.status(202).json({
            code: 202,
            message: `Question ${questionId} is not ready yet.`,
            data: {
                meta
            }
        });
    }
});

// path: /course/[courseId]/question/[questionId]
// PUT: update question visibility (private/public) return 200
//      If task is not DONE yet, return 409 Conflict with current status (meta).
router.put("/", async (req: PutCourseQuestionRequest, res) => {
    const {courseId, questionId} = req.params;
    const {visibility} = req.body;
    const metaKey = `course:${courseId}:question:${questionId}:meta`;

    // verify
    if (!visibility) {
        return res.status(400).json({code: 400, message: "Missing visibility field."});
    }

    // check status
    const status = await RedisClient.hGet(metaKey, "status");
    if (!status) {
        return res.status(404).json({
            code: 404,
            message: `Question ${questionId} not found in course ${courseId}.`
        });
    }
    if (status !== "DONE") {
        return res.status(200).json({
            code: 410,
            message: `Question ${questionId} is ${status}.`,
            data: {
                status
            }
        });
    }

    if (visibility === "public") {
        // make public
        await RedisClient.hSet(metaKey, {visibility});
        res.json({code: 200, message: `Question ${questionId} is Public.`, data: {visibility}});

        try {
            await DB.run("UPDATE questions SET visibility = 1 WHERE ID = ? AND visibility = 0;", [questionId]);
        } catch (error) {
            logger.error(error);
        }
        return;
    } else if (visibility === "private") {
        // make private
        await RedisClient.hSet(metaKey, {visibility});
        res.json({code: 200, message: `Question ${questionId} is Public.`, data: {visibility}});

        try {
            await DB.run("UPDATE questions SET visibility = 0 WHERE ID = ? AND visibility = 1;", [questionId]);
        } catch (error) {
            logger.error(error);
        }
        return;
    } else {
        res.status(400).json({code: 400, message: "Invalid visibility field."});
    }
});

// path: /course/[courseId]/question/[questionId]
// DEL: delete question return 204.
//      If task is not finished yet, return 409 Conflict with current status (meta).
router.delete("/", (req: CourseQuestionRequest, res) => {
    // todo
    console.debug(req.params.courseId, req.params.questionId);
    res.status(200).json({
        code: 200,
        message: "This is course " + req.params.courseId + " question " + req.params.questionId + " delete!"
    });
});

// path: /course/[courseId]/question/[questionId]/cancel
// POST: Requests cancellation. Server sets a cancel flag return 202;
//       worker should stop if possible, or discard result and mark CANCELLED.
//       If task is already DONE/ERROR/CANCELLED/STALE, return 410.
router.post("/cancel", async (req: CourseQuestionRequest, res) => {
    const {courseId, questionId} = req.params;
    const metaKey = `course:${courseId}:question:${questionId}:meta`;
    const cancelKey = `course:${courseId}:question:${questionId}:cancel`;
    const channelKey = `course:${courseId}:question:${questionId}:status`;

    // set cancel flag
    const status = await RedisClient.hGet(metaKey, "status");
    if (!status) {
        return res.status(404).json({
            code: 404,
            message: `Question ${questionId} not found in course ${courseId}.`
        });
    }

    if (["DONE", "ERROR", "CANCELLED", "STALE"].includes(status)) {
        return res.status(200).json({
            code: 410,
            message: `Question ${questionId} is already ${status}.`,
            data: {
                status
            }
        });
    }

    await RedisClient.multi()
        .set(cancelKey, 1, {EX: 3600})
        .hSet(metaKey, "status", "CANCELLED")
        .publish(channelKey, JSON.stringify({status: "CANCELLED"}))
        .exec();

    // Immediate response
    res.status(202).json({
        code: 202,
        message: `Cancellation requested for question ${questionId}.`,
        data: {
            status: "CANCELLED"
        }
    });

    // set database
    try {
        await DB.run("UPDATE questions SET status = 3 WHERE ID = ?", [questionId]);
    } catch (err) {
        logger.error(err);
    }

    // try to remove job
    const job = await QuestionGenerateTaskQueue.getJob(questionId);
    await job?.remove();
});

// path: /course/[courseId]/question/[questionId]/stream
/**
 * GET: SSE stream that emits ONLY status updates (no tokens/content).
 * On connect, server should immediately emit the current status, then future changes.
 * Recommended events:
 *
 * @code
 *   event: status,
 *   data: {
 *     "questionId":"...",
 *     "status":"PENDING|GENERATING|DONE|ERROR|CANCELLED|STALE",
 *     "resultUrl": "...optional..."
 *   }
 *
 * After DONE/ERROR/CANCELLED/STALE, server may close the stream.
 * If status is DONE/ERROR/CANCELLED/STALE
 */
router.get("/stream", async (req: CourseQuestionRequest, res) => {
    const {courseId, questionId} = req.params;
    const metaKey = `course:${courseId}:question:${questionId}:meta`;
    const hbKey = `course:${courseId}:question:${questionId}:heartbeat`;
    const channelKey = `course:${courseId}:question:${questionId}:status`;

    // push status to client
    const send = (status: string) => {
        res.write(`event: status\n`);
        res.write(`data: ${JSON.stringify({questionId, status})}\n\n`);
    };

    // Send header
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    // immediate send current status
    const terminal = new Set(["DONE", "ERROR", "CANCELLED", "STALE"]);
    const current = (await RedisClient.hGet(metaKey, "status")) ?? "PENDING";
    send(current);

    // If status is DONE/ERROR/CANCELLED/STALE
    if (terminal.has(current)) {
        return res.end();
    }

    // check heartbeat, if no heartbeat, consider it STALE
    const hb = await RedisClient.exists(hbKey);
    if (!hb && current === "GENERATING") {
        await RedisClient.multi()
            .eval(SET_STATUS_LUA_SCRIPT, {
                keys: [metaKey],
                arguments: ["GENERATING", "STALE"]
            })
            .hSet(metaKey, {
                updatedAt: new Date().toISOString()
            })
            .exec();

        send("STALE");
        return res.end();
    }

    // pub/sub client
    const sub = RedisClient.duplicate();
    await sub.connect();

    // keepAlive
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 3000);

    // close connect
    const cleanup = async () => {
        clearInterval(keepAlive);
        try {
            await sub.unsubscribe(channelKey);
        } catch {
        }
        try {
            await sub.quit();
        } catch {
        }
        if (!res.writableEnded) res.end();
    };

    // subscribe channel
    await sub.subscribe(channelKey, async (msg) => {
        let status = "PENDING";
        try {
            status = JSON.parse(msg).status ?? status;
        } catch {
        }
        send(status);
        if (terminal.has(status)) await cleanup();
    });
});

module.exports = router;