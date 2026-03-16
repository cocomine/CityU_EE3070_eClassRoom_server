import {Router} from "express";
import {getLogger} from "log4js";

const router = Router();
const logger = getLogger('/');

/*=======router======*/
// path: /
router.get('/', (req: any, res) => {

    res.status(200).json({code: 200, message: 'OK!'});
});

module.exports = router;