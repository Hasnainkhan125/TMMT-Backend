const express = require('express');
const router = express.Router({ mergeParams: true });
const auth = require('../middelwares/auth');
const ctrl = require('../controllers/brandProject/tradeLicenseController');

router.use(auth);
router.post('/', ctrl.submitApplication);
router.get('/', ctrl.getApplication);

module.exports = router;
