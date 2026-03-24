const express = require('express');
const router = express.Router();
const { requireRole, requireAuth, requireModule } = require('../middleware/auth');
const prisma = require('../prisma');
const bcrypt = require('bcrypt');
const multer = require('multer');
const ExcelJS = require('exceljs');
const path   = require('path');
const fs     = require('fs');

const uploadsDir = path.join(__dirname, '../../uploads');
const publicDir  = path.join(__dirname, '../../public');

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

function safeUploadPath(filePath) {
    if (!filePath || typeof filePath !== 'string' || !filePath.trim()) {
        throw new Error('Invalid file path');
    }
    const resolved = path.resolve(uploadsDir, path.basename(filePath));
    if (!resolved.startsWith(uploadsDir + path.sep) && resolved !== uploadsDir) {
        throw new Error('Invalid file path');
    }
    return resolved;
}

const escHtml = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

const ALLOWED_EXCEL_MIMES = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
];
const groupUpload = multer({
    storage: multer.diskStorage({
        destination: (_, __, cb) => cb(null, uploadsDir),
        filename:    (_, f, cb)  => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(f.originalname))
    }),
    fileFilter: (_, f, cb) => {
        const extOk = ['.xlsx', '.xls'].includes(path.extname(f.originalname).toLowerCase());
        const mimeOk = ALLOWED_EXCEL_MIMES.includes(f.mimetype);
        extOk && mimeOk ? cb(null, true) : cb(new Error('Only .xlsx and .xls files are allowed'));
    },
    limits: { fileSize: 250 * 1024 * 1024 } // 250 MB
});

// All admin routes require authentication
router.use(requireAuth);

// Shorthand middleware groups
const adminOnly = requireRole(['ADMIN']);
const canManageKeyAccounts    = requireModule('admin_key_accounts');
const canManageSubDistributors = requireModule('admin_sub_distributors');
const { KEY_ACCOUNT_PREFIXES, SUB_DISTRIBUTOR_CODES, getKeyAccountCodes } = require('../config/categories');
const canManageGroups         = requireModule('ar_groups');
const canManageSiteAssignments = requireModule('admin_site_assignments');
const canManageGroupImport     = requireModule('admin_group_import');

// Render the users management dashboard
router.get('/users', adminOnly, async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            orderBy: { createdAt: 'desc' }
        });
        res.render('admin/users', { users });
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).render('error', {
            message: 'Internal Server Error',
            details: 'Could not fetch users list from database.'
        });
    }
});

// Create a new user
router.post('/users', adminOnly, async (req, res) => {
    try {
        const { name, email, password, role, modules } = req.body;

        let assignedModules = [];
        if (modules) {
            // handle single or multiple checkbox values
            assignedModules = Array.isArray(modules) ? modules : [modules];
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        await prisma.user.create({
            data: {
                name,
                email,
                password: hashedPassword,
                role: role || 'USER',
                modules: assignedModules
            }
        });

        res.redirect('/admin/users');
    } catch (error) {
        if (error.code === 'P2002') {
            return res.status(400).render('error', {
                message: 'User Creation Failed',
                details: 'A user with that email already exists.'
            });
        }
        res.status(500).send('Error creating user');
    }
});

// Edit a user
router.post('/users/:id/edit', adminOnly, async (req, res) => {
    try {
        const userId = req.params.id;
        const { name, email, password, role, modules } = req.body;

        let assignedModules = [];
        if (modules) {
            assignedModules = Array.isArray(modules) ? modules : [modules];
        }

        const updateData = {
            name,
            email,
            role,
            modules: assignedModules
        };

        // If a password was provided, we hash and insert it otherwise keep the old one
        if (password && password.trim() !== '') {
            updateData.password = await bcrypt.hash(password, 10);
        }

        await prisma.user.update({
            where: { id: userId },
            data: updateData
        });

        res.redirect('/admin/users');
    } catch (error) {
        console.error('Error updating user:', error);

        if (error.code === 'P2002') {
            return res.status(400).render('error', {
                message: 'User Update Failed',
                details: 'Another user is already using that email.'
            });
        }

        res.status(500).render('error', {
            message: 'Internal Server Error',
            details: 'Could not update user information.'
        });
    }
});

// Delete a user
router.post('/users/:id/delete', adminOnly, async (req, res) => {
    try {
        const userId = req.params.id;

        // Prevent admin suicide
        if (userId === req.session.userId) {
            return res.status(400).send('You cannot delete your own active admin account.');
        }

        // Prevent non-ADMIN from deleting ADMIN accounts
        const targetUser = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
        if (targetUser?.role === 'ADMIN' && req.session.userRole !== 'ADMIN') {
            return res.status(403).send('Only admins can delete admin accounts.');
        }

        await prisma.user.delete({
            where: { id: userId }
        });

        res.redirect('/admin/users');
    } catch (error) {
        console.error('Error deleting user:', error);
        res.status(500).send('Error deleting user');
    }
});

// ======== CATEGORIES (combined Key Accounts + Sub Distributors — read-only) ========

const canManageCategories = (req, res, next) => {
    const userModules = req.session.userModules || [];
    const userRole = req.session.userRole;
    if (userRole === 'ADMIN' || userModules.includes('admin_key_accounts') || userModules.includes('admin_sub_distributors')) return next();
    return res.status(403).render('error', { message: 'Forbidden', details: 'You do not have access to this page.' });
};

router.get('/categories', canManageCategories, async (req, res) => {
    try {
        const tab = req.query.tab === 'sub' ? 'sub' : 'key';

        // Fetch key accounts
        const prefixFilters = KEY_ACCOUNT_PREFIXES.map(p => ({ customerName: { startsWith: p, mode: 'insensitive' } }));
        const keyRows = await prisma.invoice.findMany({
            where: { status: 'ACTIVE', OR: prefixFilters },
            select: { customerCode: true, customerName: true },
            distinct: ['customerCode'],
            orderBy: { customerName: 'asc' }
        });
        const keyAccounts = keyRows.map(r => ({
            customerCode: r.customerCode,
            customerName: r.customerName,
            matchedPrefix: KEY_ACCOUNT_PREFIXES.find(p => (r.customerName || '').toUpperCase().startsWith(p.toUpperCase())) || ''
        }));
        // Group by prefix
        const keyGroups = {};
        KEY_ACCOUNT_PREFIXES.forEach(p => { keyGroups[p] = []; });
        keyAccounts.forEach(ka => { if (keyGroups[ka.matchedPrefix]) keyGroups[ka.matchedPrefix].push(ka); });

        // Fetch sub distributors
        const [masterRows, invoiceRows] = await Promise.all([
            prisma.customerMaster.findMany({ where: { customerCode: { in: SUB_DISTRIBUTOR_CODES } }, select: { customerCode: true, customerName: true } }),
            prisma.invoice.findMany({ where: { customerCode: { in: SUB_DISTRIBUTOR_CODES } }, select: { customerCode: true, customerName: true }, distinct: ['customerCode'] })
        ]);
        const nameMap = {};
        invoiceRows.forEach(r => { if (r.customerName) nameMap[r.customerCode] = r.customerName; });
        masterRows.forEach(r => { if (r.customerName) nameMap[r.customerCode] = r.customerName; });
        const subDistributors = SUB_DISTRIBUTOR_CODES.map(code => ({
            customerCode: code,
            customerName: nameMap[code] || null
        }));

        res.render('admin/categories', {
            tab,
            keyAccounts, keyGroups, keyTotal: keyAccounts.length,
            subDistributors, subTotal: subDistributors.length,
            prefixes: KEY_ACCOUNT_PREFIXES
        });
    } catch (error) {
        console.error('Error fetching categories:', error);
        res.status(500).render('error', { message: 'Internal Server Error', details: 'Could not fetch categories.' });
    }
});

// Redirects from old URLs
router.get('/key-accounts', (req, res) => res.redirect('/admin/categories?tab=key'));
router.get('/sub-distributors', (req, res) => res.redirect('/admin/categories?tab=sub'));

// ======== SITE ASSIGNMENTS ========

router.get('/site-assignments', canManageSiteAssignments, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 200);
        const search = req.query.search || '';
        const skip = (page - 1) * limit;

        const keyAccountCodes = await getKeyAccountCodes(prisma);

        const searchWhere = search ? {
            OR: [
                { customerCode: { contains: search, mode: 'insensitive' } },
                { customerName: { contains: search, mode: 'insensitive' } }
            ]
        } : {};

        const baseWhere = { status: 'ACTIVE', customerCode: { notIn: keyAccountCodes }, ...searchWhere };

        // Get distinct customer codes (paginated)
        const [customerGroups, totalCount] = await Promise.all([
            prisma.invoice.groupBy({
                by: ['customerCode', 'customerName'],
                where: baseWhere,
                skip,
                take: limit,
                orderBy: { customerCode: 'asc' }
            }),
            prisma.invoice.groupBy({ by: ['customerCode'], where: baseWhere }).then(r => r.length)
        ]);

        const codes = customerGroups.map(c => c.customerCode);

        // Get current site per customer (first invoice's siteName)
        const siteRows = await prisma.invoice.findMany({
            where: { customerCode: { in: codes }, status: 'ACTIVE' },
            select: { customerCode: true, siteName: true },
            distinct: ['customerCode']
        });
        const siteMap = new Map(siteRows.map(r => [r.customerCode, r.siteName]));

        // Overrides take precedence
        const overrides = await prisma.customerSiteOverride.findMany({
            where: { customerCode: { in: codes } },
            select: { customerCode: true, siteName: true }
        });
        overrides.forEach(o => siteMap.set(o.customerCode, o.siteName));

        // Available site names
        const siteNameRows = await prisma.invoice.findMany({
            where: { status: 'ACTIVE', siteName: { not: null } },
            select: { siteName: true },
            distinct: ['siteName']
        });
        const siteNames = siteNameRows.map(r => r.siteName).filter(Boolean).sort();

        const customers = customerGroups.map(c => ({
            customerCode: c.customerCode,
            customerName: c.customerName,
            currentSite: siteMap.get(c.customerCode) || 'Unknown'
        }));

        const totalPages = Math.ceil(totalCount / limit);
        res.render('admin/site_assignments', { customers, page, totalPages, totalCount, search, limit, siteNames });
    } catch (error) {
        console.error('Error fetching site assignments:', error);
        res.status(500).render('error', { message: 'Internal Server Error', details: 'Could not fetch site assignments.' });
    }
});

router.post('/site-assignments/:code/move', canManageSiteAssignments, async (req, res) => {
    try {
        const customerCode = req.params.code;
        const { siteName } = req.body;
        if (!siteName) return res.redirect('/admin/site-assignments');

        await prisma.customerSiteOverride.upsert({
            where: { customerCode },
            update: { siteName, setBy: req.session.userName, setAt: new Date() },
            create: { customerCode, siteName, setBy: req.session.userName }
        });

        await prisma.invoice.updateMany({
            where: { customerCode },
            data: { siteName }
        });

        res.redirect('/admin/site-assignments');
    } catch (error) {
        console.error('Error moving customer site:', error);
        res.status(500).render('error', { message: 'Internal Server Error', details: 'Could not move customer.' });
    }
});

// ======== SITE OVERRIDES ========

router.post('/site-overrides', adminOnly, async (req, res) => {
    try {
        const { customerCode, siteName } = req.body;
        if (!customerCode || !siteName) return res.status(400).send('Missing fields');

        await prisma.customerSiteOverride.upsert({
            where: { customerCode },
            update: { siteName, setBy: req.session.userName, setAt: new Date() },
            create: { customerCode, siteName, setBy: req.session.userName }
        });

        // Apply to all existing invoices for this customer that have no site
        await prisma.invoice.updateMany({
            where: { customerCode, siteName: null },
            data: { siteName }
        });

        res.redirect('/ar');
    } catch (error) {
        console.error('Error saving site override:', error);
        res.status(500).send('Error saving site override');
    }
});

// ======== GROUP IMPORT ========

router.get('/group-import', canManageGroupImport, (req, res) => {
    res.render('admin/group_import');
});

// Step 1 → parse uploaded file, return sheet/column selectors
router.post('/group-import/parse', canManageGroupImport, groupUpload.single('excelFile'), async (req, res) => {
    if (!req.file) return res.status(400).send('<p class="text-red-600 text-sm font-medium">No file uploaded.</p>');
    try {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(req.file.path);
        const sheetNames = wb.worksheets.map(ws => ws.name);
        // Read first sheet to get column headers
        const firstSheet = wb.worksheets[0];
        const allHeaders = [];
        if (firstSheet) firstSheet.getRow(1).eachCell({ includeEmpty: true }, (cell, colNum) => { allHeaders[colNum - 1] = cell.text; });
        const headers = allHeaders.map(String).filter(h => h.trim() !== '');
        const filePath = req.file.path;

        const sheetOptions = sheetNames.map((s, i) =>
            `<option value="${escHtml(s)}"${i === 0 ? ' selected' : ''}>${escHtml(s)}</option>`
        ).join('');
        // Use indices as values — avoids any key-name mismatch in preview
        const colOptions = (defaultIdx) => headers.map((c, i) =>
            `<option value="${i}"${i === defaultIdx ? ' selected' : ''}>${escHtml(c)}</option>`
        ).join('');

        res.send(`
<div class="space-y-4">
  <input type="hidden" name="filePath" value="${filePath.replace(/"/g, '&quot;')}">
  <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
    <div>
      <label class="block text-xs font-semibold text-gray-600 mb-1.5 uppercase tracking-wide">Sheet</label>
      <select name="sheet" id="gi-sheet" class="w-full rounded-lg border-0 py-2.5 pl-3 pr-8 text-sm text-gray-900 ring-1 ring-inset ring-gray-200 focus:ring-2 focus:ring-indigo-500 bg-white appearance-none"
        hx-post="/admin/group-import/reload-cols" hx-target="#gi-col-selectors" hx-include="[name='filePath']" hx-trigger="change">
        ${sheetOptions}
      </select>
    </div>
    <div id="gi-col-selectors" class="contents">
      <div>
        <label class="block text-xs font-semibold text-gray-600 mb-1.5 uppercase tracking-wide">Group Name Column</label>
        <select name="groupCol" class="w-full rounded-lg border-0 py-2.5 pl-3 pr-8 text-sm text-gray-900 ring-1 ring-inset ring-gray-200 focus:ring-2 focus:ring-indigo-500 bg-white appearance-none">
          ${colOptions(0)}
        </select>
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-600 mb-1.5 uppercase tracking-wide">Customer Code Column</label>
        <select name="codeCol" class="w-full rounded-lg border-0 py-2.5 pl-3 pr-8 text-sm text-gray-900 ring-1 ring-inset ring-gray-200 focus:ring-2 focus:ring-indigo-500 bg-white appearance-none">
          ${colOptions(1)}
        </select>
      </div>
    </div>
  </div>
  <button type="button"
    hx-post="/admin/group-import/process"
    hx-target="#step-result"
    hx-include="[name='filePath'],[name='sheet'],[name='groupCol'],[name='codeCol']"
    hx-indicator="#gi-spinner"
    class="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:ring-offset-2">
    Import Groups
    <svg id="gi-spinner" class="htmx-indicator animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
  </button>
</div>`);
    } catch (err) {
        console.error('Group import parse error:', err);
        if (req.file) try { fs.unlinkSync(req.file.path); } catch (_) {}
        res.status(500).send('<p class="text-red-600 text-sm font-medium">Failed to read Excel file. Make sure it is a valid .xlsx file.</p>');
    }
});

// Reload column selectors when sheet changes
router.post('/group-import/reload-cols', canManageGroupImport, async (req, res) => {
    const { filePath, sheet } = req.body;
    if (typeof filePath !== 'string') return res.status(400).send('<div class="col-span-2 text-red-500 text-sm">Invalid input.</div>');
    try {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(safeUploadPath(filePath));
        const ws = wb.getWorksheet(sheet) || wb.worksheets[0];
        const allHeaders = [];
        if (ws) ws.getRow(1).eachCell({ includeEmpty: true }, (cell, colNum) => { allHeaders[colNum - 1] = cell.text; });
        const headers = allHeaders.map(String).filter(h => h.trim() !== '');
        const colOptions = headers.map((c, i) => `<option value="${i}"${i === 0 ? ' selected' : ''}>${escHtml(c)}</option>`).join('');
        const colOptions2 = headers.map((c, i) => `<option value="${i}"${i === 1 ? ' selected' : ''}>${escHtml(c)}</option>`).join('');
        res.send(`
      <div>
        <label class="block text-xs font-semibold text-gray-600 mb-1.5 uppercase tracking-wide">Group Name Column</label>
        <select name="groupCol" class="w-full rounded-lg border-0 py-2.5 pl-3 pr-8 text-sm text-gray-900 ring-1 ring-inset ring-gray-200 focus:ring-2 focus:ring-indigo-500 bg-white appearance-none">${colOptions}</select>
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-600 mb-1.5 uppercase tracking-wide">Customer Code Column</label>
        <select name="codeCol" class="w-full rounded-lg border-0 py-2.5 pl-3 pr-8 text-sm text-gray-900 ring-1 ring-inset ring-gray-200 focus:ring-2 focus:ring-indigo-500 bg-white appearance-none">${colOptions2}</select>
      </div>`);
    } catch (_) {
        res.send('<div class="col-span-2 text-red-500 text-sm">Could not read sheet columns.</div>');
    }
});

// Step 2 → process: save groups to CustomerGroup, show invoice summary per code
router.post('/group-import/process', canManageGroupImport, async (req, res) => {
    const { filePath, sheet, groupCol, codeCol } = req.body;
    if (typeof filePath !== 'string') return res.status(400).send('<p class="text-sm text-red-500">Invalid input.</p>');
    const groupIdx = parseInt(groupCol, 10);
    const codeIdx  = parseInt(codeCol,  10);
    try {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(safeUploadPath(filePath));
        const ws = wb.getWorksheet(sheet) || wb.worksheets[0];
        const allRows = [];
        if (ws) ws.eachRow(row => { const vals = []; row.eachCell({ includeEmpty: true }, (cell, colNum) => { vals[colNum - 1] = cell.text; }); allRows.push(vals); });
        const rows = allRows.slice(1);

        // Build group map: group name → set of codes
        const groupMap = {};
        const codeToGroup = {};
        for (const row of rows) {
            const grp  = String(row[groupIdx] || '').trim();
            const code = String(row[codeIdx]  || '').trim().toUpperCase().replace(/-T$/, '');
            if (!grp || !code) continue;
            if (!groupMap[grp]) groupMap[grp] = new Set();
            groupMap[grp].add(code);
            codeToGroup[code] = grp;
        }

        const allCodes = Object.keys(codeToGroup);
        if (allCodes.length === 0) {
            return res.send('<p class="text-sm text-gray-500">No customer codes found. Check your column selections.</p>');
        }

        // Lookup customer names + invoice summary
        const [masterRows, invSummary] = await Promise.all([
            prisma.customerMaster.findMany({ where: { customerCode: { in: allCodes } }, select: { customerCode: true, customerName: true } }),
            prisma.invoice.groupBy({
                by: ['customerCode'],
                where: { customerCode: { in: allCodes }, status: 'ACTIVE' },
                _count: { _all: true },
                _sum: { balanceAmount: true }
            })
        ]);

        const masterMap = {};
        for (const r of masterRows) masterMap[r.customerCode] = r.customerName;

        const invoiceMap = {};
        for (const r of invSummary) invoiceMap[r.customerCode] = { count: r._count._all, balance: r._sum.balanceAmount || 0 };

        // Upsert into CustomerGroup — batch fetch existing, then bulk insert new + update changed
        const existingRows = await prisma.customerGroup.findMany({
            where: { customerCode: { in: allCodes } },
            select: { customerCode: true, groupName: true }
        });
        const existingMap = {};
        for (const r of existingRows) existingMap[r.customerCode] = r.groupName;

        const toCreate = [];
        const toUpdate = [];
        for (const code of allCodes) {
            const groupName = codeToGroup[code];
            const customerName = masterMap[code] || null;
            if (existingMap[code] === undefined) {
                toCreate.push({ groupName, customerCode: code, customerName, addedBy: req.session.userName });
            } else if (existingMap[code] !== groupName) {
                toUpdate.push({ code, groupName, customerName });
            }
        }

        const [createResult] = await Promise.all([
            prisma.customerGroup.createMany({ data: toCreate, skipDuplicates: true }),
            ...toUpdate.map(({ code, groupName, customerName }) =>
                prisma.customerGroup.update({ where: { customerCode: code }, data: { groupName, customerName } })
            )
        ]);
        const saved = createResult.count;
        const updated = toUpdate.length;

        // Cleanup temp file
        if (filePath) try { fs.unlinkSync(safeUploadPath(filePath)); } catch (_) {}

        // Build result HTML
        const fmt = (n) => '₹' + (n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

        const groupNames = Object.keys(groupMap);
        let groupCardsHtml = '';
        for (const grp of groupNames) {
            const codes = [...groupMap[grp]];
            const safeGrp = grp.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            let rowsHtml = '';
            for (const code of codes) {
                const name = masterMap[code];
                const inv  = invoiceMap[code];
                const nameCell = name ? name.replace(/</g, '&lt;') : '<span class="text-gray-400">—</span>';
                const invCell  = inv
                    ? `${fmt(inv.balance)} <span class="text-xs text-gray-400">(${inv.count} invoice${inv.count !== 1 ? 's' : ''})</span>`
                    : '<span class="text-xs text-gray-400 italic">No invoices</span>';
                rowsHtml += `<tr class="border-b border-gray-100 last:border-0 hover:bg-gray-50">
  <td class="px-4 py-2 text-xs font-mono text-gray-700 whitespace-nowrap">${code}</td>
  <td class="px-4 py-2 text-sm text-gray-800">${nameCell}</td>
  <td class="px-4 py-2 text-right text-sm font-medium text-gray-800">${invCell}</td>
</tr>`;
            }
            groupCardsHtml += `
<div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
  <div class="px-4 py-3 border-b border-gray-100 flex items-center justify-between bg-gray-50">
    <p class="text-sm font-bold text-gray-900">${safeGrp}</p>
    <span class="text-xs text-gray-500">${codes.length} location${codes.length !== 1 ? 's' : ''}</span>
  </div>
  <div class="overflow-x-auto">
    <table class="w-full text-left">
      <thead><tr class="border-b border-gray-100">
        <th class="px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wide">Code</th>
        <th class="px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wide">Name</th>
        <th class="px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wide text-right">Outstanding (Active)</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </div>
</div>`;
        }

        const summaryParts = [];
        if (saved)   summaryParts.push(`<span class="text-green-600 font-semibold">${saved} saved</span>`);
        if (updated) summaryParts.push(`<span class="text-indigo-600 font-semibold">${updated} updated</span>`);
        const summaryNote = summaryParts.length ? ` &middot; ${summaryParts.join(' &middot; ')}` : '';

        res.send(`
<div class="space-y-3">
  <p class="text-sm text-gray-500">${groupNames.length} group${groupNames.length !== 1 ? 's' : ''} &middot; ${allCodes.length} code${allCodes.length !== 1 ? 's' : ''}${summaryNote}</p>
  ${groupCardsHtml}
</div>`);
    } catch (err) {
        console.error('Group import process error:', err);
        res.status(500).send('<p class="text-red-600 text-sm font-medium">Failed to process file. Please try again.</p>');
    }
});

// Create a new group with a first member
router.post('/groups/create', canManageGroups, async (req, res) => {
    try {
        const groupName = (req.body.groupName || '').trim();
        const customerCode = (req.body.customerCode || '').trim();
        if (!groupName) return res.status(400).send('Group name required.');
        if (!customerCode) return res.status(400).send('At least one customer code required.');
        const master = await prisma.customerMaster.findUnique({ where: { customerCode }, select: { customerName: true } });
        await prisma.customerGroup.upsert({
            where: { customerCode },
            update: { groupName, customerName: master?.customerName || null },
            create: { groupName, customerCode, customerName: master?.customerName || null, addedBy: req.session.userName || 'admin' }
        });
        res.send('');
    } catch (err) {
        console.error('Error creating group:', err);
        res.status(500).send('Failed to create group.');
    }
});

// Remove a single customer code from its group
router.post('/groups/member/:customerCode/remove', canManageGroups, async (req, res) => {
    try {
        const customerCode = decodeURIComponent(req.params.customerCode);
        await prisma.customerGroup.delete({ where: { customerCode } });
        res.send('');
    } catch (err) {
        console.error('Error removing group member:', err);
        res.status(500).send('Failed to remove member.');
    }
});

// Add a single customer code to a group
router.post('/groups/:groupName/add-member', canManageGroups, async (req, res) => {
    try {
        const groupName = decodeURIComponent(req.params.groupName);
        const customerCode = (req.body.customerCode || '').trim();
        const force = req.body.force === 'true';
        if (!customerCode) return res.status(400).send('Customer code required.');
        if (!force) {
            const existing = await prisma.customerGroup.findUnique({ where: { customerCode }, select: { groupName: true } });
            if (existing && existing.groupName !== groupName) {
                return res.status(409).send(existing.groupName);
            }
        }
        const master = await prisma.customerMaster.findUnique({
            where: { customerCode },
            select: { customerName: true }
        });
        await prisma.customerGroup.upsert({
            where: { customerCode },
            update: { groupName, customerName: master?.customerName || null },
            create: { groupName, customerCode, customerName: master?.customerName || null, addedBy: req.session.userName || 'admin' }
        });
        res.send('');
    } catch (err) {
        console.error('Error adding group member:', err);
        res.status(500).send('Failed to add member.');
    }
});

// Delete all CustomerGroup records for a given group name
router.post('/groups/:groupName/delete', canManageGroups, async (req, res) => {
    try {
        const groupName = decodeURIComponent(req.params.groupName);
        await prisma.customerGroup.deleteMany({ where: { groupName } });
        res.send('');
    } catch (err) {
        console.error('Error deleting group:', err);
        res.status(500).send('Failed to delete group.');
    }
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
