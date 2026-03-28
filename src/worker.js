const { Worker } = require('bullmq');
const ExcelJS = require('exceljs');
const prisma = require('./prisma');
const { connection } = require('./queue');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// Unambiguous customer code prefix → site name mappings.
// Ambiguous prefixes (CMB, MDR, MDI, CBT, VCH, VJY, VZG) are intentionally
// excluded — those need admin assignment.
const PREFIX_SITE_MAP = {
    'BNG': 'Bangalore',
    'HBL': 'Bangalore',
    'MYS': 'Bangalore',
    'CHN': 'Chennai',
    'CMB': 'Coimbatore',
    'HYD': 'Hyderabad',
    'KRL': 'KERALA',
    'MDA': 'Madurai',
    'VIZ': 'Visakhapatnam',
};

function inferSiteFromCode(customerCode) {
    const code = customerCode.toString().trim();
    // All-numeric codes → cannot infer, wait for admin to assign
    if (/^\d+$/.test(code)) return null;
    // Extract leading alphabetic characters as prefix
    const prefix = (code.match(/^[A-Za-z]+/) || [])[0];
    if (!prefix) return null;
    return PREFIX_SITE_MAP[prefix.toUpperCase()] || null;
}

async function processARReport(data, job) {
    // Pre-load admin site overrides so we don't query per row
    const overrideRecords = await prisma.customerSiteOverride.findMany({ select: { customerCode: true, siteName: true } });
    const siteOverrideMap = new Map(overrideRecords.map(r => [r.customerCode, r.siteName]));

    const invoices = [];
    const psrByCustomer = new Map();
    for (const row of data) {
        const distributorName = row['DISTRIBUTOR_NAME'] || row['Distributor Name'] || row['DistributorName'] || '';
        const rawSite = (row['SITE_NAME'] || row['Site Name'] || row['SiteName'] || row['Branch'] || '').trim();
        const invoiceNo = row['INVOICE_NO'] || row['Invoice No'] || row['InvoiceNo'] || '';
        const customerCode = row['Customer_Code'] || row['CustomerCode'] || row['Customer Code'] || '';
        const siteName = rawSite || inferSiteFromCode(customerCode) || siteOverrideMap.get(customerCode.toString()) || null;
        const psrName = (row['PSR_Name'] || '').toString().trim() || null;
        const customerName = row['CUSTOMER_NAME'] || row['Customer Name'] || row['CustomerName'] || row['Customer'] || 'Unknown';
        let invoiceDate = new Date(row['INVOICE_DATE'] || row['Invoice Date'] || row['Date'] || new Date());
        let dueDate = new Date(row['DUE_DATE'] || row['Due Date'] || row['DueDate'] || new Date());
        let invoiceAmount = parseFloat(row['INVOICE_AMOUNT'] || row['Invoice Amount'] || row['Gross Amount'] || row['Net Amount'] || row['Total Amount'] || row['INVOICE_VALUE'] || row['Invoice Value'] || 0);
        let paidAmount    = parseFloat(row['AMOUNTPAID'] || 0);
        let balanceAmount = parseFloat(row['OUTSTANDING'] || row['Balance Amount'] || row['Balance'] || row['Amount'] || 0);
        let agingDays = parseInt(row['AR_DAYS'] || row['Aging (Days)'] || row['Aging Days'] || row['Aging'] || 0, 10);

        if (isNaN(invoiceAmount)) invoiceAmount = 0;
        if (isNaN(paidAmount)) paidAmount = 0;
        if (isNaN(balanceAmount)) balanceAmount = 0;
        if (invoiceAmount === 0) invoiceAmount = balanceAmount;
        if (isNaN(agingDays)) agingDays = 0;
        if (isNaN(invoiceDate.getTime())) invoiceDate = new Date();
        if (isNaN(dueDate.getTime())) dueDate = new Date();

        if (distributorName.trim().toLowerCase() !== 'kosca distribution llp') continue;

        if (psrName && customerCode && !psrByCustomer.has(customerCode.toString())) {
            psrByCustomer.set(customerCode.toString(), psrName);
        }

        invoices.push({
            distributorName: distributorName.trim(),
            siteName: siteName || null,
            invoiceNo: invoiceNo.toString(),
            customerCode: customerCode.toString(),
            customerName,
            invoiceDate,
            dueDate,
            invoiceAmount,
            paidAmount,
            balanceAmount,
            agingDays
        });
    }

    await job.updateProgress(25);

    if (invoices.length === 0) {
        logger.info('No matching invoices found in file');
        return;
    }

    const threeDaysAgo = new Date(Date.now() - (3 * 24 * 60 * 60 * 1000));
    const activeInvoiceNos = invoices.map(i => i.invoiceNo);

    await prisma.$transaction([
        prisma.invoice.deleteMany({
            where: { status: 'SETTLED', settledAt: { lt: threeDaysAgo } }
        }),
        prisma.invoice.deleteMany({
            where: { status: 'ACTIVE', invoiceNo: { notIn: activeInvoiceNos } }
        })
    ]);

    await job.updateProgress(40);

    let upsertedCount = 0;
    const totalInvoices = invoices.length;

    const BATCH_SIZE = 100;
    for (let i = 0; i < totalInvoices; i += BATCH_SIZE) {
        const batch = invoices.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(inv =>
            prisma.invoice.upsert({
                where: { invoiceNo_customerCode: { invoiceNo: inv.invoiceNo, customerCode: inv.customerCode } },
                update: { ...inv, status: 'ACTIVE', settledAt: null },
                create: { ...inv, status: 'ACTIVE' }
            })
        ));
        upsertedCount += batch.length;
        const progress = 40 + Math.floor((upsertedCount / totalInvoices) * 59);
        await job.updateProgress(progress);
    }

    logger.info({ upsertedCount }, 'AR sync complete');

    // Write daily snapshots per customer
    const customerAgg = new Map();
    for (const inv of invoices) {
        if (!customerAgg.has(inv.customerCode)) {
            customerAgg.set(inv.customerCode, { customerName: inv.customerName, totalAmount: 0, invoiceCount: 0, maxAgingDays: 0 });
        }
        const c = customerAgg.get(inv.customerCode);
        c.totalAmount += inv.balanceAmount;
        c.invoiceCount++;
        if (inv.agingDays > c.maxAgingDays) c.maxAgingDays = inv.agingDays;
    }

    const snapshotDate = new Date();
    snapshotDate.setUTCHours(0, 0, 0, 0);

    const snapshotEntries = Array.from(customerAgg.entries());
    for (let i = 0; i < snapshotEntries.length; i += BATCH_SIZE) {
        const batch = snapshotEntries.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(([customerCode, data]) =>
            prisma.aRSnapshot.upsert({
                where: { customerCode_snapshotDate: { customerCode, snapshotDate } },
                update: { totalAmount: data.totalAmount, invoiceCount: data.invoiceCount, maxAgingDays: data.maxAgingDays },
                create: { customerCode, customerName: data.customerName, snapshotDate, totalAmount: data.totalAmount, invoiceCount: data.invoiceCount, maxAgingDays: data.maxAgingDays }
            })
        ));
    }
    logger.info({ customerCount: customerAgg.size }, 'Snapshots written');

    // Sync customer names into CustomerGroup for any grouped codes present in this upload
    const uploadedCodes = Array.from(customerAgg.keys());
    const groupedEntries = await prisma.customerGroup.findMany({
        where: { customerCode: { in: uploadedCodes } },
        select: { customerCode: true }
    });
    if (groupedEntries.length > 0) {
        await prisma.$transaction(
            groupedEntries.map(g => prisma.customerGroup.update({
                where: { customerCode: g.customerCode },
                data: { customerName: customerAgg.get(g.customerCode)?.customerName }
            }))
        );
        logger.info({ count: groupedEntries.length }, 'Updated customer names for grouped customers');
    }

    // Sync PSR names into CustomerMaster
    if (psrByCustomer.size > 0) {
        const psrEntries = Array.from(psrByCustomer.entries());
        for (let i = 0; i < psrEntries.length; i += BATCH_SIZE) {
            const batch = psrEntries.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(([code, psr]) =>
                prisma.customerMaster.upsert({
                    where: { customerCode: code },
                    update: { psrName: psr },
                    create: { customerCode: code, customerName: customerAgg.get(code)?.customerName || code, psrName: psr }
                })
            ));
        }
        logger.info({ count: psrByCustomer.size }, 'PSR names synced');
    }
}

async function processCustomerMaster(data, job) {
    const records = [];
    for (const row of data) {
        const customerCode = (
            row['CUSTOMER_CODE'] || row['Customer_Code'] || row['Customer Code'] ||
            row['CustomerCode'] || row['Acc Code'] || row['Party Code'] || ''
        ).toString().trim();

        if (!customerCode) continue;

        records.push({
            customerCode,
            customerName: (row['CUSTOMER_NAME'] || row['Customer Name'] || row['Acc Name'] || row['Party Name'] || '').toString().trim(),
            mobileNo: (row['CUST_PRIMARY_NO'] || row['MOBILE_NO'] || row['Mobile No'] || row['Mobile'] || '').toString().trim() || null,
            phone: (row['CUST_SECONDARY_NO'] || row['PHONE'] || row['Phone'] || row['Telephone'] || '').toString().trim() || null,
            city: (row['CITY'] || row['City'] || row['Town'] || '').toString().trim() || null,
            state: (row['STATE'] || row['State'] || '').toString().trim() || null,
            area: (row['AREA'] || row['Area'] || row['Region'] || row['Route'] || '').toString().trim() || null,
            email: (row['EMAIL'] || row['Email'] || '').toString().trim() || null,
        });
    }

    await job.updateProgress(25);

    const total = records.length;

    // Batch-fetch locked status for all codes in one query
    const allCodes = records.map(r => r.customerCode);
    const lockedRows = await prisma.customerMaster.findMany({
        where: { customerCode: { in: allCodes }, mobileNoLocked: true },
        select: { customerCode: true }
    });
    const lockedSet = new Set(lockedRows.map(r => r.customerCode));

    // Process in batches of 50 to stay within DB connection limits
    const BATCH = 50;
    let count = 0;
    for (let i = 0; i < total; i += BATCH) {
        const batch = records.slice(i, i + BATCH);
        await Promise.all(batch.map(rec => {
            const createData = { ...rec, masterMobileNo: rec.mobileNo || null };
            const updateData = { ...createData };
            if (lockedSet.has(rec.customerCode)) {
                delete updateData.mobileNo;
                delete updateData.phone;
            }
            return prisma.customerMaster.upsert({
                where: { customerCode: rec.customerCode },
                update: updateData,
                create: createData,
            });
        }));
        count += batch.length;
        await job.updateProgress(40 + Math.floor((count / total) * 59));
    }

    logger.info({ upsertedCount: count }, 'Customer Master sync complete');
}

async function processPendingSettlement(data, job) {
    const records = [];
    for (const row of data) {
        const siteName = (row['SITENAME'] || '').toString().trim();
        if (siteName.toLowerCase() !== 'kosca distribution llp') continue;

        const customerCode = (row['CUSTOMER_CODE'] || '').toString().trim();
        if (!customerCode) continue;

        const customerName = (row['CUSTOMER_NAME'] || '').toString().trim() || null;
        const documentNo = (row['DOCUMENT_NO'] || '').toString().trim();
        const type = (row['TYPE'] || '').toString().trim() || null;
        let amount = parseFloat(row['PENDING_AMOUNT'] || 0);
        if (isNaN(amount)) amount = 0;

        let documentDate = row['DOCUMENT_DATE'];
        if (documentDate instanceof Date) {
            // ExcelJS returned a Date object
        } else if (typeof documentDate === 'string' && documentDate) {
            // Parse DD/MM/YYYY
            const parts = documentDate.split('/');
            if (parts.length === 3) {
                documentDate = new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
            } else {
                documentDate = new Date(documentDate);
            }
            if (isNaN(documentDate.getTime())) documentDate = null;
        } else {
            documentDate = null;
        }

        records.push({ siteName, customerCode, customerName, documentDate, documentNo, type, amount });
    }

    await job.updateProgress(25);

    if (records.length === 0) {
        logger.info('No KOSCA DISTRIBUTION LLP rows found in pending settlement file');
        return;
    }

    // Replace all: delete existing records then batch insert fresh data
    await prisma.pendingSettlement.deleteMany();

    const BATCH = 100;
    let count = 0;
    for (let i = 0; i < records.length; i += BATCH) {
        await prisma.pendingSettlement.createMany({ data: records.slice(i, i + BATCH) });
        count += Math.min(BATCH, records.length - i);
        await job.updateProgress(40 + Math.floor((count / records.length) * 59));
    }

    logger.info({ insertedCount: count }, 'Pending settlement sync complete');
}

const worker = new Worker('ExcelUploads', async job => {
    const { filePath, type = 'ar_report', keepFile = false } = job.data;
    const absolutePath = path.resolve(filePath);

    logger.info({ jobId: job.id, type, filePath: absolutePath }, 'Processing job');
    await job.updateProgress(5);

    try {
        if (!fs.existsSync(absolutePath)) {
            throw new Error(`File not found: ${absolutePath}`);
        }

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(absolutePath);
        const fileMtimeISO = fs.statSync(absolutePath).mtime.toISOString();
        const sheet = workbook.worksheets[0];
        // Build header list from row 1
        const _headers = [];
        sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, colNum) => {
            _headers[colNum - 1] = cell.text;
        });
        // Convert rows to objects keyed by header name; preserve Date objects for date cells
        const data = [];
        sheet.eachRow((row, rowNum) => {
            if (rowNum === 1) return;
            const obj = {};
            _headers.forEach((h, i) => {
                const cell = row.getCell(i + 1);
                obj[h] = cell.type === ExcelJS.ValueType.Date ? cell.value : cell.text;
            });
            if (_headers.some((h, i) => obj[h] !== '' && obj[h] !== null && obj[h] !== undefined)) data.push(obj);
        });

        logger.info({ rowCount: data.length }, 'Parsed rows from Excel file');
        await job.updateProgress(15);

        if (data.length === 0) {
            logger.info('No data found in Excel sheet');
            return;
        }

        if (type === 'customer_master') {
            await processCustomerMaster(data, job);
            await connection.set('kosca:last_cm_sync', new Date().toISOString());
            await connection.set('kosca:last_cm_file_mtime', fileMtimeISO);
        } else if (type === 'pending_settlement') {
            await processPendingSettlement(data, job);
            await connection.set('kosca:last_ps_sync', new Date().toISOString());
            await connection.set('kosca:last_ps_file_mtime', fileMtimeISO);
        } else {
            await processARReport(data, job);
            await connection.set('kosca:last_ar_sync', new Date().toISOString());
            await connection.set('kosca:last_ar_file_mtime', fileMtimeISO);
        }

        await job.updateProgress(100);

    } catch (err) {
        logger.error({ err, jobId: job.id }, 'Failed to process job');
        throw err;
    } finally {
        if (!keepFile && fs.existsSync(absolutePath)) {
            try {
                fs.unlinkSync(absolutePath);
                logger.info({ filePath: absolutePath }, 'Cleaned up temp file');
            } catch (err) {
                logger.error({ err, filePath: absolutePath }, 'Could not delete temp file');
            }
        }
    }

}, { connection });

worker.on('failed', (job, err) => {
    logger.error({ err, jobId: job.id }, 'Job failed');
});

logger.info('Worker is running and listening for ExcelUploads');
