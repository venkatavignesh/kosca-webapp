// src/routes/ar/_shared.js
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');

const uploadsDir = path.join(__dirname, '../../../uploads');

// Ensure uploads directory exists on startup (was in index.js lines 12–15)
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const ALLOWED_EXCEL_MIMES = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
];

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadsDir),
        filename:    (req, file, cb) => cb(null,
            Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname)
        )
    }),
    fileFilter: (req, file, cb) => {
        const extOk  = ['.xlsx', '.xls'].includes(path.extname(file.originalname).toLowerCase());
        const mimeOk = ALLOWED_EXCEL_MIMES.includes(file.mimetype);
        extOk && mimeOk ? cb(null, true) : cb(new Error('Only .xlsx and .xls files are allowed'));
    },
    limits: { fileSize: 250 * 1024 * 1024 } // 250 MB
});

// Access control for /ar/invoices — checks query-param-dependent module flags.
// Exact HTMX HTML response bodies are preserved from source (zero behaviour change).
function requireInvoicesAccess(req, res, next) {
    const role    = req.session.userRole;
    const modules = req.session.userModules || [];
    const has     = (m) => role === 'ADMIN' || modules.includes(m);
    const keyOnly    = req.query.keyOnly    === '1';
    const subOnly    = req.query.subOnly    === '1';
    if (keyOnly    && !has('ar_key_accounts'))     return res.status(403).send('<div class="text-red-500 p-4">Access denied.</div>');
    if (subOnly    && !has('ar_sub_distributors')) return res.status(403).send('<div class="text-red-500 p-4">Access denied.</div>');
    if (!keyOnly && !subOnly && !has('ar_directory')) return res.status(403).send('<div class="text-red-500 p-4">Module not assigned.</div>');
    next();
}

module.exports = { upload, requireInvoicesAccess };
