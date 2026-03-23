import {ErrorRequestHandler, Response, Router} from "express";
import {getLogger} from "log4js";
import {CourseRequest} from "../index";
import multer from "multer";
import {fileTypeFromBuffer} from "file-type";
import {DB} from "../../../../sql_service";
import {createHash} from "node:crypto";
import xss from "xss";

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
    const {courseId} = req.params;

    if (req.header("content-type")?.includes("multipart/form-data") === false) {
        return res.status(400).json({code: 400, message: "Content-Type must be multipart/form-data"});
    }

    const file = req.file;
    if (!file) {
        return res.status(400).json({code: 400, message: "No file uploaded"});
    }

    const trueMimeType = await fileTypeFromBuffer(file.buffer);
    if (trueMimeType) {
        if (trueMimeType.mime.includes("video/")) {
            return res.status(400).json({code: 400, message: "Does not support video!"});
        } else if (trueMimeType.mime.includes("audio/")) {
            return res.status(400).json({code: 400, message: "Does not support audio!"});
        }
    }

    // save database
    const sha256 = createHash("sha256").update(file.buffer).digest("hex");
    const fileId = crypto.randomUUID();
    await DB.exec("BEGIN");
    try {
        await DB.run("INSERT OR IGNORE INTO file_blob (sha256, blob, size, mime) VALUES (?, ?, ?, ?)", [sha256, file.buffer, file.size, trueMimeType?.mime ?? file.mimetype ?? "application/octet-stream"]);
        await DB.run("INSERT INTO files (ID, course_id, filename, sha256) VALUES (?, ?, ?, ?)", [fileId, courseId, xss(file.originalname), sha256]);
        await DB.exec("COMMIT");
    } catch (err) {
        await DB.exec("ROLLBACK");
        logger.error(err);

        return res.status(500).json({code: 500, message: "Failed to save file to database"});
    }

    res.status(200).json({
        code: 200,
        message: "File uploaded successfully",
        data: {fileId, mime: trueMimeType?.mime ?? file.mimetype ?? "application/octet-stream"}
    });
});

// path: /course/[courseId]/file/[fileId]/*
router.use("/:fileId", require("./[fileId]"));
logger.info("Loaded /course/[courseId]/file/[fileId]");


module.exports = router;