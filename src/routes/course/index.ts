import {Router} from "express";
import {getLogger} from "log4js";

const router = Router();
const logger = getLogger('/course');

/*=======router======*/
// path: /course/[courseId]/*
router.use('/:courseId', require('./[courseId]'));
logger.info('Loaded /course/[courseId]');

// path: /course
// GET: list course
router.get('/', (req, res) => {
    // todo
    res.json({code: 200, message: 'This is course list!'});
});

// path: /course
// POST: create course
router.post('/', (req, res) => {
    // todo
    res.status(200).json({code: 200, message: 'This is course post!'});
})


module.exports = router;