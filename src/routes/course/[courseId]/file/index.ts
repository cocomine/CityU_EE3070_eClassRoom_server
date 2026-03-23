import {Response, Router} from "express";
import {getLogger} from "log4js";
import {CourseRequest} from "../index";
import multer from "multer";
import {DB} from "../../../../sql_service";
import {createHash} from "node:crypto";
import {RedisClient} from "../../../../redis_service";
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

/*=======router======*/
// path: /course/[courseId]/file/
// GET: list all uploaded files
router.get("/", async (req: CourseRequest, res) => {
    const {courseId} = req.params;
    const filesKey = `course:${courseId}:file`;
    const metaList = [];

    // check exists
    if (await RedisClient.exists(filesKey) === 0) {
        return res.status(404).json({code: 404, message: `No any files found in course ${courseId}.`});
    }

    // get all file meta
    const fileIdList = await RedisClient.sMembers(filesKey);
    for (let fileId of fileIdList) {
        const metaKey = `course:${courseId}:file:${fileId}:meta`;
        const meta = await RedisClient.hGetAll(metaKey);

        if (Object.keys(meta).length === 0) continue;
        metaList.push(meta);
    }

    res.json({code: 200, message: "All file meta get successfully.", data: metaList});
});

// path: /course/[courseId]/file/
// POST: upload file
router.post("/", upload.single("file"), async (req: CourseRequest, res: Response) => {
    const {courseId} = req.params;

    // check is multipart/form-data
    if (req.header("content-type")?.includes("multipart/form-data") === false) {
        return res.status(415).json({code: 415, message: "Content-Type must be multipart/form-data"});
    }

    // check have file upload
    const file = req.file;
    if (!file) {
        return res.status(400).json({code: 400, message: "No file uploaded"});
    }

    // check mime
    const {fileTypeFromBuffer} = await import("file-type");
    const mime = (await fileTypeFromBuffer(file.buffer))?.mime ?? xss(file.mimetype) ?? "application/octet-stream";
    if (mime) {
        if (mime.includes("video/")) {
            return res.status(400).json({code: 400, message: "Does not support video!"});
        } else if (mime.includes("audio/")) {
            return res.status(400).json({code: 400, message: "Does not support audio!"});
        }
    }

    // keys
    const sha256 = createHash("sha256").update(file.buffer).digest("hex");
    const fileId = crypto.randomUUID();
    const filename = xss(file.originalname);
    const filesKey = `course:${courseId}:file`;
    const metaKey = `course:${courseId}:file:${fileId}:meta`;

    try {
        // save database
        await DB.exec("BEGIN");
        await DB.run("INSERT OR IGNORE INTO file_blob (sha256, blob, size, mime) VALUES (?, ?, ?, ?)", [sha256, file.buffer, file.size, mime]);
        await DB.run("INSERT INTO files VALUES (?, ?, ?, ?)", [fileId, courseId, filename, sha256]);

        // save redis
        await RedisClient.multi()
            .hSet(metaKey, {
                fileId,
                courseId,
                mime,
                filename,
                sha256,
                size: file.size
            })
            .sAdd(filesKey, fileId)
            .exec();
        await DB.exec("COMMIT");
    } catch (err) {
        await DB.exec("ROLLBACK");
        logger.error(err);

        return res.status(500).json({code: 500, message: "Failed to save file."});
    }

    res.status(200).json({
        code: 200,
        message: "File uploaded successfully",
        data: {
            fileId,
            courseId,
            mime,
            filename,
            sha256
        }
    });
});

// path: /course/[courseId]/file/[fileId]/*
router.use("/:fileId", require("./[fileId]"));
logger.info("Loaded /course/[courseId]/file/[fileId]");


module.exports = router;