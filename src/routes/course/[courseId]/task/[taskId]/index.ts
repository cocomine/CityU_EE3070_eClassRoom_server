import {Request, Router} from "express";
import {getLogger} from "log4js";

const router = Router({mergeParams: true});
const logger = getLogger("/course/[courseId]/task/[taskId]");

/*=======router======*/
// path: /course/[courseId]/task/[taskId]
// GET: get task meta (status)
router.get("/", (req: Request<{ courseId: string, taskId: string }>, res) => {
    // todo
    console.debug(req.params.courseId, req.params.taskId);
    res.status(200).json({code: 200, message: `This is course ${req.params.courseId} task ${req.params.taskId}!`});
});

// path: /course/[courseId]/task/[taskId]/result
// GET: Returns the final question when DONE.
//      If task is not finished yet, returns 202 Accepted with current status.
router.get("/result", (req: Request<{ courseId: string, taskId: string }>, res) => {
    // todo
    console.debug(req.params.courseId, req.params.taskId);
    res.status(200).json({
        code: 200,
        message: `This is course ${req.params.courseId} task ${req.params.taskId} result!`
    });
});

// path: /course/[courseId]/task/[taskId]/stream/cancel
// POST: Requests cancellation. Server sets a cancel flag;
//       worker should stop if possible, or discard result and mark CANCELLED.
router.post("/cancel", (req: Request<{ courseId: string, taskId: string }>, res) => {
    // todo
    console.debug(req.params.courseId, req.params.taskId);
    res.status(200).json({code: 200, message: `Cancellation requested for course ${req.params.courseId} task ${req.params.taskId}!`});
})

// path: /course/[courseId]/task/[taskId]/stream
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
 */
router.get("/stream", (req: Request<{ courseId: string, taskId: string }>, res) => {
    // todo
    console.debug(req.params.courseId, req.params.taskId);
    res.status(200).json({})
})

module.exports = router;