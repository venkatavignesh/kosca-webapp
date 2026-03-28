// src/routes/ar/dashboard.js
const express = require('express');
const router  = express.Router();
const prisma  = require('../../prisma');
const { connection }             = require('../../queue');
const { requireAuth, requireModule } = require('../../middleware/auth');
const { SUB_DISTRIBUTOR_CODES, getKeyAccountCodes } = require('../../config/categories');
const logger = require('../../logger');

// Render AR Metrics Dashboard
router.get('/ar', requireAuth, requireModule('ar_dashboard'), async (req, res) => {
    try {
        // Fetch key account codes dynamically (name-prefix match) and use config sub-d codes
        const [keyAccountCodes, disputedListDash] = await Promise.all([
            getKeyAccountCodes(prisma),
            prisma.customerDispute.findMany({ select: { customerCode: true } })
        ]);
        const subDistributorCodes = SUB_DISTRIBUTOR_CODES;
        const disputedCodesAll = disputedListDash.map(d => d.customerCode);
        const excludedCodes = [...keyAccountCodes, ...subDistributorCodes, ...disputedCodesAll];

        // Dashboard always shows full portfolio metrics for all roles
        let invoiceWhereClause = { status: 'ACTIVE', customerCode: { notIn: excludedCodes } };

        const [invoices, lastArSyncISO, lastCmSyncISO, arFileMtimeISO, cmFileMtimeISO] = await Promise.all([
            prisma.invoice.findMany({
                where: invoiceWhereClause,
                select: { balanceAmount: true, agingDays: true, customerCode: true, siteName: true }
            }),
            connection.get('kosca:last_ar_sync'),
            connection.get('kosca:last_cm_sync'),
            connection.get('kosca:last_ar_file_mtime'),
            connection.get('kosca:last_cm_file_mtime')
        ]);
        const fmtIST = iso => iso
            ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
            : null;
        const lastUpdated = fmtIST(lastArSyncISO);
        const arImportedAt = fmtIST(lastArSyncISO);
        const arFileDate   = fmtIST(arFileMtimeISO);
        const cmImportedAt = fmtIST(lastCmSyncISO);
        const cmFileDate   = fmtIST(cmFileMtimeISO);

        const metrics = {
            total: { amount: 0, doors: new Set() },
            bucket0_30: { amount: 0, doors: new Set() },
            bucket31_60: { amount: 0, doors: new Set() },
            bucket61_90: { amount: 0, doors: new Set() },
            bucket91_120: { amount: 0, doors: new Set() },
            bucket121_150: { amount: 0, doors: new Set() },
            bucket151_180: { amount: 0, doors: new Set() },
            bucketOver180: { amount: 0, doors: new Set() }
        };

        invoices.forEach(inv => {
            const amt = inv.balanceAmount;
            const days = inv.agingDays;
            const code = inv.customerCode;

            metrics.total.amount += amt;
            if (code) metrics.total.doors.add(code);

            if (days <= 30) {
                metrics.bucket0_30.amount += amt;
                if (code) metrics.bucket0_30.doors.add(code);
            } else if (days <= 60) {
                metrics.bucket31_60.amount += amt;
                if (code) metrics.bucket31_60.doors.add(code);
            } else if (days <= 90) {
                metrics.bucket61_90.amount += amt;
                if (code) metrics.bucket61_90.doors.add(code);
            } else if (days <= 120) {
                metrics.bucket91_120.amount += amt;
                if (code) metrics.bucket91_120.doors.add(code);
            } else if (days <= 150) {
                metrics.bucket121_150.amount += amt;
                if (code) metrics.bucket121_150.doors.add(code);
            } else if (days <= 180) {
                metrics.bucket151_180.amount += amt;
                if (code) metrics.bucket151_180.doors.add(code);
            } else {
                metrics.bucketOver180.amount += amt;
                if (code) metrics.bucketOver180.doors.add(code);
            }
        });

        // Format metrics
        const fmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
        const formattedMetrics = {
            total: { amount: fmt.format(metrics.total.amount), doors: metrics.total.doors.size, raw: metrics.total.amount },
            bucket0_30: { amount: fmt.format(metrics.bucket0_30.amount), doors: metrics.bucket0_30.doors.size, raw: metrics.bucket0_30.amount },
            bucket31_60: { amount: fmt.format(metrics.bucket31_60.amount), doors: metrics.bucket31_60.doors.size, raw: metrics.bucket31_60.amount },
            bucket61_90: { amount: fmt.format(metrics.bucket61_90.amount), doors: metrics.bucket61_90.doors.size, raw: metrics.bucket61_90.amount },
            bucket91_120: { amount: fmt.format(metrics.bucket91_120.amount), doors: metrics.bucket91_120.doors.size, raw: metrics.bucket91_120.amount },
            bucket121_150: { amount: fmt.format(metrics.bucket121_150.amount), doors: metrics.bucket121_150.doors.size, raw: metrics.bucket121_150.amount },
            bucket151_180: { amount: fmt.format(metrics.bucket151_180.amount), doors: metrics.bucket151_180.doors.size, raw: metrics.bucket151_180.amount },
            bucketOver180: { amount: fmt.format(metrics.bucketOver180.amount), doors: metrics.bucketOver180.doors.size, raw: metrics.bucketOver180.amount }
        };

        // Per-site metrics
        const siteMap = new Map();
        invoices.forEach(inv => {
            const site = inv.siteName || 'Unknown';
            if (!siteMap.has(site)) {
                siteMap.set(site, {
                    total: { amount: 0, doors: new Set() },
                    bucket0_30: { amount: 0, doors: new Set() },
                    bucket31_60: { amount: 0, doors: new Set() },
                    bucket61_90: { amount: 0, doors: new Set() },
                    bucket91_120: { amount: 0, doors: new Set() },
                    bucket121_150: { amount: 0, doors: new Set() },
                    bucket151_180: { amount: 0, doors: new Set() },
                    bucketOver180: { amount: 0, doors: new Set() }
                });
            }
            const sm = siteMap.get(site);
            const amt = inv.balanceAmount;
            const days = inv.agingDays;
            const code = inv.customerCode;
            sm.total.amount += amt;
            if (code) sm.total.doors.add(code);
            if (days <= 30) { sm.bucket0_30.amount += amt; if (code) sm.bucket0_30.doors.add(code); }
            else if (days <= 60) { sm.bucket31_60.amount += amt; if (code) sm.bucket31_60.doors.add(code); }
            else if (days <= 90) { sm.bucket61_90.amount += amt; if (code) sm.bucket61_90.doors.add(code); }
            else if (days <= 120) { sm.bucket91_120.amount += amt; if (code) sm.bucket91_120.doors.add(code); }
            else if (days <= 150) { sm.bucket121_150.amount += amt; if (code) sm.bucket121_150.doors.add(code); }
            else if (days <= 180) { sm.bucket151_180.amount += amt; if (code) sm.bucket151_180.doors.add(code); }
            else { sm.bucketOver180.amount += amt; if (code) sm.bucketOver180.doors.add(code); }
        });

        const siteMetrics = Array.from(siteMap.entries())
            .map(([name, sm]) => ({
                name,
                metrics: {
                    total: { amount: fmt.format(sm.total.amount), doors: sm.total.doors.size, raw: sm.total.amount },
                    bucket0_30: { amount: fmt.format(sm.bucket0_30.amount), doors: sm.bucket0_30.doors.size, raw: sm.bucket0_30.amount },
                    bucket31_60: { amount: fmt.format(sm.bucket31_60.amount), doors: sm.bucket31_60.doors.size, raw: sm.bucket31_60.amount },
                    bucket61_90: { amount: fmt.format(sm.bucket61_90.amount), doors: sm.bucket61_90.doors.size, raw: sm.bucket61_90.amount },
                    bucket91_120: { amount: fmt.format(sm.bucket91_120.amount), doors: sm.bucket91_120.doors.size, raw: sm.bucket91_120.amount },
                    bucket121_150: { amount: fmt.format(sm.bucket121_150.amount), doors: sm.bucket121_150.doors.size, raw: sm.bucket121_150.amount },
                    bucket151_180: { amount: fmt.format(sm.bucket151_180.amount), doors: sm.bucket151_180.doors.size, raw: sm.bucket151_180.amount },
                    bucketOver180: { amount: fmt.format(sm.bucketOver180.amount), doors: sm.bucketOver180.doors.size, raw: sm.bucketOver180.amount }
                }
            }))
            .sort((a, b) => b.metrics.total.raw - a.metrics.total.raw);

        // Category metrics (all users)
        let categoryMetrics = null;
        let recentMetrics = null;
        let keySiteMetrics = null;
        let subSiteMetrics = null;
        {
            const calcBuckets = (invs) => {
                const m = {
                    total: { a: 0, d: new Set() }, b0: { a: 0, d: new Set() }, b31: { a: 0, d: new Set() },
                    b61: { a: 0, d: new Set() }, b91: { a: 0, d: new Set() }, b121: { a: 0, d: new Set() },
                    b151: { a: 0, d: new Set() }, bOv: { a: 0, d: new Set() }
                };
                invs.forEach(inv => {
                    const a = inv.balanceAmount, days = inv.agingDays, c = inv.customerCode;
                    m.total.a += a; if (c) m.total.d.add(c);
                    if (days <= 30)       { m.b0.a += a;   if (c) m.b0.d.add(c); }
                    else if (days <= 60)  { m.b31.a += a;  if (c) m.b31.d.add(c); }
                    else if (days <= 90)  { m.b61.a += a;  if (c) m.b61.d.add(c); }
                    else if (days <= 120) { m.b91.a += a;  if (c) m.b91.d.add(c); }
                    else if (days <= 150) { m.b121.a += a; if (c) m.b121.d.add(c); }
                    else if (days <= 180) { m.b151.a += a; if (c) m.b151.d.add(c); }
                    else                  { m.bOv.a += a;  if (c) m.bOv.d.add(c); }
                });
                const f = (v) => fmt.format(v);
                return {
                    total:        { amount: f(m.total.a), doors: m.total.d.size, raw: m.total.a },
                    bucket0_30:   { amount: f(m.b0.a),    doors: m.b0.d.size,    raw: m.b0.a },
                    bucket31_60:  { amount: f(m.b31.a),   doors: m.b31.d.size,   raw: m.b31.a },
                    bucket61_90:  { amount: f(m.b61.a),   doors: m.b61.d.size,   raw: m.b61.a },
                    bucket91_120: { amount: f(m.b91.a),   doors: m.b91.d.size,   raw: m.b91.a },
                    bucket121_150:{ amount: f(m.b121.a),  doors: m.b121.d.size,  raw: m.b121.a },
                    bucket151_180:{ amount: f(m.b151.a),  doors: m.b151.d.size,  raw: m.b151.a },
                    bucketOver180:{ amount: f(m.bOv.a),   doors: m.bOv.d.size,   raw: m.bOv.a }
                };
            };

            const [kaInv, sdInv] = await Promise.all([
                keyAccountCodes.length   > 0 ? prisma.invoice.findMany({ where: { status: 'ACTIVE', customerCode: { in: keyAccountCodes,   notIn: disputedCodesAll } }, select: { balanceAmount: true, agingDays: true, customerCode: true, siteName: true } }) : [],
                subDistributorCodes.length > 0 ? prisma.invoice.findMany({ where: { status: 'ACTIVE', customerCode: { in: subDistributorCodes, notIn: disputedCodesAll } }, select: { balanceAmount: true, agingDays: true, customerCode: true, siteName: true } }) : []
            ]);

            // Per-site category totals — attach breakdown to each siteMetric
            const siteKAMap = new Map(), siteSDMap = new Map();
            const siteKADoors = new Map(), siteSDDoors = new Map();
            kaInv.forEach(inv => { const s = inv.siteName || 'Unknown'; siteKAMap.set(s, (siteKAMap.get(s) || 0) + inv.balanceAmount); if (!siteKADoors.has(s)) siteKADoors.set(s, new Set()); siteKADoors.get(s).add(inv.customerCode); });
            sdInv.forEach(inv => { const s = inv.siteName || 'Unknown'; siteSDMap.set(s, (siteSDMap.get(s) || 0) + inv.balanceAmount); if (!siteSDDoors.has(s)) siteSDDoors.set(s, new Set()); siteSDDoors.get(s).add(inv.customerCode); });
            siteMetrics.forEach(s => {
                s.breakdown = {
                    nonKey:      s.metrics.total.raw,
                    nonKeyDoors: s.metrics.total.doors,
                    key:         siteKAMap.get(s.name) || 0,
                    keyDoors:    siteKADoors.get(s.name) ? siteKADoors.get(s.name).size : 0,
                    sub:         siteSDMap.get(s.name) || 0,
                    subDoors:    siteSDDoors.get(s.name) ? siteSDDoors.get(s.name).size : 0
                };
            });

            categoryMetrics = [
                { label: 'Key Accounts',     link: '/ar/directory?keyOnly=1',  metrics: calcBuckets(kaInv) },
                { label: 'Sub Distributors', link: '/ar/directory?subOnly=1', metrics: calcBuckets(sdInv) },
                { label: 'Non-Key',          link: '/ar/directory',        metrics: calcBuckets(invoices) }
            ];

            // Per-site aging for Key Accounts and Sub Distributors
            const buildSiteMetrics = (invs) => {
                const map = new Map();
                invs.forEach(inv => {
                    const site = inv.siteName || 'Unknown';
                    if (!map.has(site)) map.set(site, {
                        total:{a:0,d:new Set()}, b0:{a:0,d:new Set()}, b31:{a:0,d:new Set()},
                        b61:{a:0,d:new Set()}, b91:{a:0,d:new Set()}, b121:{a:0,d:new Set()},
                        b151:{a:0,d:new Set()}, bOv:{a:0,d:new Set()}
                    });
                    const sm = map.get(site);
                    const a = inv.balanceAmount, days = inv.agingDays, c = inv.customerCode;
                    sm.total.a += a; if (c) sm.total.d.add(c);
                    if (days <= 30)       { sm.b0.a += a;   if (c) sm.b0.d.add(c); }
                    else if (days <= 60)  { sm.b31.a += a;  if (c) sm.b31.d.add(c); }
                    else if (days <= 90)  { sm.b61.a += a;  if (c) sm.b61.d.add(c); }
                    else if (days <= 120) { sm.b91.a += a;  if (c) sm.b91.d.add(c); }
                    else if (days <= 150) { sm.b121.a += a; if (c) sm.b121.d.add(c); }
                    else if (days <= 180) { sm.b151.a += a; if (c) sm.b151.d.add(c); }
                    else                  { sm.bOv.a += a;  if (c) sm.bOv.d.add(c); }
                });
                return Array.from(map.entries())
                    .map(([name, sm]) => ({ name, metrics: {
                        total:        { amount: fmt.format(sm.total.a), doors: sm.total.d.size, raw: sm.total.a },
                        bucket0_30:   { amount: fmt.format(sm.b0.a),    doors: sm.b0.d.size,    raw: sm.b0.a },
                        bucket31_60:  { amount: fmt.format(sm.b31.a),   doors: sm.b31.d.size,   raw: sm.b31.a },
                        bucket61_90:  { amount: fmt.format(sm.b61.a),   doors: sm.b61.d.size,   raw: sm.b61.a },
                        bucket91_120: { amount: fmt.format(sm.b91.a),   doors: sm.b91.d.size,   raw: sm.b91.a },
                        bucket121_150:{ amount: fmt.format(sm.b121.a),  doors: sm.b121.d.size,  raw: sm.b121.a },
                        bucket151_180:{ amount: fmt.format(sm.b151.a),  doors: sm.b151.d.size,  raw: sm.b151.a },
                        bucketOver180:{ amount: fmt.format(sm.bOv.a),   doors: sm.bOv.d.size,   raw: sm.bOv.a }
                    }}))
                    .sort((a, b) => b.metrics.total.raw - a.metrics.total.raw);
            };
            keySiteMetrics = buildSiteMetrics(kaInv);
            subSiteMetrics = buildSiteMetrics(sdInv);

            // Kosca AR total — Key Accounts + Sub Distributors + Non-Key
            const koscaInvoices = [...kaInv, ...sdInv, ...invoices];
            const koscaTotal = koscaInvoices.reduce((sum, i) => sum + i.balanceAmount, 0);
            const koscaCustomerCodes = [...new Set(koscaInvoices.map(i => i.customerCode))];
            recentMetrics = {
                total: {
                    amount: fmt.format(koscaTotal),
                    doors: koscaCustomerCodes.length,
                    raw: koscaTotal
                }
            };
        }

        // Unknown customers — distinct codes with no siteName, excluding key accounts and sub distributors
        const unknownRows = await prisma.invoice.findMany({
            where: { status: 'ACTIVE', siteName: null, customerCode: { notIn: excludedCodes } },
            select: { customerCode: true, customerName: true },
            distinct: ['customerCode']
        });
        const unknownCustomers = unknownRows.map(r => ({ customerCode: r.customerCode, customerName: r.customerName }));

        // Available site names for the dropdown
        const siteNames = siteMetrics.map(s => s.name).filter(n => n !== 'Unknown');

        // Index of the Unknown tab (1-based, tab 0 = All Sites)
        const unknownTabIndex = siteMetrics.findIndex(s => s.name === 'Unknown') + 1;

        // Disputed customers metrics
        let disputedMetrics = null;
        if (disputedCodesAll.length > 0) {
            const disputedInvoices = await prisma.invoice.findMany({
                where: { customerCode: { in: disputedCodesAll }, status: 'ACTIVE' },
                select: { balanceAmount: true, customerCode: true }
            });
            const disputedTotal = disputedInvoices.reduce((s, i) => s + i.balanceAmount, 0);
            const disputedDoors = new Set(disputedInvoices.map(i => i.customerCode)).size;

            disputedMetrics = {
                total: { amount: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(disputedTotal), doors: disputedDoors, raw: disputedTotal }
            };
        }

        const keyMetrics  = categoryMetrics ? categoryMetrics[0].metrics : null;
        const subMetrics  = categoryMetrics ? categoryMetrics[1].metrics : null;

        const distinctGroupsDash = await prisma.customerGroup.findMany({ distinct: ['groupName'], select: { groupName: true } });
        const groupCount = distinctGroupsDash.length;

        // Previous-month category metrics — active invoices raised on or before last day of prev month
        let prevMonthCategories = null;
        let prevMonthOverall = null;
        let prevMonthDateLabel = null;
        {
            const now = new Date();
            const lastDayPrevMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
            prevMonthDateLabel = lastDayPrevMonth.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

            const prevMonthWhere = { status: 'ACTIVE', invoiceDate: { lte: lastDayPrevMonth } };
            const prevSelect = { balanceAmount: true, customerCode: true };

            const [pmKaInv, pmSdInv, pmNkInv] = await Promise.all([
                keyAccountCodes.length > 0
                    ? prisma.invoice.findMany({ where: { ...prevMonthWhere, customerCode: { in: keyAccountCodes, notIn: disputedCodesAll } }, select: prevSelect })
                    : [],
                subDistributorCodes.length > 0
                    ? prisma.invoice.findMany({ where: { ...prevMonthWhere, customerCode: { in: subDistributorCodes, notIn: disputedCodesAll } }, select: prevSelect })
                    : [],
                prisma.invoice.findMany({ where: { ...prevMonthWhere, customerCode: { notIn: excludedCodes } }, select: prevSelect })
            ]);

            const sumCat = (invs) => {
                let total = 0;
                const doors = new Set();
                invs.forEach(i => { total += i.balanceAmount; doors.add(i.customerCode); });
                return { total, doors };
            };

            const ka = sumCat(pmKaInv), sd = sumCat(pmSdInv), nk = sumCat(pmNkInv);
            const overallTotal = ka.total + sd.total + nk.total;
            const overallDoors = new Set([...ka.doors, ...sd.doors, ...nk.doors]);

            prevMonthCategories = [
                { label: 'Key Accounts', metrics: { total: { amount: fmt.format(ka.total), doors: ka.doors.size, raw: ka.total } } },
                { label: 'Sub Distributors', metrics: { total: { amount: fmt.format(sd.total), doors: sd.doors.size, raw: sd.total } } },
                { label: 'Non-Key', metrics: { total: { amount: fmt.format(nk.total), doors: nk.doors.size, raw: nk.total } } }
            ];
            prevMonthOverall = { total: { amount: fmt.format(overallTotal), doors: overallDoors.size, raw: overallTotal } };
        }

        res.render('dashboard', { metrics: formattedMetrics, siteMetrics, keySiteMetrics, subSiteMetrics, keyMetrics, subMetrics, lastUpdated, arImportedAt, arFileDate, cmImportedAt, cmFileDate, unknownCustomers, siteNames, unknownTabIndex, categoryMetrics, recentMetrics, disputedMetrics, groupCount, prevMonthCategories, prevMonthOverall, prevMonthDateLabel });
    } catch (error) {
        logger.error({ err: error, route: 'GET /ar' }, 'Error fetching dashboard metrics');
        res.status(500).send('Error loading dashboard metrics');
    }
});

module.exports = router;
