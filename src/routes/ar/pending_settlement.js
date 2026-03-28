// src/routes/ar/pending_settlement.js
const express = require('express');
const router  = express.Router();
const prisma  = require('../../prisma');
const { connection }                     = require('../../queue');
const { requireAuth, requireModule }     = require('../../middleware/auth');
const logger = require('../../logger');

router.get('/ar/pending-settlement', requireAuth, requireModule('ar_pending_settlement'), async (req, res) => {
    try {
        const search   = (req.query.search || '').trim();
        const page     = Math.max(1, parseInt(req.query.page)  || 1);
        const limit    = Math.min(100, Math.max(5, parseInt(req.query.limit) || 25));
        const skip     = (page - 1) * limit;

        const where = {};
        if (search) {
            where.OR = [
                { customerCode: { contains: search, mode: 'insensitive' } },
                { customerName: { contains: search, mode: 'insensitive' } },
                { documentNo:   { contains: search, mode: 'insensitive' } },
            ];
        }

        const [allRecords, lastPsSyncISO] = await Promise.all([
            prisma.pendingSettlement.findMany({
                where,
                orderBy: [{ customerCode: 'asc' }, { documentDate: 'desc' }],
            }),
            connection.get('kosca:last_ps_sync'),
        ]);

        // Group by customerCode
        const groupMap = new Map();
        for (const r of allRecords) {
            if (!groupMap.has(r.customerCode)) {
                groupMap.set(r.customerCode, {
                    customerCode: r.customerCode,
                    customerName: r.customerName,
                    records: [],
                    totalAmount: 0,
                });
            }
            const g = groupMap.get(r.customerCode);
            g.records.push(r);
            g.totalAmount += r.amount;
        }

        const allGroups  = Array.from(groupMap.values()).sort((a, b) => b.totalAmount - a.totalAmount);
        const total      = allGroups.length;
        const groups     = allGroups.slice(skip, skip + limit);

        const fmtIST = iso => iso
            ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
            : null;

        res.render('ar/pending_settlement', {
            groups,
            total,
            page,
            limit,
            search,
            totalPages: Math.ceil(total / limit),
            lastSync: fmtIST(lastPsSyncISO),
        });
    } catch (err) {
        logger.error({ err, route: 'GET /ar/pending-settlement' }, 'Pending settlement route error');
        res.status(500).send('Internal server error');
    }
});

module.exports = router;
