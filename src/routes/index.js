// src/routes/index.js
const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth');

// Hub home
router.get('/', requireAuth, (req, res) => res.render('home'));

// AR sub-routers
router.use(require('./ar/dashboard'));
router.use(require('./ar/directory'));
router.use(require('./ar/upload'));
router.use(require('./ar/invoices'));
router.use(require('./ar/customers'));
router.use(require('./ar/comments'));
router.use(require('./ar/pending_settlement'));

module.exports = router;
