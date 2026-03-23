import {Router} from "express";
import {getLogger} from "log4js";
import {CourseRequest} from "../index";
import {RedisClient} from "../../../../redis_service";
import {DB} from "../../../../sql_service";

const router = Router({mergeParams: true});
const logger = getLogger("/course/[courseId]/file");

export interface CourseFileRequest extends CourseRequest {
    params: {
        fileId: string;
        courseId: string;
    };
}

/*======middleware======*/
router.use(async (req: CourseFileRequest, res, next) => {
    const {courseId, fileId} = req.params;

    // check courseId format match UUID format
    if (!fileId || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(fileId)) {
        return res.status(400).json({code: 400, message: "Invalid course ID format"});
    }

    // get form redis
    const course = await RedisClient.sIsMember(`course:${courseId}:file`, fileId);
    if (course === 0) {
        return res.status(404).json({code: 404, message: `No files found in course ${courseId}.`});
    }

    next();
});

/*=======router======*/
// path: /course/[courseId]/file/[fileId]
// DELETE: delete file
router.delete("/", async (req: CourseFileRequest, res) => {
    const {courseId, fileId} = req.params;
    const filesKey = `course:${courseId}:file`;
    const metaKey = `course:${courseId}:file:${fileId}:meta`;

    try {
        await DB.exec("BEGIN");
        // delete database
        const deleteResult = await DB.run("DELETE FROM files WHERE ID = ?;", [fileId]);
        if ((deleteResult.changes ?? 0) === 0) {
            return res.status(404).json({
                code: 404,
                message: `File ${fileId} not found in database.`
            });
        }

        // remove file blob from database when no more record point


        // delete redis
        await RedisClient.multi()
            .del(metaKey)
            .sRem(filesKey, fileId)
            .exec();
        await DB.exec("COMMIT");
    } catch (e) {
        await DB.exec("ROLLBACK");
        logger.error(e);
        return res.status(500).json({
            code: 500,
            message: `Failed to delete file ${fileId}.`
        });
    }

    res.json({code: 200, message: `File ${fileId} is deleted.`});
    logger.warn(`File ${fileId} in course ${courseId} is deleted.`);
});


module.exports = router;