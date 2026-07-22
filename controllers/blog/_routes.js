const express = require('express');
const router = express.Router();
const ctrl = require('./blogController');
const auth = require('../../middelwares/auth');

// Admin CRUD — must be before /:slug to avoid slug matching 'admin'
router.get('/admin/posts', auth, auth.requireRole('admin'), ctrl.adminList);
router.post('/admin/posts', auth, auth.requireRole('admin'), ctrl.adminCreate);
router.patch('/admin/posts/:id', auth, auth.requireRole('admin'), ctrl.adminUpdate);
router.delete('/admin/posts/:id', auth, auth.requireRole('admin'), ctrl.adminDelete);

// Public routes
router.get('/', ctrl.listPublished);
router.get('/:slug', ctrl.getBySlug);

module.exports = router;
