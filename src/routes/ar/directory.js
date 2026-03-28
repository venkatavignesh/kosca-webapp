// src/routes/ar/directory.js
const express = require('express');
const router = express.Router();
const prisma = require('../../prisma');
const { requireAuth, requireModule } = require('../../middleware/auth');
const { SUB_DISTRIBUTOR_CODES, getKeyAccountCodes } = require('../../config/categories');
const logger = require('../../logger');
const { cached } = require('../../cache');

const escHtml = (s) =>
    String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

// Render AR Directory (Table View)
router.get('/ar/directory', requireAuth, requireModule('ar_directory'), async (req, res) => {
    const bucket = req.query.bucket || '';
    const selectedSites = req.query.site ? (Array.isArray(req.query.site) ? req.query.site : [req.query.site]) : [];
    // Cached filter data — rebuilt every 5 minutes, not on every request
    const allSiteNames = await cached('directory:sites', async () => {
        const rows = await prisma.invoice.findMany({
            where: { status: 'ACTIVE', siteName: { not: null } },
            select: { siteName: true },
            distinct: ['siteName'],
        });
        return rows
            .map((r) => r.siteName)
            .filter(Boolean)
            .sort();
    });

    const keyOnly = req.query.keyOnly === '1';
    const subOnly = req.query.subOnly === '1';
    const psOnly = req.query.ps_only === '1';

    const selectedPsrs = req.query.psr ? (Array.isArray(req.query.psr) ? req.query.psr : [req.query.psr]) : [];

    // Cached PSR → sites map
    const allPsrData = await cached('directory:psrData', async () => {
        const psrMasters = await prisma.customerMaster.findMany({
            where: { psrName: { not: null } },
            select: { customerCode: true, psrName: true },
        });
        const psrCodeMap = {};
        psrMasters.forEach((cm) => {
            psrCodeMap[cm.customerCode] = cm.psrName;
        });
        const psrCodes = Object.keys(psrCodeMap);
        const sitePsrRows = psrCodes.length
            ? await prisma.invoice.findMany({
                  where: { customerCode: { in: psrCodes }, status: 'ACTIVE' },
                  select: { customerCode: true, siteName: true },
                  distinct: ['customerCode', 'siteName'],
              })
            : [];
        const psrSiteMap = {};
        sitePsrRows.forEach((row) => {
            const psr = psrCodeMap[row.customerCode];
            if (psr) {
                if (!psrSiteMap[psr]) psrSiteMap[psr] = new Set();
                if (row.siteName) psrSiteMap[psr].add(row.siteName);
            }
        });
        return Object.entries(psrSiteMap)
            .map(([psrName, sites]) => ({ psrName, sites: Array.from(sites).sort() }))
            .sort((a, b) => a.psrName.localeCompare(b.psrName));
    });

    // Cached group → sites map
    const { allGroupData: allGroupDataRaw, groupCount } = await cached('directory:groupData', async () => {
        const allGroupEntries = await prisma.customerGroup.findMany({
            select: { groupName: true, customerCode: true },
            orderBy: { groupName: 'asc' },
        });
        const groupCodeMap = {};
        allGroupEntries.forEach((e) => {
            if (!groupCodeMap[e.groupName]) groupCodeMap[e.groupName] = [];
            groupCodeMap[e.groupName].push(e.customerCode);
        });
        const allGroupCodes = allGroupEntries.map((e) => e.customerCode);
        const groupSiteRows = allGroupCodes.length
            ? await prisma.invoice.findMany({
                  where: { customerCode: { in: allGroupCodes }, status: 'ACTIVE' },
                  select: { customerCode: true, siteName: true },
                  distinct: ['customerCode', 'siteName'],
              })
            : [];
        const codeSiteMap = {};
        groupSiteRows.forEach((r) => {
            if (r.siteName) {
                if (!codeSiteMap[r.customerCode]) codeSiteMap[r.customerCode] = new Set();
                codeSiteMap[r.customerCode].add(r.siteName);
            }
        });
        const gd = Object.keys(groupCodeMap)
            .sort()
            .map((gn) => {
                const sites = new Set();
                groupCodeMap[gn].forEach((c) => {
                    if (codeSiteMap[c]) codeSiteMap[c].forEach((s) => sites.add(s));
                });
                return { groupName: gn, sites: Array.from(sites).sort() };
            });
        return { allGroupData: gd, groupCount: gd.length };
    });
    const allGroupData = allGroupDataRaw;
    const selectedGroup = req.query.group || '';

    res.render('ar/directory', {
        bucket,
        selectedSites,
        allSiteNames,
        keyOnly,
        subOnly,
        psOnly,
        groupCount,
        allGroupData,
        selectedGroup,
        allPsrData,
        selectedPsrs,
    });
});

// Groups page
router.get('/ar/groups', requireAuth, requireModule('ar_directory'), (req, res) => {
    const defaultTab = ['key', 'sub', 'nonkey', 'ungrouped'].includes(req.query.tab) ? req.query.tab : 'key';
    res.render('ar/groups', { defaultTab });
});

// Groups data (HTMX) — collapsible groups per classification tab
router.get('/ar/groups-data', requireAuth, requireModule('ar_directory'), async (req, res) => {
    const tab = req.query.tab || 'key';
    const isAdmin = req.session.userRole === 'ADMIN' || (req.session.userModules || []).includes('ar_groups');
    const canPS = req.session.userRole === 'ADMIN' || (req.session.userModules || []).includes('ar_pending_settlement');
    try {
        // ── Ungrouped tab: non-key, non-sub customers not yet in any group ──
        if (tab === 'ungrouped') {
            const [keyAccountCodes, groupedRows, allCustRows] = await Promise.all([
                getKeyAccountCodes(prisma),
                prisma.customerGroup.findMany({ select: { customerCode: true } }),
                prisma.invoice.findMany({
                    where: { status: 'ACTIVE' },
                    select: { customerCode: true },
                    distinct: ['customerCode'],
                }),
            ]);
            const excludeSet = new Set([
                ...groupedRows.map((r) => r.customerCode),
                ...keyAccountCodes,
                ...SUB_DISTRIBUTOR_CODES,
            ]);
            const ungroupedCodes = allCustRows
                .map((r) => r.customerCode)
                .filter((c) => !excludeSet.has(c))
                .sort();
            if (ungroupedCodes.length === 0) {
                return res.send(
                    '<div class="py-12 text-center text-sm text-gray-400">All non-key customers have been assigned to a group.</div>'
                );
            }
            const [invSummary, masterRows, allGroups] = await Promise.all([
                prisma.invoice.groupBy({
                    by: ['customerCode'],
                    where: { customerCode: { in: ungroupedCodes }, status: 'ACTIVE' },
                    _count: { _all: true },
                    _sum: { balanceAmount: true },
                    _max: { agingDays: true },
                }),
                prisma.customerMaster.findMany({
                    where: { customerCode: { in: ungroupedCodes } },
                    select: { customerCode: true, customerName: true },
                }),
                isAdmin
                    ? prisma.customerGroup.findMany({
                          select: { groupName: true },
                          distinct: ['groupName'],
                          orderBy: { groupName: 'asc' },
                      })
                    : [],
            ]);
            const invMap = {};
            for (const r of invSummary)
                invMap[r.customerCode] = {
                    count: r._count._all,
                    balance: r._sum.balanceAmount || 0,
                    maxAging: r._max.agingDays || 0,
                };
            ungroupedCodes.sort((a, b) => (invMap[b]?.balance || 0) - (invMap[a]?.balance || 0));
            const mMap = {};
            for (const r of masterRows) mMap[r.customerCode] = r;
            let psSetUngrouped = new Set();
            if (canPS) {
                const psRecs = await prisma.pendingSettlement.findMany({
                    where: { customerCode: { in: ungroupedCodes } },
                    select: { customerCode: true },
                    distinct: ['customerCode'],
                });
                psSetUngrouped = new Set(psRecs.map((r) => r.customerCode));
            }
            const fmt = (n) => '₹' + (n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
            const agingBadge = (d) => {
                if (!d)
                    return '<span class="inline-flex items-center justify-center w-14 text-xs text-gray-300 dark:text-gray-600">—</span>';
                const cls =
                    d > 90
                        ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-400 dark:border-red-800'
                        : d > 60
                          ? 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950 dark:text-orange-400 dark:border-orange-800'
                          : d > 30
                            ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-800'
                            : 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-400 dark:border-blue-800';
                return `<span class="inline-flex items-center justify-center rounded-full border w-14 py-0.5 text-[10px] font-bold ${cls}">${d}d</span>`;
            };
            const groupOptions = allGroups
                .map(
                    (g) =>
                        `<option value="${g.groupName.replace(/"/g, '&quot;')}">${g.groupName.replace(/</g, '&lt;')}</option>`
                )
                .join('');
            let rowsHtml = '';
            for (const code of ungroupedCodes) {
                const m = mMap[code];
                const inv = invMap[code];
                const name = (m?.customerName || code).replace(/</g, '&lt;');
                const balance = inv?.balance || 0;
                const count = inv?.count || 0;
                const aging = inv?.maxAging || 0;
                rowsHtml += `<tr class="border-b border-gray-100 last:border-0 odd:bg-white odd:dark:bg-[var(--surface-primary)] even:bg-gray-50/60 even:dark:bg-[var(--surface-tertiary)] hover:bg-indigo-50/30 dark:hover:bg-indigo-900/20 cursor-pointer" onclick="window.location.href='/ar/invoices/${encodeURIComponent(code)}'">
  <td class="px-2 py-1.5 whitespace-nowrap"><span class="text-[11px] text-gray-400 dark:text-gray-500 font-mono">${escHtml(code)}</span></td>
  <td class="px-2 py-1.5"><div class="flex items-center gap-1.5"><span class="text-xs font-semibold text-gray-900 dark:text-gray-100">${name}</span>${psSetUngrouped.has(code) ? '<span class="inline-flex items-center rounded px-1 py-0.5 text-[8px] font-bold bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-800">PS</span>' : ''}</div></td>
  <td class="px-2 py-1.5 text-center whitespace-nowrap"><span class="text-xs font-bold text-gray-900 dark:text-gray-100">${fmt(balance)}</span></td>
  <td class="px-2 py-1.5 text-center whitespace-nowrap"><span class="text-[11px] text-gray-400 dark:text-gray-500">${count}</span></td>
  <td class="px-2 py-1.5 text-center whitespace-nowrap"><div class="inline-flex items-center justify-center gap-2"><a href="/ar/customer/${encodeURIComponent(code)}/trend" onclick="event.stopPropagation()" class="text-indigo-400 hover:text-indigo-600 transition-colors flex-shrink-0" title="View trend"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"/></svg></a>${agingBadge(aging)}</div></td>

  ${
      isAdmin
          ? `<td class="px-3 py-2.5 whitespace-nowrap" onclick="event.stopPropagation()">
    <div x-data="{ grp: '' }" class="flex gap-1.5 items-center">
      <select x-model="grp" class="rounded-lg border-0 py-1 pl-2 pr-6 text-xs ring-1 ring-inset ring-gray-200 focus:ring-2 focus:ring-indigo-400 bg-white appearance-none dark:ring-gray-700 dark:bg-[var(--input-bg)] dark:text-gray-200">
        <option value="">Group…</option>${groupOptions}
      </select>
      <button type="button" :disabled="!grp" data-code="${code}"
        @click="const _c=encodeURIComponent($el.dataset.code),_u='/admin/groups/'+encodeURIComponent(grp)+'/add-member',_b='customerCode='+_c;fetch(_u,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:_b}).then(async r=>{if(r.ok){htmx.ajax('GET','/ar/groups-data?tab=ungrouped',{target:'#groups-data',swap:'innerHTML'});}else if(r.status===409){const cur=await r.text();if(confirm('Currently in '+cur+'. Move to selected group?')){fetch(_u,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:_b+'&force=true'}).then(r2=>{if(r2.ok)htmx.ajax('GET','/ar/groups-data?tab=ungrouped',{target:'#groups-data',swap:'innerHTML'});});}}})"
        class="px-2 py-1 rounded-lg bg-indigo-50 text-indigo-600 text-xs font-semibold hover:bg-indigo-100 dark:bg-indigo-950 dark:text-indigo-400 dark:hover:bg-indigo-900 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">Assign</button>
    </div>
  </td>`
          : ''
  }
</tr>`;
            }
            return res.send(`<div class="overflow-x-auto">
  <div class="px-4 py-2 border-b border-gray-100 dark:border-gray-700 bg-gray-50/60 dark:bg-[var(--surface-secondary)] flex items-center justify-between">
    <span class="text-xs text-gray-500 dark:text-gray-400"><span class="font-bold text-gray-800 dark:text-gray-200">${ungroupedCodes.length}</span> ungrouped customer${ungroupedCodes.length !== 1 ? 's' : ''}</span>
  </div>
  <table class="w-full border-collapse text-sm">
    <thead>
      <tr class="border-b border-gray-200 dark:border-gray-700 bg-gray-50/80 dark:bg-[var(--surface-tertiary)]">
        <th class="px-2 py-1.5 text-left text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Code</th>
        <th class="px-2 py-1.5 text-left text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Customer</th>
        <th class="px-2 py-1.5 text-center text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Outstanding</th>
        <th class="px-2 py-1.5 text-center text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Inv</th>
        <th class="px-2 py-1.5 text-center text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Aging</th>
        ${isAdmin ? '<th class="px-2 py-1.5 text-center text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Assign</th>' : ''}
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</div>`);
        }

        // ── Grouped tabs (key / sub / non-key) ────────────────────────────
        // Classify at GROUP level: a group is KEY if ANY member is a key account,
        // SUB if ANY member is a sub-d code (and not a key group), else NON-KEY.
        const [keyCodes, allGrouped] = await Promise.all([
            getKeyAccountCodes(prisma),
            prisma.customerGroup.findMany({ orderBy: { groupName: 'asc' } }),
        ]);
        const keyCodeSet = new Set(keyCodes);
        const subCodeSet = new Set(SUB_DISTRIBUTOR_CODES);
        const keyGroupNames = new Set(allGrouped.filter((r) => keyCodeSet.has(r.customerCode)).map((r) => r.groupName));
        const subGroupNames = new Set(
            allGrouped
                .filter((r) => subCodeSet.has(r.customerCode) && !keyGroupNames.has(r.groupName))
                .map((r) => r.groupName)
        );

        let groupEntries;
        if (tab === 'key') {
            groupEntries = allGrouped.filter((r) => keyGroupNames.has(r.groupName));
        } else if (tab === 'sub') {
            groupEntries = allGrouped.filter((r) => subGroupNames.has(r.groupName));
        } else {
            // Non-key: groups that are neither key nor sub
            groupEntries = allGrouped.filter((r) => !keyGroupNames.has(r.groupName) && !subGroupNames.has(r.groupName));
        }

        if (groupEntries.length === 0) {
            return res.send(
                '<div class="py-12 text-center text-sm text-gray-400">No grouped customers for this category. Use Group Import to add groups.</div>'
            );
        }

        const groupMap = {};
        for (const e of groupEntries) {
            if (!groupMap[e.groupName]) groupMap[e.groupName] = [];
            groupMap[e.groupName].push(e.customerCode);
        }

        const allCodes = groupEntries.map((e) => e.customerCode);

        const [invSummary, masterRows] = await Promise.all([
            prisma.invoice.groupBy({
                by: ['customerCode'],
                where: { customerCode: { in: allCodes }, status: 'ACTIVE' },
                _count: { _all: true },
                _sum: { balanceAmount: true },
                _max: { agingDays: true },
            }),
            prisma.customerMaster.findMany({
                where: { customerCode: { in: allCodes } },
                select: { customerCode: true, customerName: true, mobileNo: true, phone: true, psrName: true },
            }),
        ]);

        const invoiceMap = {};
        for (const r of invSummary)
            invoiceMap[r.customerCode] = {
                count: r._count._all,
                balance: r._sum.balanceAmount || 0,
                maxAging: r._max.agingDays || 0,
            };

        const masterMap = {};
        for (const r of masterRows) masterMap[r.customerCode] = r;

        let psSet = new Set();
        if (canPS) {
            const psRecs = await prisma.pendingSettlement.findMany({
                where: { customerCode: { in: allCodes } },
                select: { customerCode: true },
                distinct: ['customerCode'],
            });
            psSet = new Set(psRecs.map((r) => r.customerCode));
        }

        const fmt = (n) => '₹' + (n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
        const agingBadge = (d) => {
            if (!d)
                return '<span class="inline-flex items-center justify-center w-14 text-xs text-gray-300 dark:text-gray-600">—</span>';
            const cls =
                d > 90
                    ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-400 dark:border-red-800'
                    : d > 60
                      ? 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950 dark:text-orange-400 dark:border-orange-800'
                      : d > 30
                        ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-800'
                        : 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-400 dark:border-blue-800';
            return `<span class="inline-flex items-center justify-center rounded-full border w-14 py-0.5 text-[10px] font-bold ${cls}">${d}d</span>`;
        };
        const colSpan = isAdmin ? 7 : 6;

        // Pre-compute group totals so we can sort by outstanding descending
        const groupTotals = {};
        for (const grp of Object.keys(groupMap)) {
            let totalBalance = 0,
                totalCount = 0,
                maxAging = 0;
            for (const c of groupMap[grp]) {
                const inv = invoiceMap[c];
                if (inv) {
                    totalBalance += inv.balance;
                    totalCount += inv.count;
                    if (inv.maxAging > maxAging) maxAging = inv.maxAging;
                }
            }
            groupTotals[grp] = { totalBalance, totalCount, maxAging };
        }
        const sortedGroups = Object.keys(groupMap).sort(
            (a, b) => groupTotals[b].totalBalance - groupTotals[a].totalBalance
        );

        let html = '<div class="overflow-x-auto"><table class="w-full border-collapse text-sm">';
        html +=
            '<thead><tr class="border-b border-gray-200 dark:border-gray-700 bg-gray-50/80 dark:bg-[var(--surface-tertiary)]">';
        html += '<th class="w-7 px-2 py-2"></th>';
        html +=
            '<th class="px-2 py-2 text-left text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Group</th>';
        html +=
            '<th class="px-2 py-2 text-center text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Doors</th>';
        html +=
            '<th class="px-2 py-2 text-center text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Outstanding</th>';
        html +=
            '<th class="px-2 py-2 text-center text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Invoices</th>';
        html +=
            '<th class="px-2 py-2 text-center text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Max Aging</th>';
        if (isAdmin) html += '<th class="w-8 px-2 py-2"></th>';
        html += '</tr></thead>';
        let grpIdx = 0;
        for (const grp of sortedGroups) {
            grpIdx++;
            const grpRowBase = grpIdx % 2 === 0 ? 'bg-gray-100' : 'bg-white';
            const codes = groupMap[grp].sort((a, b) => (invoiceMap[b]?.balance || 0) - (invoiceMap[a]?.balance || 0));
            const safeGrp = grp.replace(/</g, '&lt;').replace(/>/g, '&gt;');

            const { totalBalance, totalCount, maxAging } = groupTotals[grp];

            let rowsHtml = '';
            let subIdx = 0;
            for (const code of codes) {
                subIdx++;
                const subRowBase =
                    subIdx % 2 === 0
                        ? 'bg-gray-100 dark:bg-[var(--surface-tertiary)]'
                        : 'bg-white dark:bg-[var(--surface-primary)]';
                const m = masterMap[code];
                const inv = invoiceMap[code];
                const name = m?.customerName || code;
                const balance = inv?.balance || 0;
                const count = inv?.count || 0;
                const aging = inv?.maxAging || 0;
                const encodedCode = encodeURIComponent(code);
                const safeName = name.replace(/</g, '&lt;').replace(/"/g, '&quot;');
                rowsHtml += `<tr class="${subRowBase} border-b border-gray-100 dark:border-gray-700 last:border-0 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 cursor-pointer transition-colors" onclick="window.location.href='/ar/invoices/${encodedCode}'">
  <td class="px-2 py-1.5 whitespace-nowrap"><span class="text-[11px] text-gray-400 dark:text-gray-500 font-mono">${escHtml(code)}</span></td>
  <td class="px-2 py-1.5"><div class="flex items-center gap-1.5 overflow-hidden"><span class="text-xs font-semibold text-gray-900 dark:text-gray-100 truncate" title="${name.replace(/"/g, '&quot;')}">${name.replace(/</g, '&lt;')}</span>${psSet.has(code) ? '<span class="inline-flex items-center flex-shrink-0 rounded px-1 py-0.5 text-[8px] font-bold bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-800">PS</span>' : ''}</div></td>
  <td class="px-2 py-1.5 text-center">${m?.psrName ? `<span class="inline-flex items-center rounded-md px-1 py-px text-[10px] font-medium leading-tight bg-green-50 text-green-700 border border-green-200 dark:bg-green-950 dark:text-green-400 dark:border-green-800">${m.psrName.replace(/</g, '&lt;')}</span>` : '<span class="text-[11px] text-gray-300 dark:text-gray-600">—</span>'}</td>
  <td class="px-2 py-1.5 text-center whitespace-nowrap"><span class="text-xs font-bold text-gray-900 dark:text-gray-100">${fmt(balance)}</span></td>
  <td class="px-2 py-1.5 text-center whitespace-nowrap"><span class="text-[11px] text-gray-400 dark:text-gray-500">${count}</span></td>
  <td class="px-2 py-1.5 text-center whitespace-nowrap"><div class="inline-flex items-center justify-center gap-2"><a href="/ar/customer/${encodedCode}/trend" onclick="event.stopPropagation()" class="text-indigo-400 hover:text-indigo-600 transition-colors flex-shrink-0" title="View trend"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"/></svg></a>${agingBadge(aging)}</div></td>
  ${
      isAdmin
          ? `<td class="px-2 py-1.5 text-center whitespace-nowrap" onclick="event.stopPropagation()">
    <button type="button"
      hx-post="/admin/groups/member/${encodedCode}/remove"
      hx-target="closest tr" hx-swap="outerHTML"
      hx-confirm="Remove ${safeName} from this group?"
      onclick="event.stopPropagation()"
      class="p-1 rounded text-gray-300 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950 transition-colors" title="Remove from group">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
    </button>
  </td>`
          : ''
  }
</tr>`;
            }

            const encodedGrp = encodeURIComponent(grp);
            const deleteBtn = isAdmin
                ? `<button type="button"
                    hx-post="/admin/groups/${encodedGrp}/delete"
                    hx-confirm="Delete group &quot;${safeGrp}&quot; and remove all its members? This cannot be undone."
                    hx-target="closest tbody"
                    hx-swap="outerHTML"
                    @click.stop
                    class="p-1.5 rounded text-gray-300 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
                    title="Delete group">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                  </button>`
                : '';

            const subColSpan = isAdmin ? 7 : 6;
            html += `<tbody x-data="{ open: false }">
  <tr class="border-b border-violet-200 dark:border-violet-800 cursor-pointer select-none transition-colors hover:bg-violet-100/60 bg-violet-50 dark:bg-violet-950/30 dark:hover:bg-violet-900/20" :class="open ? '!bg-violet-100/60 dark:!bg-violet-900/20 !border-b-2 !border-violet-300 dark:!border-violet-800' : ''" @click="open = !open">
    <td class="px-2 py-2 w-7">
      <div class="flex items-center justify-center text-violet-400 dark:text-violet-500 transition-colors" :class="open ? 'text-violet-600' : ''">
        <svg class="w-3 h-3 transition-transform duration-200" :class="open ? 'rotate-90' : ''" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7"/></svg>
      </div>
    </td>
    <td class="px-2 py-2">
      <span class="text-xs font-bold text-violet-900 dark:text-violet-300">${safeGrp}</span>
    </td>
    <td class="px-2 py-2 text-center whitespace-nowrap"><span class="text-[11px] text-gray-500 dark:text-gray-400">${codes.length}</span></td>
    <td class="px-2 py-2 text-center whitespace-nowrap"><span class="text-xs font-bold text-violet-900 dark:text-violet-300">${fmt(totalBalance)}</span></td>
    <td class="px-2 py-2 text-center whitespace-nowrap"><span class="text-[11px] text-gray-400 dark:text-gray-500">${totalCount}</span></td>
    <td class="px-2 py-2 text-center whitespace-nowrap">${agingBadge(maxAging)}</td>
    ${isAdmin ? `<td class="px-2 py-2 text-right whitespace-nowrap" onclick="event.stopPropagation()">${deleteBtn}</td>` : ''}
  </tr>
  <tr x-show="open" x-cloak class="border-b-2 border-violet-100 dark:border-violet-900">
    <td colspan="${colSpan}" class="p-0 px-3 pb-3">
      <div class="border-l-3 border-violet-300 dark:border-violet-800 bg-slate-50/60 dark:bg-[var(--surface-secondary)] rounded-b-lg overflow-hidden">
      <table class="w-full table-fixed border-collapse text-sm">
        <thead>
          <tr class="border-b border-gray-200 dark:border-gray-700 bg-white/70 dark:bg-[var(--surface-tertiary)]">
            <th class="w-[12%] px-2 py-1.5 text-left text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Code</th>
            <th class="w-[40%] px-2 py-1.5 text-left text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Customer</th>
            <th class="w-[12%] px-2 py-1.5 text-center text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">PSR</th>
            <th class="w-[16%] px-2 py-1.5 text-center text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Outstanding</th>
            <th class="w-[6%] px-2 py-1.5 text-center text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Inv</th>
            <th class="w-[10%] px-2 py-1.5 text-center text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Aging</th>
            ${isAdmin ? '<th class="w-[4%] px-2 py-1.5"></th>' : ''}
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
        ${
            isAdmin
                ? `<tfoot><tr><td colspan="${subColSpan}" class="px-4 py-2 border-t border-gray-100">
          <div x-data="{ addCode: '', addSaving: false }" class="flex gap-1.5 items-center">
            <input x-model="addCode" placeholder="Add customer code…" autocomplete="off"
              class="flex-1 rounded-lg border-0 py-1.5 pl-3 pr-3 text-xs text-gray-900 ring-1 ring-inset ring-gray-200 focus:ring-2 focus:ring-indigo-400 bg-white placeholder:text-gray-400 dark:ring-gray-700 dark:bg-[var(--input-bg)] dark:text-gray-200 dark:placeholder:text-gray-500"/>
            <button type="button" :disabled="addSaving || !addCode.trim()"
              @click="const _c=encodeURIComponent(addCode.trim()),_u='/admin/groups/${encodedGrp}/add-member',_b='customerCode='+_c;if(!_c)return;addSaving=true;fetch(_u,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:_b}).then(async r=>{if(r.ok){htmx.ajax('GET','/ar/groups-data?tab=${tab}',{target:'#groups-data',swap:'innerHTML'});addCode='';}else if(r.status===409){const cur=await r.text();addSaving=false;if(confirm('Currently in '+cur+'. Move here?')){addSaving=true;fetch(_u,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:_b+'&force=true'}).then(r2=>{if(r2.ok){htmx.ajax('GET','/ar/groups-data?tab=${tab}',{target:'#groups-data',swap:'innerHTML'});addCode='';}addSaving=false;});}}else{addSaving=false;}})"
              class="px-2.5 py-1.5 rounded-lg bg-indigo-50 text-indigo-600 text-xs font-semibold hover:bg-indigo-100 dark:bg-indigo-950 dark:text-indigo-400 dark:hover:bg-indigo-900 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              <span x-text="addSaving ? '…' : 'Add'"></span>
            </button>
          </div>
        </td></tr></tfoot>`
                : ''
        }
      </table>
      </div>
    </td>
  </tr>
</tbody>`;
        }
        html += '</table></div>';
        res.send(html);
    } catch (err) {
        logger.error({ err, route: 'GET /ar/groups-data' }, 'Error loading groups data');
        res.status(500).send('<div class="p-4 text-red-500 text-sm">Failed to load groups.</div>');
    }
});

// Redirects — these pages are now tabs in /ar/directory
router.get('/ar/key-accounts', (req, res) => res.redirect('/ar/directory?keyOnly=1'));
router.get('/ar/sub-distributors', (req, res) => res.redirect('/ar/directory?subOnly=1'));

module.exports = router;
