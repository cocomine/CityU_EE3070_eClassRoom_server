import {ErrorRequestHandler, Response, Router} from "express";
import {getLogger} from "log4js";
import {CourseRequest} from "../index";
import multer from "multer";

const router = Router({mergeParams: true});
const logger = getLogger("/course/[courseId]/file");
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10485760, // 10MB
        files: 1,
        headerPairs: 1,
        parts: 3
    },
    fileFilter: (req, file, cb) => {
        // reject: audio, video
        if (file.mimetype.includes("video/")) {
            cb(new Error("Does not support video!"));
        } else if (file.mimetype.includes("audio/")) {
            cb(new Error("Does not support audio!"));
        } else {
            cb(null, true);
        }
    },
    defParamCharset: "utf8",
});

/**
 * Error Handler for Multer
 */
const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
    if (res.headersSent) {
        return next(err);
    }
    logger.error(err);

    // MulterError
    if (err instanceof multer.MulterError) {
        return res.status(400).json({code: 400, message: err.message});
    }

    res.status(500).json({code: 500, message: err.message});
};

/*=======router======*/
// path: /course/[courseId]/file/
// GET: list all uploaded files
router.get("/", async (req: CourseRequest, res) => {
    //todo
});

// path: /course/[courseId]/file/
// POST: upload file
router.post("/", [upload.single("file"), errorHandler], async (req: CourseRequest, res: Response) => {
    if (req.header("content-type")?.includes("multipart/form-data") === false) {
        return res.status(400).json({code: 400, message: "Content-Type must be multipart/form-data"});
    }
    if (!req.file) {
        return res.status(400).json({code: 400, message: "No file uploaded"});
    }

    //todo: save database
    res.status(200).json([req.file.size, req.file.filename, req.file.mimetype]);
});

// path: /course/[courseId]/file/[fileId]/*
router.use("/:fileId", require("./[fileId]"));
logger.info("Loaded /course/[courseId]/file/[fileId]");


module.exports = router;