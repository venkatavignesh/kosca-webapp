const { uploadQueue } = require('./queue');
const prisma = require('./prisma');
const logger = require('./logger');

async function purgeSettledInvoices() {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const result = await prisma.invoice.deleteMany({
        where: { status: 'SETTLED', settledAt: { lt: threeDaysAgo } }
    });
    if (result.count > 0) {
        logger.info({ count: result.count }, 'Purged settled invoices older than 3 days');
    }
}

async function setupScheduler() {
    // Run purge immediately on startup, then every 24 hours
    purgeSettledInvoices().catch(e => logger.error({ err: e }, 'Purge failed'));
    setInterval(() => {
        purgeSettledInvoices().catch(e => logger.error({ err: e }, 'Purge failed'));
    }, 24 * 60 * 60 * 1000);
    const AR_REPORT_PATH = process.env.AR_REPORT_PATH;
    const CUSTOMER_MASTER_PATH = process.env.CUSTOMER_MASTER_PATH;
    const PENDING_SETTLEMENT_PATH = process.env.PENDING_SETTLEMENT_PATH;

    if (!AR_REPORT_PATH && !CUSTOMER_MASTER_PATH && !PENDING_SETTLEMENT_PATH) {
        logger.info('No auto-sync paths configured');
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
        logger.info({ path: AR_REPORT_PATH }, 'AR Report auto-sync scheduled (every 30 min)');
    }

    if (CUSTOMER_MASTER_PATH) {
        await uploadQueue.add(
            'auto-sync-customer-master',
            { filePath: CUSTOMER_MASTER_PATH, type: 'customer_master', keepFile: true },
            { repeat: { pattern: '10,40 * * * *' } }
        );
        logger.info({ path: CUSTOMER_MASTER_PATH }, 'Customer Master auto-sync scheduled (every 30 min)');
    }

    if (PENDING_SETTLEMENT_PATH) {
        await uploadQueue.add(
            'auto-sync-pending-settlement',
            { filePath: PENDING_SETTLEMENT_PATH, type: 'pending_settlement', keepFile: true },
            { repeat: { pattern: '10,40 * * * *' } }
        );
        logger.info({ path: PENDING_SETTLEMENT_PATH }, 'Pending Settlement auto-sync scheduled (every 30 min)');
    }
}

module.exports = { setupScheduler };
