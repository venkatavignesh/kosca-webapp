const express = require('express');
const router = express.Router();
const { requireRole } = require('../../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const publicDir = path.join(__dirname, '../../../public');
const adminOnly = requireRole(['ADMIN']);

const logoUpload = multer({
    storage: multer.diskStorage({
        destination: (_, __, cb) => cb(null, publicDir),
        filename:    (_, __, cb) => cb(null, 'kosca-logo.png')
    }),
    fileFilter: (_, f, cb) => {
        const ext = path.extname(f.originalname).toLowerCase();
        const allowed = ['.png', '.jpg', '.jpeg', '.webp'];
        allowed.includes(ext) ? cb(null, true) : cb(new Error('Only image files are allowed'));
    },
    limits: { fileSize: 2 * 1024 * 1024 } // 2 MB
});

// Branding — logo upload
router.get('/branding', adminOnly, (req, res) => {
    const logoExists = fs.existsSync(path.join(publicDir, 'kosca-logo.png'));
    res.render('admin/branding', { logoExists });
});

router.post('/branding/logo', adminOnly, (req, res) => {
    logoUpload.single('logo')(req, res, (err) => {
        if (err) {
            return res.send(`<div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">${err.message}</div>`);
        }
        if (!req.file) {
            return res.send('<div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">No file uploaded.</div>');
        }
        res.send('<div class="bg-green-100 border border-green-400 text-green-700 px-4 py-3 rounded">Logo updated successfully. <a href="/" class="underline font-semibold">View site</a></div>');
    });
});

module.exports = router;
