import {Router} from "express";
import {getLogger} from "log4js";
import {RedisClient} from "../../../../../redis_service";
import {CourseQuestionRequest} from "./index";
import {QuestionGenerateTaskQueue} from "../../../../../utils/QuestionGenerateQueue";
import {DB} from "../../../../../sql_service";

const router = Router({mergeParams: true});
const logger = getLogger("/course/[courseId]/question/cancel");

// path: /course/[courseId]/question/[questionId]/cancel
// POST: Requests cancellation. Server sets a cancel flag return 202;
//       worker should stop if possible, or discard result and mark CANCELLED.
//       If task is already DONE/ERROR/CANCELLED/STALE, return 410.
router.post("/", async (req: CourseQuestionRequest, res) => {
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


module.exports = router;