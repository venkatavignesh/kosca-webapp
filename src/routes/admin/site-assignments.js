const express = require('express');
const router = express.Router();
const { requireRole, requireModule } = require('../../middleware/auth');
const prisma = require('../../prisma');
const logger = require('../../logger');
const { getKeyAccountCodes } = require('../../config/categories');

const adminOnly = requireRole(['ADMIN']);
const canManageSiteAssignments = requireModule('admin_site_assignments');

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
        logger.error({ err: error, route: 'GET /admin/site-assignments' }, 'Error fetching site assignments');
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
        logger.error({ err: error, route: 'POST /admin/site-assignments/:code/move', customerCode: req.params.code }, 'Error moving customer site');
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
        logger.error({ err: error, route: 'POST /admin/site-overrides' }, 'Error saving site override');
        res.status(500).send('Error saving site override');
    }
});

module.exports = router;
