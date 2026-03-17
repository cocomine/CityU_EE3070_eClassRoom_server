import {Request, Response, Router} from "express";
import {getLogger} from "log4js";

const router = Router({mergeParams: true});
const logger = getLogger('/course/[courseId]');

/*=======router======*/
// path: /course/[courseId]/question/*
router.use('/question', require('./question'));
logger.info('Loaded /course/[courseId]/question');

// path: //course/[courseId]/task/*
router.use('/task', require('./task'));
logger.info('Loaded /course/[courseId]/task');

// path: /course/[courseId]
// GET: Get course info
router.get('/', (req: Request<{courseId: string}>, res) => {
    console.debug(req.params.courseId);
    res.status(200).json({code: 200, message: `This is course ${req.params.courseId} info!`});
    // todo
});

module.exports = router;
