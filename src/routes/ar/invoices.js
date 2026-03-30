// src/routes/ar/invoices.js
const express = require('express');
const router = express.Router();
const prisma = require('../../prisma');
const { requireAuth, requireModule } = require('../../middleware/auth');
const { requireInvoicesAccess } = require('./_shared');
const { SUB_DISTRIBUTOR_CODES, getKeyAccountCodes } = require('../../config/categories');
const logger = require('../../logger');

// Render HTMX Table Partial — Grouped by Customer Code
router.get('/ar/invoices', requireAuth, requireInvoicesAccess, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 200);
    const search = req.query.search || '';
    // Flatten handles duplicate params (e.g. keyOnly=1 in URL + hx-include hidden input).
    const keyOnly = [req.query.keyOnly].flat().includes('1');
    const subOnly = [req.query.subOnly].flat().includes('1');
    const psOnly = req.query.ps_only === '1';
    const sort = req.query.sort || 'balance_desc';
    const isNameSort = sort === 'name_asc' || sort === 'name_desc';
    const sortOrderMap = {
        balance_asc: { _sum: { balanceAmount: 'asc' } },
        aging_desc: { _max: { agingDays: 'desc' } },
        aging_asc: { _max: { agingDays: 'asc' } },
        count_desc: { _count: { id: 'desc' } },
    };
    const dbOrderBy = sortOrderMap[sort] || { _sum: { balanceAmount: 'desc' } };

    const bucketRaw = req.query.bucket
        ? (Array.isArray(req.query.bucket) ? req.query.bucket : [req.query.bucket]).filter(Boolean)
        : [];
    const bucket = bucketRaw.length === 1 ? bucketRaw[0] : '';
    const sites = req.query.site ? (Array.isArray(req.query.site) ? req.query.site : [req.query.site]) : [];
    const psrs = [
        ...(req.query.psr ? (Array.isArray(req.query.psr) ? req.query.psr : [req.query.psr]) : []),
        ...(req.query.psr_badge ? [req.query.psr_badge] : []),
    ].filter((v, i, a) => v && a.indexOf(v) === i);
    const groups_param = req.query.group
        ? [...new Set((Array.isArray(req.query.group) ? req.query.group : [req.query.group]).filter(Boolean))]
        : [];
    const group = groups_param.length === 1 ? groups_param[0] : '';

    const skip = (page - 1) * limit;

    const bucketRanges = {
        '0_30': { lte: 30 },
        '31_60': { gte: 31, lte: 60 },
        '61_90': { gte: 61, lte: 90 },
        '91_120': { gte: 91, lte: 120 },
        '121_150': { gte: 121, lte: 150 },
        '151_180': { gte: 151, lte: 180 },
        over_180: { gt: 180 },
    };

    try {
        // Fetch key account codes dynamically (name-prefix match) and use config sub-d codes
        const [keyAccountCodes, disputedRows] = await Promise.all([
            getKeyAccountCodes(prisma),
            prisma.customerDispute.findMany({ select: { customerCode: true } }),
        ]);
        const subDistributorCodes = SUB_DISTRIBUTOR_CODES;
        const disputedCodes = disputedRows.map((d) => d.customerCode);
        const excludedCodes = [...keyAccountCodes, ...subDistributorCodes, ...disputedCodes];

        // Fetch customer codes matching the bucket filter (if any)
        let bucketCodes = null;
        const activeBuckets = bucketRaw.filter((b) => bucketRanges[b]);
        if (activeBuckets.length > 0) {
            const bucketInvoices = await prisma.invoice.findMany({
                where: { OR: activeBuckets.map((b) => ({ agingDays: bucketRanges[b], status: 'ACTIVE' })) },
                select: { customerCode: true },
                distinct: ['customerCode'],
            });
            bucketCodes = bucketInvoices.map((i) => i.customerCode);
        }

        // Compute final allowed codes (site filter applied directly in WHERE, not via code list)
        let finalCodes = null; // null = no positive restriction (use notIn for non-key)

        if (keyOnly) {
            finalCodes = keyAccountCodes.filter((c) => !disputedCodes.includes(c));
            if (bucketCodes) finalCodes = finalCodes.filter((c) => bucketCodes.includes(c));
            if (!finalCodes.length) finalCodes = ['__no_match__'];
        } else if (subOnly) {
            finalCodes = subDistributorCodes.filter((c) => !disputedCodes.includes(c));
            if (bucketCodes) finalCodes = finalCodes.filter((c) => bucketCodes.includes(c));
            if (!finalCodes.length) finalCodes = ['__no_match__'];
        } else if (req.session.userRole === 'USER') {
            const assignments = await prisma.customerAssignment.findMany({
                where: { userId: req.session.userId },
                select: { customerCode: true },
            });
            finalCodes = assignments.map((a) => a.customerCode).filter((c) => !excludedCodes.includes(c));
            if (bucketCodes) finalCodes = finalCodes.filter((c) => bucketCodes.includes(c));
        } else if (bucketCodes) {
            finalCodes = bucketCodes.filter((c) => !excludedCodes.includes(c));
        }

        if (psrs.length > 0) {
            const psrMatches = await prisma.customerMaster.findMany({
                where: { psrName: { in: psrs } },
                select: { customerCode: true },
            });
            const psrCodes = psrMatches.map((cm) => cm.customerCode);
            if (finalCodes !== null) {
                finalCodes = finalCodes.filter((c) => psrCodes.includes(c));
            } else {
                finalCodes = psrCodes.filter((c) => !excludedCodes.includes(c));
            }
        }

        const canPS =
            req.session.userRole === 'ADMIN' || (req.session.userModules || []).includes('ar_pending_settlement');
        if (canPS && psOnly) {
            const psCodes = await prisma.pendingSettlement.findMany({
                select: { customerCode: true },
                distinct: ['customerCode'],
            });
            const psCodeList = psCodes.map((r) => r.customerCode);
            if (finalCodes !== null) {
                finalCodes = finalCodes.filter((c) => psCodeList.includes(c));
            } else {
                finalCodes = psCodeList.filter((c) => !excludedCodes.includes(c));
            }
            if (!finalCodes.length) finalCodes = ['__no_match__'];
        }

        const assignedCodeFilter =
            finalCodes !== null
                ? { customerCode: { in: finalCodes.length ? finalCodes : ['__no_match__'] } }
                : { customerCode: { notIn: excludedCodes } };

        const searchFilter = search
            ? {
                  OR: [
                      { customerName: { contains: search, mode: 'insensitive' } },
                      { customerCode: { contains: search, mode: 'insensitive' } },
                      { invoiceNo: { contains: search, mode: 'insensitive' } },
                  ],
              }
            : {};

        // Build final WHERE — site filter applied directly on siteName so invoices are scoped per-site
        const conditions = [assignedCodeFilter, { status: 'ACTIVE' }];
        if (sites.length === 1) conditions.push({ siteName: sites[0] });
        else if (sites.length > 1) conditions.push({ siteName: { in: sites } });
        if (activeBuckets.length > 0) {
            conditions.push({ OR: activeBuckets.map((b) => ({ agingDays: bucketRanges[b] })) });
        }
        if (search) conditions.push(searchFilter);
        if (groups_param.length > 0) {
            const groupRows = await prisma.customerGroup.findMany({
                where: { groupName: { in: groups_param } },
                select: { customerCode: true },
            });
            const groupCodes = groupRows.map((r) => r.customerCode);
            conditions.push({ customerCode: { in: groupCodes.length ? groupCodes : ['__no_match__'] } });
        }
        const finalWhere = { AND: conditions };

        // Group by customer — fetch raw invoices for the paginated page and aggregate in memory.

        let customerCodesToFetch;
        let totalGroups;

        if (isNameSort) {
            const allCodeGroups = await prisma.invoice.groupBy({ by: ['customerCode'], where: finalWhere });
            totalGroups = allCodeGroups.length;
            const allCodesArr = allCodeGroups.map((c) => c.customerCode);
            const sortNameMasters = await prisma.customerMaster.findMany({
                where: { customerCode: { in: allCodesArr } },
                select: { customerCode: true, customerName: true },
            });
            const sortNameMap = {};
            sortNameMasters.forEach((cm) => {
                if (cm.customerName) sortNameMap[cm.customerCode] = cm.customerName;
            });
            allCodeGroups.sort((a, b) => {
                const na = (sortNameMap[a.customerCode] || a.customerCode).toLowerCase();
                const nb = (sortNameMap[b.customerCode] || b.customerCode).toLowerCase();
                return sort === 'name_asc' ? na.localeCompare(nb) : nb.localeCompare(na);
            });
            customerCodesToFetch = allCodeGroups.slice(skip, skip + limit);
        } else {
            customerCodesToFetch = await prisma.invoice.groupBy({
                by: ['customerCode'],
                where: finalWhere,
                skip,
                take: limit,
                orderBy: dbOrderBy,
            });
            const countResult = await prisma.invoice.groupBy({ by: ['customerCode'], where: finalWhere });
            totalGroups = countResult.length;
        }

        const codes = customerCodesToFetch.map((c) => c.customerCode);

        const rawInvoices = await prisma.invoice.findMany({
            where: {
                ...finalWhere,
                customerCode: { in: codes },
            },
        });

        // Group in memory for the current page
        const groupedMap = new Map();
        rawInvoices.forEach((inv) => {
            if (!groupedMap.has(inv.customerCode)) {
                groupedMap.set(inv.customerCode, {
                    customerCode: inv.customerCode,
                    customerName: inv.customerName,
                    _sum: { invoiceAmount: 0, balanceAmount: 0 },
                    _count: { id: 0 },
                    _max: { agingDays: 0 },
                    siteNames: new Set(),
                });
            }
            const g = groupedMap.get(inv.customerCode);
            g._sum.invoiceAmount += inv.invoiceAmount || inv.balanceAmount;
            g._sum.balanceAmount += inv.balanceAmount;
            g._count.id += 1;
            if (inv.agingDays > g._max.agingDays) g._max.agingDays = inv.agingDays;
            if (inv.siteName) g.siteNames.add(inv.siteName);
        });

        const inMemorySortFns = {
            balance_asc: (a, b) => a._sum.balanceAmount - b._sum.balanceAmount,
            aging_desc: (a, b) => b._max.agingDays - a._max.agingDays,
            aging_asc: (a, b) => a._max.agingDays - b._max.agingDays,
            count_desc: (a, b) => b._count.id - a._count.id,
            name_asc: (a, b) =>
                (a.customerName || a.customerCode)
                    .toLowerCase()
                    .localeCompare((b.customerName || b.customerCode).toLowerCase()),
            name_desc: (a, b) =>
                (b.customerName || b.customerCode)
                    .toLowerCase()
                    .localeCompare((a.customerName || a.customerCode).toLowerCase()),
        };
        const sortFn = inMemorySortFns[sort] || ((a, b) => b._sum.balanceAmount - a._sum.balanceAmount);
        const grouped = Array.from(groupedMap.values()).sort(sortFn);
        grouped.forEach((g) => {
            g.siteNames = Array.from(g.siteNames);
        });

        // Fetch mobile numbers from CustomerMaster for the current page
        const customerMasters = await prisma.customerMaster.findMany({
            where: { customerCode: { in: codes } },
            select: {
                customerCode: true,
                mobileNo: true,
                phone: true,
                mobileNoLocked: true,
                masterMobileNo: true,
                psrName: true,
            },
        });
        const mobileMap = {};
        customerMasters.forEach((cm) => {
            mobileMap[cm.customerCode] = {
                number: cm.mobileNo || cm.phone || null,
                locked: cm.mobileNoLocked,
                masterMobileNo: cm.masterMobileNo,
                psrName: cm.psrName || null,
            };
        });
        grouped.forEach((g) => {
            const cm = mobileMap[g.customerCode] || {};
            g.mobileNo = cm.number || null;
            g.mobileNoLocked = cm.locked || false;
            g.masterMobileNo = cm.masterMobileNo || null;
            g.psrName = cm.psrName || null;
        });

        const totalPages = Math.ceil(totalGroups / limit);

        // For ADMIN/MANAGER: fetch officers and current assignments for inline assign
        let officers = [];
        let assignmentMap = {};
        const sessionRole = req.session.userRole;
        const sessionModules = req.session.userModules || [];
        const canAssign = sessionRole === 'ADMIN' || sessionModules.includes('ar_assign');
        if (canAssign) {
            [officers] = await Promise.all([
                prisma.user.findMany({
                    where: { role: 'USER', modules: { has: 'ar_directory' } },
                    select: { id: true, name: true },
                    orderBy: { name: 'asc' },
                }),
            ]);
            const existingAssignments = await prisma.customerAssignment.findMany({
                where: { customerCode: { in: codes } },
                select: { customerCode: true, userId: true },
            });
            existingAssignments.forEach((a) => {
                if (!assignmentMap[a.customerCode]) assignmentMap[a.customerCode] = [];
                assignmentMap[a.customerCode].push(a.userId);
            });
        }
        grouped.forEach((g) => {
            g.assignedOfficerIds = assignmentMap[g.customerCode] || [];
        });

        // Mark disputed customers
        const disputedRecords = await prisma.customerDispute.findMany({
            where: { customerCode: { in: codes } },
            select: { customerCode: true },
        });
        const disputedSet = new Set(disputedRecords.map((d) => d.customerCode));
        grouped.forEach((g) => {
            g.isDisputed = disputedSet.has(g.customerCode);
        });

        // Mark customers with pending settlement (only if user has the module)
        if (canPS) {
            const psRecords = await prisma.pendingSettlement.findMany({
                where: { customerCode: { in: codes } },
                select: { customerCode: true },
                distinct: ['customerCode'],
            });
            const psSet = new Set(psRecords.map((r) => r.customerCode));
            grouped.forEach((g) => {
                g.hasPendingSettlement = psSet.has(g.customerCode);
            });
        }

        // Fetch customer group names
        const groupRecords = await prisma.customerGroup.findMany({
            where: { customerCode: { in: codes } },
            select: { customerCode: true, groupName: true },
        });
        const groupNameMap = {};
        groupRecords.forEach((r) => {
            groupNameMap[r.customerCode] = r.groupName;
        });
        grouped.forEach((g) => {
            g.groupName = groupNameMap[g.customerCode] || null;
        });

        res.render('partials/table', {
            groups: grouped,
            page,
            totalPages,
            totalGroups,
            search,
            limit,
            userRole: req.session.userRole,
            keyOnly,
            subOnly,
            psOnly,
            bucket,
            sites,
            officers,
            sort,
            psrs,
            group,
        });
    } catch (error) {
        logger.error({ err: error, route: 'GET /ar/invoices' }, 'Error fetching invoices');
        res.status(500).send('<div class="text-red-500">Error loading table data</div>');
    }
});

// Render detail rows for a specific customer code (HTMX lazy-load)
router.get('/ar/invoices/:customerCode', requireAuth, requireModule('ar_directory'), async (req, res) => {
    try {
        const sitesParam = req.query.site ? (Array.isArray(req.query.site) ? req.query.site : [req.query.site]) : [];
        const bucketRanges = {
            '0_30': { lte: 30 },
            '31_60': { gte: 31, lte: 60 },
            '61_90': { gte: 61, lte: 90 },
            '91_120': { gte: 91, lte: 120 },
            '121_150': { gte: 121, lte: 150 },
            '151_180': { gte: 151, lte: 180 },
            over_180: { gt: 180 },
        };
        const bucketRaw = req.query.bucket
            ? (Array.isArray(req.query.bucket) ? req.query.bucket : [req.query.bucket]).filter(Boolean)
            : [];
        const activeBuckets = bucketRaw.filter((b) => bucketRanges[b]);

        const conditions = [{ customerCode: req.params.customerCode }];
        if (sitesParam.length === 1) conditions.push({ siteName: sitesParam[0] });
        else if (sitesParam.length > 1) conditions.push({ siteName: { in: sitesParam } });
        if (activeBuckets.length > 0) {
            conditions.push({ OR: activeBuckets.map((b) => ({ agingDays: bucketRanges[b] })) });
        }
        const where = { AND: conditions };
        const invoices = await prisma.invoice.findMany({
            where,
            orderBy: { agingDays: 'desc' },
        });
        // Fetch mobile and customer name for share functionality
        const customerCode = req.params.customerCode;
        const cm = await prisma.customerMaster.findUnique({
            where: { customerCode },
            select: { customerName: true, mobileNo: true, phone: true, psrName: true },
        });
        const customerName = cm?.customerName || invoices[0]?.customerName || customerCode;
        const mobileNo = cm?.mobileNo || cm?.phone || null;
        const psrName = cm?.psrName || null;
        const isAdmin = req.session.userRole === 'ADMIN' || (req.session.userModules || []).includes('ar_groups');
        const [disputeRecord, groupRecord, allGroupRows] = await Promise.all([
            prisma.customerDispute.findUnique({ where: { customerCode } }),
            prisma.customerGroup.findUnique({ where: { customerCode }, select: { groupName: true } }),
            isAdmin
                ? prisma.customerGroup.findMany({
                      select: { groupName: true },
                      distinct: ['groupName'],
                      orderBy: { groupName: 'asc' },
                  })
                : [],
        ]);
        const isDisputed = !!disputeRecord;
        const currentGroup = groupRecord?.groupName || null;
        const allGroups = allGroupRows.map((g) => g.groupName);

        const view = req.headers['hx-request'] ? 'partials/invoice_details' : 'ar/customer_invoices';
        res.render(view, {
            invoices,
            customerName,
            mobileNo,
            customerCode,
            isDisputed,
            userRole: req.session.userRole,
            isAdmin,
            currentGroup,
            allGroups,
            psrName,
        });
    } catch (error) {
        logger.error(
            { err: error, route: 'GET /ar/invoices/:customerCode', customerCode: req.params.customerCode },
            'Error fetching invoice details'
        );
        res.status(500).send(
            '<tr><td colspan="5" class="text-red-500 text-center py-2">Error loading details</td></tr>'
        );
    }
});

module.exports = router;
