const express = require('express');
const router = express.Router();
const prisma = require('../../prisma');
const logger = require('../../logger');
const { KEY_ACCOUNT_PREFIXES, SUB_DISTRIBUTOR_CODES } = require('../../config/categories');

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
        logger.error({ err: error, route: 'GET /admin/categories' }, 'Error fetching categories');
        res.status(500).render('error', { message: 'Internal Server Error', details: 'Could not fetch categories.' });
    }
});

// Redirects from old URLs
router.get('/key-accounts', (req, res) => res.redirect('/admin/categories?tab=key'));
router.get('/sub-distributors', (req, res) => res.redirect('/admin/categories?tab=sub'));

module.exports = router;
