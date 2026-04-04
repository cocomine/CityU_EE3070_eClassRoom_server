import {Router} from "express";
import {getLogger} from "log4js";
import {RedisClient} from "../../../../../../../redis_service";
import {CourseRequest} from "../../../../index";


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
// PATCH: retry the marking task (200)
//        If task is not finished yet, return 409 Conflict with current status (meta).
router.patch("/", async (req: CourseQuestionReplyRequest, res) => {
    //todo
});


module.exports = router;