import {Router} from "express";
import {getLogger} from "log4js";
import {CourseRequest} from "../index";

const router = Router({mergeParams: true});
const logger = getLogger("/course/[courseId]/file");

export interface CourseFileRequest extends CourseRequest {
    params: {
        fileId: string;
        courseId: string;
    };
}

/*=======router======*/
// path: /course/[courseId]/file/[fileId]
// DELETE: delete file
router.delete("/", async (req: CourseFileRequest, res) => {
    // todo
});


module.exports = router;