import {Router} from "express";
import {getLogger} from "log4js";

const router = Router();
const logger = getLogger('/classroom');

/*=======router======*/
// path: /classroom
// GET: show classroom environment data
router.get('/', (req, res) => {
    //todo
    res.status(200).json({code: 200, message: "This is classroom environment data!"});
});

router.post("/", (req, res) => {
    //todo
    res.json({code: 200, message: "This is classroom environment data!"});
});
module.exports = router;