// routes/brand.routes.js
const express = require('express');
const { resolveBrand, getBrand } = require('../controllers/brandResolverController');
const router = express.Router();

router.post('/resolve', resolveBrand);
router.get('/:domain', getBrand);

module.exports = router;