import {Request, Router} from "express";
import {getLogger} from "log4js";

const router = Router({mergeParams: true});
const logger = getLogger("/course/[courseId]/question/[questionId]");

/*=======router======*/
// path: /course/[courseId]/question/[questionId]
// GET: Returns the final question when DONE & return student mark (200).
//      If task is not finished yet, returns 202 Accepted with current status (meta).
router.get("/", (req: Request<{courseId: string, questionId: string}>, res) => {
    // todo
    console.debug(req.params.courseId, req.params.questionId);
    res.status(200).json({code: 200, message: 'This is course ' + req.params.courseId + ' question ' + req.params.questionId});
});

// path: /course/[courseId]/question/[questionId]
// PUT: update question visibility (private/public) return 200
//      If task is not finished yet, return 409 Conflict with current status (meta).
router.put("/", (req: Request<{courseId: string, questionId: string}>, res) => {
    // todo
    console.debug(req.params.courseId, req.params.questionId);
    res.status(200).json({code: 200, message: 'This is course ' + req.params.courseId + ' question ' + req.params.questionId + ' put!'});
});

// path: /course/[courseId]/question/[questionId]
// DEL: delete question return 204.
//      If task is not finished yet, return 409 Conflict with current status (meta).
router.delete("/", (req: Request<{courseId: string, questionId: string}>, res) => {
    // todo
    console.debug(req.params.courseId, req.params.questionId);
    res.status(200).json({code: 200, message: 'This is course ' + req.params.courseId + ' question ' + req.params.questionId + ' delete!'});
})

// path: /course/[courseId]/question/[questionId]/cancel
// POST: Requests cancellation. Server sets a cancel flag return 202;
//       worker should stop if possible, or discard result and mark CANCELLED.
router.post("/cancel", (req: Request<{ courseId: string, taskId: string }>, res) => {
    // todo
    console.debug(req.params.courseId, req.params.taskId);
    res.status(200).json({
        code: 200,
        message: `Cancellation requested for course ${req.params.courseId} task ${req.params.taskId}!`
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
 *     "taskId":"...",
 *     "status":"PENDING|GENERATING|DONE|ERROR|CANCELLED|STALE",
 *     "resultUrl": "...optional..."
 *   }
 *
 * After DONE/ERROR/CANCELLED, server may close the stream.
 * If status is DONE/ERROR/CANCELLED, return 410
 */
router.get("/stream", (req: Request<{ courseId: string, taskId: string }>, res) => {
    // todo
    console.debug(req.params.courseId, req.params.taskId);
    res.status(200).json({});
});

module.exports = router;