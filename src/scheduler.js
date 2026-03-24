const { uploadQueue } = require('./queue');
const prisma = require('./prisma');

async function purgeSettledInvoices() {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const result = await prisma.invoice.deleteMany({
        where: { status: 'SETTLED', settledAt: { lt: threeDaysAgo } }
    });
    if (result.count > 0) {
        console.log(`[Purge] Deleted ${result.count} settled invoices older than 3 days.`);
    }
}

async function setupScheduler() {
    // Run purge immediately on startup, then every 24 hours
    purgeSettledInvoices().catch(e => console.error('[Purge] Error:', e));
    setInterval(() => {
        purgeSettledInvoices().catch(e => console.error('[Purge] Error:', e));
    }, 24 * 60 * 60 * 1000);
    const AR_REPORT_PATH = process.env.AR_REPORT_PATH;
    const CUSTOMER_MASTER_PATH = process.env.CUSTOMER_MASTER_PATH;
    const PENDING_SETTLEMENT_PATH = process.env.PENDING_SETTLEMENT_PATH;

    if (!AR_REPORT_PATH && !CUSTOMER_MASTER_PATH && !PENDING_SETTLEMENT_PATH) {
        console.log('[Scheduler] No auto-sync paths configured. Set AR_REPORT_PATH, CUSTOMER_MASTER_PATH, and/or PENDING_SETTLEMENT_PATH in .env to enable.');
        return;
    }

    // Remove existing auto-sync repeatable jobs to avoid duplicates on restart
    const existing = await uploadQueue.getRepeatableJobs();
    for (const job of existing.filter(j => j.name.startsWith('auto-sync-'))) {
        await uploadQueue.removeRepeatableByKey(job.key);
    }

    if (AR_REPORT_PATH) {
        await uploadQueue.add(
            'auto-sync-ar',
            { filePath: AR_REPORT_PATH, type: 'ar_report', keepFile: true },
            { repeat: { pattern: '10,40 * * * *' } }
        );
        console.log(`[Scheduler] AR Report auto-sync scheduled every 30 minutes from: ${AR_REPORT_PATH}`);
    }

    if (CUSTOMER_MASTER_PATH) {
        await uploadQueue.add(
            'auto-sync-customer-master',
            { filePath: CUSTOMER_MASTER_PATH, type: 'customer_master', keepFile: true },
            { repeat: { pattern: '10,40 * * * *' } }
        );
        console.log(`[Scheduler] Customer Master auto-sync scheduled every 30 minutes from: ${CUSTOMER_MASTER_PATH}`);
    }

    if (PENDING_SETTLEMENT_PATH) {
        await uploadQueue.add(
            'auto-sync-pending-settlement',
            { filePath: PENDING_SETTLEMENT_PATH, type: 'pending_settlement', keepFile: true },
            { repeat: { pattern: '10,40 * * * *' } }
        );
        console.log(`[Scheduler] Pending Settlement auto-sync scheduled every 30 minutes from: ${PENDING_SETTLEMENT_PATH}`);
    }
}

module.exports = { setupScheduler };
