import {Router} from "express";
import {getLogger} from "log4js";
import {RedisClient} from "../../../../../../../redis_service";
import {CourseRequest} from "../../../../index";
import {MarkingTaskQueue} from "../../../../../../../utils/ReplyMarkQueue";
import {DB} from "../../../../../../../sql_service";


export interface CourseQuestionReplyRequest extends CourseRequest {
    params: {
        courseId: string;
        questionId: string;
        replyId: string;
    };
}

const router = Router({mergeParams: true});
const logger = getLogger("/course/[courseId]/question/[questionId]/reply/[replyId]");


/*======middleware======*/
// Check questionId format and existence in course, if not exist return 404.
router.use(async (req: CourseQuestionReplyRequest, res, next) => {
    const {courseId, questionId, replyId} = req.params;

    // check courseId format match UUID format
    if (!replyId || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(replyId)) {
        return res.status(400).json({code: 400, message: "Invalid course ID format"});
    }

    // get form redis
    const course = await RedisClient.sIsMember(`course:${courseId}:question:${questionId}:reply`, replyId);
    if (course === 0) {
        return res.status(404).json({code: 404, message: `No reply found in question ${replyId}.`});
    }

    next();
});


/*=======router======*/
// path: /course/[courseId]/question/[questionId]/reply/[replyId]
// GET: Returns the final marking result when DONE(200).
//      If task is not finished yet, returns 202 Accepted with current status (meta).
router.get("/", async (req: CourseQuestionReplyRequest, res) => {
    const {courseId, questionId, replyId} = req.params;
    const metaKey = `course:${courseId}:question:${questionId}:reply:${replyId}:meta`;
    const resultKey = `course:${courseId}:question:${questionId}:reply:${replyId}:result`;

    // get meta
    const meta = await RedisClient.hGetAll(metaKey);
    if (!meta || !meta.status) {
        return res.status(404).json({
            code: 404,
            message: `Reply ${replyId} not found.`
        });
    }

    if (meta.status === "DONE") {
        // finish, get result
        const result = await RedisClient.json.get(resultKey);
        return res.status(200).json({
            code: 200,
            message: `Reply ${replyId} is DONE.`,
            data: {
                meta: {
                    ...meta,
                    score: parseInt(meta.score ?? ""),
                    subQuestionId: parseInt(meta.subQuestionId ?? "0")
                },
                result
            }
        });
    } else {
        // not finish, show meta
        return res.status(202).json({
            code: 202,
            message: `Reply ${replyId} is not ready yet.`,
            data: {
                meta: {
                    ...meta,
                    score: parseInt(meta.score ?? ""),
                    subQuestionId: parseInt(meta.subQuestionId ?? "0")
                }
            }
        });
    }
});

// path: /course/[courseId]/question/[questionId]/reply/[replyId]
// PATCH: retry the marking task (202)
//        If task is not finished yet, return 409 Conflict with current status (meta).
router.patch("/", async (req: CourseQuestionReplyRequest, res) => {
    const {courseId, questionId, replyId} = req.params;
    const metaKey = `course:${courseId}:question:${questionId}:reply:${replyId}:meta`;

    // get meta
    const meta = await RedisClient.hGetAll(metaKey);
    if (!meta || !meta.status) {
        return res.status(404).json({
            code: 404,
            message: `Reply ${replyId} not found.`
        });
    }

    if (["PENDING", "GENERATING"].includes(meta.status)) {
        return res.status(409).json({
            code: 409,
            message: `Reply ${replyId} is currently ${meta.status}. Cannot retry.`,
            data: {
                meta: {
                    ...meta,
                    score: parseInt(meta.score ?? ""),
                    subQuestionId: parseInt(meta.subQuestionId ?? "0")
                }
            }
        });
    }

    try {
        await DB.exec("BEGIN");
        // update database
        await DB.run(
            "UPDATE reply SET status=0, score=null, summary=null, next_step=null, understanding_level=null WHERE ID = ?",
            [replyId]);
        await DB.run("DELETE FROM reply_keypoint WHERE reply_ID = ?", [replyId]);

        // update redis
        await RedisClient.multi()
            .hSet(metaKey, {
                status: "PENDING",
                errorMessage: "",
                score: "",
                startAt: "",
                finishedAt: "",
                updateAt: new Date().toISOString()
            })
            .del(`course:${courseId}:question:${questionId}:reply:${replyId}:result`)
            .exec();
        await DB.exec("COMMIT");
    } catch (error) {
        await DB.exec("ROLLBACK");
        logger.error("SQL Error:", error);
        return res.status(500).json({code: 500, message: "Failed to retry marking."});
    }

    // Try to get the job from the queue
    const job = await MarkingTaskQueue.getJob(replyId);
    if (job) {
        if (await job.isFailed()) {
            await job.retry();
            await RedisClient.hSet(metaKey, {
                status: "PENDING",
                updateAt: new Date().toISOString()
            });
            return res.status(202).json({
                code: 202,
                message: `Reply ${replyId} marking task retrying.`,
                data: {status: "PENDING"}
            });
        }
    }

    res.status(202).json({
        code: 202,
        message: `Reply ${replyId} marking task queued for retry.`,
        data: {status: "PENDING"}
    });

    // Add a new job if it doesn't exist or isn't retriable directly
    await MarkingTaskQueue.add("MarkingTaskQueue", {
        questionId: meta.questionId,
        courseId: meta.courseId,
        subQuestionId: parseInt(meta.subQuestionId ?? "0"),
        reply: meta.content,
        replyId: meta.replyId
    }, {
        jobId: replyId,
        removeOnComplete: true,
        removeOnFail: false,
        attempts: 5,
        backoff: {
            type: "exponential",
            delay: 1000,
        }
    });
});


module.exports = router;