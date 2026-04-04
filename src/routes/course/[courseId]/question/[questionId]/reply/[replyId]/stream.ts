import {Router} from "express";
import {getLogger} from "log4js";
import {CourseQuestionReplyRequest} from "./index";
import {RedisClient} from "../../../../../../../redis_service";
import {SET_STATUS_LUA_SCRIPT} from "../../../../../../../utils/LuaScript";

const router = Router({mergeParams: true});
const logger = getLogger("/course/[courseId]/question/[questionId]/reply/[replyId]/stream");

// path: /course/[courseId]/question/[questionId]/reply/[replyId]/stream
/**
 * GET: SSE stream that emits ONLY status updates (no tokens/content).
 * On connect, server should immediately emit the current status, then future changes.
 * Recommended events:
 *
 * @code
 *   event: status,
 *   data: {
 *     "replyId":"...",
 *     "status":"PENDING|MARKING|DONE|ERROR|CANCELLED|STALE",
 *     "resultUrl": "...optional..."
 *   }
 *
 * After DONE/ERROR/CANCELLED/STALE, server may close the stream.
 * If status is DONE/ERROR/CANCELLED/STALE
 */
router.get("/", async (req: CourseQuestionReplyRequest, res) => {
    const {courseId, questionId, replyId} = req.params;
    const metaKey = `course:${courseId}:question:${questionId}:reply:${replyId}:meta`;
    const hbKey = `course:${courseId}:question:${questionId}:reply:${replyId}:heartbeat`;
    const channelKey = `course:${courseId}:question:${questionId}:reply:${replyId}:status`;
    const resultKey = `course:${courseId}:question:${questionId}:reply:${replyId}:result`;
    logger.info(`Client connected to reply ${replyId} status stream`);

    // push status to client
    const send = (status: string) => {
        res.write(`event: status\n`);
        res.write(`data: ${JSON.stringify({replyId, status})}\n\n`);
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

    // if status = DONE, send result
    if (current === "DONE") {
        const result = await RedisClient.json.get(resultKey, {path: "$"});
        res.write(`event: delta\n`);
        res.write(`data: ${JSON.stringify(result)}\n\n`);
    }
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
                updateAt: new Date().toISOString()
            })
            .exec();

        send("STALE");
        return res.end();
    }

    // pub/sub client
    const sub = RedisClient.duplicate();
    await sub.connect();

    // keepAlive
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 5000);

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
            const data = JSON.parse(msg);
            status = data.status ?? status;

            // if done send score
            if (status === "DONE" && data.result) {
                res.write(`event: delta\n`);
                res.write(`data: ${JSON.stringify(data.result)}\n\n`);
            }
        } catch {
        }
        send(status);
        if (terminal.has(status)) await cleanup();
    });
});


module.exports = router;