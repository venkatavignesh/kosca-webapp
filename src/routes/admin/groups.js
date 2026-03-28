const express = require('express');
const router = express.Router();
const { requireModule } = require('../../middleware/auth');
const prisma = require('../../prisma');
const ExcelJS = require('exceljs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const logger = require('../../logger');

const uploadsDir = path.join(__dirname, '../../../uploads');

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

const canManageGroups = requireModule('ar_groups');
const canManageGroupImport = requireModule('admin_group_import');

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
      <label class="block text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1.5 uppercase tracking-wide">Sheet</label>
      <select name="sheet" id="gi-sheet" class="w-full rounded-lg border-0 py-2.5 pl-3 pr-8 text-sm text-gray-900 dark:text-[var(--input-text)] ring-1 ring-inset ring-gray-200 dark:ring-gray-700 focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-[var(--input-bg)] appearance-none"
        hx-post="/admin/group-import/reload-cols" hx-target="#gi-col-selectors" hx-include="[name='filePath']" hx-trigger="change">
        ${sheetOptions}
      </select>
    </div>
    <div id="gi-col-selectors" class="contents">
      <div>
        <label class="block text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1.5 uppercase tracking-wide">Group Name Column</label>
        <select name="groupCol" class="w-full rounded-lg border-0 py-2.5 pl-3 pr-8 text-sm text-gray-900 dark:text-[var(--input-text)] ring-1 ring-inset ring-gray-200 dark:ring-gray-700 focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-[var(--input-bg)] appearance-none">
          ${colOptions(0)}
        </select>
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1.5 uppercase tracking-wide">Customer Code Column</label>
        <select name="codeCol" class="w-full rounded-lg border-0 py-2.5 pl-3 pr-8 text-sm text-gray-900 dark:text-[var(--input-text)] ring-1 ring-inset ring-gray-200 dark:ring-gray-700 focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-[var(--input-bg)] appearance-none">
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
        logger.error({ err, route: 'POST /admin/group-import/parse' }, 'Group import parse error');
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
        <label class="block text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1.5 uppercase tracking-wide">Group Name Column</label>
        <select name="groupCol" class="w-full rounded-lg border-0 py-2.5 pl-3 pr-8 text-sm text-gray-900 dark:text-[var(--input-text)] ring-1 ring-inset ring-gray-200 dark:ring-gray-700 focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-[var(--input-bg)] appearance-none">${colOptions}</select>
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1.5 uppercase tracking-wide">Customer Code Column</label>
        <select name="codeCol" class="w-full rounded-lg border-0 py-2.5 pl-3 pr-8 text-sm text-gray-900 dark:text-[var(--input-text)] ring-1 ring-inset ring-gray-200 dark:ring-gray-700 focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-[var(--input-bg)] appearance-none">${colOptions2}</select>
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
        const fmt = (n) => '\u20B9' + (n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

        const groupNames = Object.keys(groupMap);
        let groupCardsHtml = '';
        for (const grp of groupNames) {
            const codes = [...groupMap[grp]];
            const safeGrp = grp.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            let rowsHtml = '';
            for (const code of codes) {
                const name = masterMap[code];
                const inv  = invoiceMap[code];
                const nameCell = name ? name.replace(/</g, '&lt;') : '<span class="text-gray-400 dark:text-gray-500">\u2014</span>';
                const invCell  = inv
                    ? `${fmt(inv.balance)} <span class="text-xs text-gray-400 dark:text-gray-500">(${inv.count} invoice${inv.count !== 1 ? 's' : ''})</span>`
                    : '<span class="text-xs text-gray-400 dark:text-gray-500 italic">No invoices</span>';
                rowsHtml += `<tr class="border-b border-gray-100 dark:border-gray-700 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800">
  <td class="px-4 py-2 text-xs font-mono text-gray-700 dark:text-gray-300 whitespace-nowrap">${code}</td>
  <td class="px-4 py-2 text-sm text-gray-800 dark:text-gray-200">${nameCell}</td>
  <td class="px-4 py-2 text-right text-sm font-medium text-gray-800 dark:text-gray-200">${invCell}</td>
</tr>`;
            }
            groupCardsHtml += `
<div class="bg-white dark:bg-[var(--surface-primary)] rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden">
  <div class="px-4 py-3 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between bg-gray-50 dark:bg-gray-800">
    <p class="text-sm font-bold text-gray-900 dark:text-gray-100">${safeGrp}</p>
    <span class="text-xs text-gray-500 dark:text-gray-400">${codes.length} location${codes.length !== 1 ? 's' : ''}</span>
  </div>
  <div class="overflow-x-auto">
    <table class="w-full text-left">
      <thead><tr class="border-b border-gray-100 dark:border-gray-700">
        <th class="px-4 py-2 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide">Code</th>
        <th class="px-4 py-2 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide">Name</th>
        <th class="px-4 py-2 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide text-right">Outstanding (Active)</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </div>
</div>`;
        }

        const summaryParts = [];
        if (saved)   summaryParts.push(`<span class="text-green-600 dark:text-green-400 font-semibold">${saved} saved</span>`);
        if (updated) summaryParts.push(`<span class="text-indigo-600 dark:text-indigo-400 font-semibold">${updated} updated</span>`);
        const summaryNote = summaryParts.length ? ` &middot; ${summaryParts.join(' &middot; ')}` : '';

        res.send(`
<div class="space-y-3">
  <p class="text-sm text-gray-500 dark:text-gray-400">${groupNames.length} group${groupNames.length !== 1 ? 's' : ''} &middot; ${allCodes.length} code${allCodes.length !== 1 ? 's' : ''}${summaryNote}</p>
  ${groupCardsHtml}
</div>`);
    } catch (err) {
        logger.error({ err, route: 'POST /admin/group-import/process' }, 'Group import process error');
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
        logger.error({ err, route: 'POST /admin/groups/create' }, 'Error creating group');
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
        logger.error({ err, route: 'POST /admin/groups/member/:customerCode/remove', customerCode: req.params.customerCode }, 'Error removing group member');
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
        logger.error({ err, route: 'POST /admin/groups/:groupName/add-member', groupName: req.params.groupName }, 'Error adding group member');
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
        logger.error({ err, route: 'POST /admin/groups/:groupName/delete', groupName: req.params.groupName }, 'Error deleting group');
        res.status(500).send('Failed to delete group.');
    }
});

module.exports = router;
