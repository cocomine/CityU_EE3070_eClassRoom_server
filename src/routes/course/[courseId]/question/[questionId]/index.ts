import {Router} from "express";
import {getLogger} from "log4js";
import {CourseRequest} from "../../index";
import {RedisClient} from "../../../../../redis_service";

const router = Router({mergeParams: true});
const logger = getLogger("/course/[courseId]/question/[questionId]");

interface CourseQuestionRequest extends CourseRequest {
    params: {
        courseId: string;
        questionId: string;
    };
}

/*=======router======*/
// path: /course/[courseId]/question/[questionId]
// GET: Returns the final question when DONE & return student mark (200).
//      If task is not finished yet, returns 202 Accepted with current status (meta).
router.get("/", (req: CourseQuestionRequest, res) => {
    // todo
    console.debug(req.params.courseId, req.params.questionId);
    res.status(200).json({
        code: 200,
        message: "This is course " + req.params.courseId + " question " + req.params.questionId
    });
});

// path: /course/[courseId]/question/[questionId]
// PUT: update question visibility (private/public) return 200
//      If task is not finished yet, return 409 Conflict with current status (meta).
router.put("/", (req: CourseQuestionRequest, res) => {
    // todo
    console.debug(req.params.courseId, req.params.questionId);
    res.status(200).json({
        code: 200,
        message: "This is course " + req.params.courseId + " question " + req.params.questionId + " put!"
    });
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
router.post("/cancel", (req: CourseQuestionRequest, res) => {
    // todo
    console.debug(req.params.courseId, req.params.questionId);
    res.status(200).json({
        code: 200,
        message: `Cancellation requested for course ${req.params.courseId} task ${req.params.questionId}!`
    });
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
 * If status is DONE/ERROR/CANCELLED/STALE, return 410
 */
router.get("/stream", async (req: CourseQuestionRequest, res) => {
    const {courseId, questionId} = req.params;
    const metaKey = `course:${courseId}:question:${questionId}:meta`;
    const hbKey = `course:${courseId}:question:${questionId}:heartbeat`;
    const channel = `course:${courseId}:question:${questionId}:status`;

    // push status to client
    const send = (status: string) => {
        res.write(`event: status\n`);
        res.write(`data: ${JSON.stringify({questionId, status})}\n\n`);
    };

    // immediate send current status
    const terminal = new Set(["DONE", "ERROR", "CANCELLED", "STALE"]);
    const current = (await RedisClient.hGet(metaKey, "status")) ?? "PENDING";
    if (terminal.has(current)) {
        return res.status(410).json({
            code: 410,
            message: `Question ${questionId} is already ${current}.`
        });
    }

    // check heartbeat, if no heartbeat, consider it STALE
    const hb = await RedisClient.exists(hbKey);
    if (!hb) {
        await RedisClient.hSet(metaKey, {
            status: "STALE",
            updatedAt: new Date().toISOString()
        });
        return res.status(410).json({
            code: 410,
            message: `Question ${questionId} is STALE now.`
        });
    }

    // Send header
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    send(current);

    // pub/sub client
    const sub = RedisClient.duplicate();
    await sub.connect();

    // keepAlive
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 3000);

    // close connect
    const cleanup = async () => {
        clearInterval(keepAlive);
        try {
            await sub.unsubscribe(channel);
        } catch {
        }
        try {
            await sub.quit();
        } catch {
        }
        if (!res.writableEnded) res.end();
    };

    // subscribe channel
    await sub.subscribe(channel, async (msg) => {
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