'use strict';

const express = require('express');
const router  = express.Router();
const ctrl    = require('./brandController');

// Auth middleware — use the same pattern as studio routes (optionalAuth for now,
// brandController enforces userId presence explicitly)
const { optionalAuth } = require('../../middelwares/auth');
router.use(optionalAuth);

router.post('/',           ctrl.create);
router.get('/',            ctrl.list);
router.get('/:id',         ctrl.get);
router.put('/:id',         ctrl.update);
router.post('/:id/pause',  ctrl.pause);
router.post('/:id/resume', ctrl.resume);

module.exports = router;
