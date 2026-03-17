import {Request, Router} from "express";
import {getLogger} from "log4js";

const router = Router({mergeParams: true});
const logger = getLogger("/course/[courseId]/question/[questionId]");

/*=======router======*/
// path: /course/[courseId]/question/[questionId]
// GET: get question detail, and student mark
router.get("/", (req: Request<{courseId: string, questionId: string}>, res) => {
    // todo
    console.debug(req.params.courseId, req.params.questionId);
    res.status(200).json({code: 200, message: 'This is course ' + req.params.courseId + ' question ' + req.params.questionId});
});

// path: /course/[courseId]/question/[questionId]
// PUT: update question visibility (private/public)
router.put("/", (req: Request<{courseId: string, questionId: string}>, res) => {
    // todo
    console.debug(req.params.courseId, req.params.questionId);
    res.status(200).json({code: 200, message: 'This is course ' + req.params.courseId + ' question ' + req.params.questionId + ' put!'});
});

// path: /course/[courseId]/question/[questionId]
// DEL: delete question
router.delete("/", (req: Request<{courseId: string, questionId: string}>, res) => {
    // todo
    console.debug(req.params.courseId, req.params.questionId);
    res.status(200).json({code: 200, message: 'This is course ' + req.params.courseId + ' question ' + req.params.questionId + ' delete!'});
})

module.exports = router;