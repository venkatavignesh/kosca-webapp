// src/routes/ar/customers.js
const express  = require('express');
const router   = express.Router();
const prisma   = require('../../prisma');
const ExcelJS  = require('exceljs');
const { requireAuth, requireModule, requireRole } = require('../../middleware/auth');

function escHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

const _MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
function fmtDate(date) {
    if (!date) return '';
    const d = new Date(date);
    if (isNaN(d.getTime())) return '';
    return `${String(d.getDate()).padStart(2,'0')}-${_MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}

// Dispute toggle
router.post('/ar/customers/:code/dispute', requireAuth, requireModule('ar_directory'), async (req, res) => {
    try {
        const customerCode = req.params.code;
        const sessionRole = req.session.userRole;
        const existing = await prisma.customerDispute.findUnique({ where: { customerCode } });

        const enc = encodeURIComponent(customerCode);
        if (existing) {
            if (sessionRole !== 'ADMIN' && sessionRole !== 'MANAGER') {
                return res.status(403).send('Only managers and admins can remove a dispute.');
            }
            await prisma.customerDispute.delete({ where: { customerCode } });
            return res.send(`<button hx-post="/ar/customers/${enc}/dispute" hx-target="closest div" hx-swap="innerHTML" hx-confirm="Mark this customer as disputed? This will flag them on the dashboard." class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-600 text-[11px] font-semibold transition-colors border border-red-200"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>Mark as Disputed</button>`);
        } else {
            const cm = await prisma.customerMaster.findUnique({ where: { customerCode }, select: { customerName: true } });
            const customerName = cm?.customerName || req.body.customerName || '';
            await prisma.customerDispute.create({ data: { customerCode, customerName, addedBy: req.session.userId } });
            const canRemove = sessionRole === 'ADMIN' || sessionRole === 'MANAGER';
            return res.send(canRemove
                ? `<button hx-post="/ar/customers/${enc}/dispute" hx-target="closest div" hx-swap="innerHTML" hx-confirm="Remove dispute for this customer?" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-orange-100 hover:bg-orange-200 text-orange-700 text-[11px] font-semibold transition-colors border border-orange-300"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>Disputed — Remove</button>`
                : `<span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-orange-100 text-orange-700 text-[11px] font-semibold border border-orange-300"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>Disputed</span>`
            );
        }
    } catch (err) {
        console.error('Dispute toggle error:', err);
        res.status(500).send('Error');
    }
});

// Excel export for a customer's invoices
router.get('/ar/customers/:code/export', requireAuth, requireModule('ar_directory'), async (req, res) => {
    try {
        const code = req.params.code;
        const ids = req.query.inv ? req.query.inv.split(',').filter(Boolean) : null;
        const where = ids ? { customerCode: code, id: { in: ids } } : { customerCode: code, status: 'ACTIVE' };
        const invoices = await prisma.invoice.findMany({ where, orderBy: { invoiceDate: 'desc' } });

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Invoices');
        worksheet.columns = [
            { header: 'Invoice No',      key: 'Invoice No' },
            { header: 'Invoice Date',    key: 'Invoice Date' },
            { header: 'Due Date',        key: 'Due Date' },
            { header: 'Customer Code',   key: 'Customer Code' },
            { header: 'Customer Name',   key: 'Customer Name' },
            { header: 'Location',        key: 'Location' },
            { header: 'Invoice Amount',  key: 'Invoice Amount' },
            { header: 'Amount Paid',     key: 'Amount Paid' },
            { header: 'Outstanding',     key: 'Outstanding' },
            { header: 'Aging Days',      key: 'Aging Days' },
            { header: 'Status',          key: 'Status' }
        ];
        invoices.forEach(inv => worksheet.addRow({
            'Invoice No':     inv.invoiceNo,
            'Invoice Date':   fmtDate(inv.invoiceDate),
            'Due Date':       fmtDate(inv.dueDate),
            'Customer Code':  inv.customerCode,
            'Customer Name':  inv.customerName,
            'Location':       inv.siteName || '',
            'Invoice Amount': inv.invoiceAmount || inv.balanceAmount,
            'Amount Paid':    inv.paidAmount || 0,
            'Outstanding':    inv.balanceAmount,
            'Aging Days':     inv.agingDays,
            'Status':         inv.status
        }));
        const buf = await workbook.xlsx.writeBuffer();

        res.setHeader('Content-Disposition', `attachment; filename="invoices-${code}.xlsx"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buf);
    } catch (error) {
        console.error('Error exporting invoices:', error);
        res.status(500).send('Export failed');
    }
});

// Printable statement for a customer
router.get('/ar/customers/:code/statement', requireAuth, requireModule('ar_directory'), async (req, res) => {
    try {
        const code = req.params.code;
        const ids = req.query.inv ? req.query.inv.split(',').filter(Boolean) : null;
        const where = ids ? { customerCode: code, id: { in: ids } } : { customerCode: code, status: 'ACTIVE' };
        const invoices = await prisma.invoice.findMany({ where, orderBy: { invoiceDate: 'desc' } });
        const cm = await prisma.customerMaster.findUnique({
            where: { customerCode: code },
            select: { customerName: true, mobileNo: true }
        });
        const customerName = cm?.customerName || invoices[0]?.customerName || code;
        res.render('ar/statement', { invoices, customerName, customerCode: code, generatedAt: new Date() });
    } catch (error) {
        console.error('Error generating statement:', error);
        res.status(500).send('Error generating statement');
    }
});

// Debt trend page for a customer
router.get('/ar/customer/:code/trend', requireAuth, requireModule('ar_directory'), async (req, res) => {
    try {
        const code = req.params.code;
        const [snapshots, currentInvoices] = await Promise.all([
            prisma.aRSnapshot.findMany({ where: { customerCode: code }, orderBy: { snapshotDate: 'asc' } }),
            prisma.invoice.findMany({ where: { customerCode: code, status: 'ACTIVE' }, orderBy: { invoiceDate: 'desc' } })
        ]);
        const customerName = snapshots.length > 0
            ? snapshots[snapshots.length - 1].customerName
            : (currentInvoices[0]?.customerName || code);
        res.render('ar/customer_trend', { snapshots, currentInvoices, customerCode: code, customerName });
    } catch (error) {
        console.error('Error fetching trend:', error);
        res.status(500).send('Error loading trend data');
    }
});

// Update customer mobile number (manual override — locks it from auto-sync)
router.put('/ar/customers/:customerCode/mobile', requireAuth, requireModule('ar_mobile_edit'), async (req, res) => {
    try {
        const { customerCode } = req.params;
        const { mobileNo } = req.body;
        await prisma.customerMaster.upsert({
            where: { customerCode },
            update: { mobileNo: mobileNo.trim() || null, mobileNoLocked: true },
            create: { customerCode, customerName: customerCode, mobileNo: mobileNo.trim() || null, mobileNoLocked: true }
        });
        const display = mobileNo.trim() || '';
        res.send(`<span id="mobile-display-${customerCode.replace(/[^a-zA-Z0-9]/g, '_')}" class="text-[10px] text-indigo-500 font-mono">📞 ${escHtml(display)}</span>`);
    } catch (error) {
        console.error('Error updating mobile:', error);
        res.status(500).send('<span class="text-red-500 text-xs">Error saving</span>');
    }
});

// Restore mobile number from Customer Master (clears manual lock)
router.post('/ar/customers/:customerCode/mobile/fetch', requireAuth, requireModule('ar_mobile_edit'), async (req, res) => {
    try {
        const { customerCode } = req.params;
        const cm = await prisma.customerMaster.findUnique({
            where: { customerCode },
            select: { masterMobileNo: true }
        });
        if (!cm || !cm.masterMobileNo) {
            return res.status(404).send('<span class="text-[10px] text-red-400">No master number on file</span>');
        }
        await prisma.customerMaster.update({
            where: { customerCode },
            data: { mobileNo: cm.masterMobileNo, mobileNoLocked: false }
        });
        const safeId = customerCode.replace(/[^a-zA-Z0-9]/g, '_');
        res.send(`<a href="tel:${escHtml(cm.masterMobileNo)}" id="mobile-display-${safeId}" class="text-[10px] text-indigo-500 hover:text-indigo-700 font-mono">📞 ${escHtml(cm.masterMobileNo)}</a>`);
    } catch (error) {
        console.error('Error fetching mobile from master:', error);
        res.status(500).send('<span class="text-red-500 text-xs">Error restoring number</span>');
    }
});

// Pending settlement records for a customer (HTMX fragment)
router.get('/ar/customers/:code/pending-settlement', requireAuth, requireModule('ar_directory'), async (req, res) => {
    try {
        const code = req.params.code;
        const records = await prisma.pendingSettlement.findMany({
            where: { customerCode: code },
            orderBy: { documentDate: 'desc' }
        });
        const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const fmt = d => { if (!d) return '—'; const dt = new Date(d); return String(dt.getDate()).padStart(2,'0') + '-' + MONTHS[dt.getMonth()] + '-' + dt.getFullYear(); };
        const fmtAmt = n => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n);
        const badgeClass = tc => tc === 'CR' ? 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950 dark:text-green-400 dark:border-green-800' : tc === 'SRN' ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-800' : tc === 'ADV' ? 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-400 dark:border-blue-800' : 'bg-gray-50 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700';
        const typeLabel = tc => tc === 'CR' ? 'Credit Note' : tc === 'SRN' ? 'Sales Return' : tc === 'ADV' ? 'Advance' : tc || '—';

        if (records.length === 0) {
            return res.send('<p class="text-xs text-gray-400 py-2 text-center">No pending settlement records.</p>');
        }

        const rows = records.map(r => {
            const tc = (r.type || '').toUpperCase();
            const badge = r.type ? `<span class="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${badgeClass(tc)}">${typeLabel(tc)}</span>` : '—';
            return `<tr class="border-t border-gray-100 dark:border-gray-700 text-center">
                <td class="py-1.5 px-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">${fmt(r.documentDate)}</td>
                <td class="py-1.5 px-3 text-xs font-mono text-gray-700 dark:text-gray-300 whitespace-nowrap">${escHtml(r.documentNo || '—')}</td>
                <td class="py-1.5 px-3">${badge}</td>
                <td class="py-1.5 px-3 text-xs font-semibold text-gray-800 dark:text-gray-100 tabular-nums whitespace-nowrap">${fmtAmt(r.amount)}</td>
            </tr>`;
        }).join('');

        const total = records.reduce((s, r) => s + r.amount, 0);
        res.send(`<table class="w-full text-xs">
            <colgroup><col style="width:20%"><col style="width:35%"><col style="width:25%"><col style="width:20%"></colgroup>
            <thead><tr class="bg-gray-50 dark:bg-gray-800 border-b border-gray-100 dark:border-gray-700">
                <th class="py-1.5 px-3 text-center text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Doc Date</th>
                <th class="py-1.5 px-3 text-center text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Document No</th>
                <th class="py-1.5 px-3 text-center text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Type</th>
                <th class="py-1.5 px-3 text-center text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Amount</th>
            </tr></thead>
            <tbody>${rows}</tbody>
            <tfoot><tr class="border-t-2 border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/60">
                <td colspan="3" class="py-1.5 px-3 text-xs font-semibold text-gray-500 dark:text-gray-400 text-right">Total</td>
                <td class="py-1.5 px-3 text-xs font-bold text-gray-800 dark:text-gray-100 tabular-nums text-center">${fmtAmt(total)}</td>
            </tr></tfoot>
        </table>`);
    } catch (err) {
        console.error('Error fetching pending settlement:', err);
        res.status(500).send('<p class="text-xs text-red-400 py-2 text-center">Error loading records.</p>');
    }
});

module.exports = router;
