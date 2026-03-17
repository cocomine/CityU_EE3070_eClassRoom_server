import {Request, Router} from "express";
import {getLogger} from "log4js";

const router = Router({mergeParams: true});
const logger = getLogger('/course/[courseId]/question');

/*=======router======*/
// path: /course/[courseId]/question/[questionId]/*
router.use('/:questionId', require('./[questionId]'));

// path: /course/[courseId]/question
// GET: list question (complete generate)
router.get('/', (req: Request<{courseId: string}>, res) => {
    // todo
    console.debug(req.params.courseId);
    res.status(200).json({code: 200, message: 'This is course ' + req.params.courseId + ' question!'});
});

// path: /course/[courseId]/question
// POST: create question
router.post('/', (req: Request<{courseId: string}>, res) => {
    // todo
    console.debug(req.params.courseId);
    res.status(200).json({code: 200, message: 'This is course ' + req.params.courseId + ' question post!'});
})

module.exports = router;