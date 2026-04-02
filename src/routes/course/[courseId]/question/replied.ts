import {RequestHandler, Router} from "express";
import {getLogger} from "log4js";
import {CourseRequest} from "../index";
import {RedisClient} from "../../../../redis_service";


const router = Router({mergeParams: true});
const logger = getLogger("/course/[courseId]/question/replied");


/*======middleware======*/
// Check EID format in header, if not exist or invalid format return 400.
export const eidHeaderCheck: RequestHandler = (req, res, next) => {
    const eid = req.header("X-EID");

    if (!eid || !/^[0-9a-zA-Z]+$/.test(eid)) {
        return res.status(400).json({code: 400, message: "Invalid EID format"});
    }

    next();
};


// path: /course/[courseId]/question/replied
// GET: list replies submitted by a specific student (via X-EID header)
router.get("/", eidHeaderCheck, async (req: CourseRequest, res) => {
    const {courseId} = req.params;
    const eid = req.header("X-EID") as string;
    const studentReplyKey = `course:${courseId}:student:${eid}:reply`;

    // get all question IDs answered by this student
    const answeredQuestionIds = await RedisClient.sMembers(studentReplyKey);

    // Check if empty
    if (!answeredQuestionIds || answeredQuestionIds.length === 0) {
        return res.json({code: 200, message: "No questions answered."});
    }

    const metaList = [];

    // Map over the IDs to fetch their reply metadata
    for (let qId of answeredQuestionIds) {
        const replyKey = `course:${courseId}:question:${qId}:reply`;
        const replyIds = await RedisClient.sMembers(replyKey);

        // Map over reply IDs to fetch their metadata
        let highestScoreMeta: any = null;
        for (let replyId of replyIds) {
            const metaKey = `course:${courseId}:question:${qId}:reply:${replyId}:meta`;
            const meta = await RedisClient.hGetAll(metaKey);

            // Only include metadata if it belongs to the current student (eid)
            if (Object.keys(meta).length > 0 && meta.eid === eid) {
                const currentScore = parseInt(meta.score || "");
                const currentMeta = {
                    ...meta,
                    score: isNaN(currentScore) ? null : currentScore,
                    subQuestionId: parseInt(meta.subQuestionId || "0")
                };

                // Track the highest scoring reply matching this question
                if (!highestScoreMeta) {
                    highestScoreMeta = currentMeta; // first one encountered
                } else {
                    // compare current meta score with the highest score found so far
                    const highestScore = highestScoreMeta.score ?? -1;
                    const thisScore = currentMeta.score ?? -1;

                    if (thisScore > highestScore) {
                        highestScoreMeta = currentMeta;
                    }
                }
            }
        }

        // Only include the highest scoring reply metadata for this question
        if (highestScoreMeta) {
            metaList.push(highestScoreMeta);
        }
    }

    res.json({
        code: 200,
        message: "Answered questions fetched successfully.",
        data: metaList
    });
});


module.exports = router;
