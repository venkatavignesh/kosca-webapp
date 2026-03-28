const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middleware/auth');

// All admin routes require authentication
router.use(requireAuth);

// Mount sub-routers — each defines its own route paths (e.g. /users, /categories)
router.use(require('./users'));
router.use(require('./categories'));
router.use(require('./site-assignments'));
router.use(require('./groups'));
router.use(require('./branding'));

module.exports = router;
