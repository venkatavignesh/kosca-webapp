// src/routes/ar/upload.js
const express = require('express');
const router  = express.Router();
const { upload }                        = require('./_shared');
const { uploadQueue, connection }       = require('../../queue');
const { requireAuth, requireModule, requireRole } = require('../../middleware/auth');

// Handle File Upload - Page
router.get('/ar/upload', requireAuth, requireModule('ar_upload'), async (req, res) => {
    const fmt = (iso) => iso
        ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
        : null;
    const [lastArSync, lastCmSync] = await Promise.all([
        connection.get('kosca:last_ar_sync'),
        connection.get('kosca:last_cm_sync')
    ]);
    res.render('ar/upload', {
        arReportPath: process.env.AR_REPORT_PATH || null,
        customerMasterPath: process.env.CUSTOMER_MASTER_PATH || null,
        lastArSync: fmt(lastArSync),
        lastCmSync: fmt(lastCmSync)
    });
});

// Handle File Upload via HTMX (AR report or Customer Master)
router.post('/ar/upload', requireAuth, requireModule('ar_upload'), upload.single('excelFile'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('<div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative" role="alert">Please upload an excel file.</div>');
    }

    const uploadType = req.body.uploadType === 'customer_master' ? 'customer_master' : 'ar_report';
    const label = uploadType === 'customer_master' ? 'Customer Master' : 'AR Report';

    try {
        await uploadQueue.add('process-excel', {
            filePath: req.file.path,
            originalName: req.file.originalname,
            type: uploadType,
            keepFile: false
        });

        const safeName = req.file.originalname
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        res.send(`<div class="bg-green-100 border border-green-400 text-green-700 px-4 py-3 rounded relative" role="alert">
      ${label}: ${safeName} uploaded and added to processing queue. <a href="/ar" class="underline font-semibold">View Dashboard</a>
    </div>`);
    } catch (error) {
        console.error('Upload Error:', error);
        res.status(500).send('<div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative" role="alert">An error occurred during file upload.</div>');
    }
});

// Manually trigger an immediate sync from configured network paths
router.post('/ar/sync-now', requireAuth, requireRole(['ADMIN', 'MANAGER']), async (req, res) => {
    const AR_REPORT_PATH = process.env.AR_REPORT_PATH;
    const CUSTOMER_MASTER_PATH = process.env.CUSTOMER_MASTER_PATH;

    if (!AR_REPORT_PATH && !CUSTOMER_MASTER_PATH) {
        return res.status(400).send('<div class="bg-yellow-100 border border-yellow-400 text-yellow-700 px-4 py-3 rounded">No auto-sync paths are configured.</div>');
    }

    try {
        if (AR_REPORT_PATH) {
            await uploadQueue.add('sync-now-ar', { filePath: AR_REPORT_PATH, type: 'ar_report', keepFile: true });
        }
        if (CUSTOMER_MASTER_PATH) {
            await uploadQueue.add('sync-now-customer-master', { filePath: CUSTOMER_MASTER_PATH, type: 'customer_master', keepFile: true });
        }
        res.send('<div class="bg-green-100 border border-green-400 text-green-700 px-4 py-3 rounded">Sync triggered from network share. Check progress below.</div>');
    } catch (error) {
        console.error('Sync-now Error:', error);
        res.status(500).send('<div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">Failed to trigger sync.</div>');
    }
});

// GET Upload Progress Status via HTMX
router.get('/ar/upload/status', requireAuth, async (req, res) => {
    try {
        const activeJobs = await uploadQueue.getActive();
        const waitingJobs = await uploadQueue.getWaiting();

        let currentJob = null;
        let jobStatus = 'idle';

        if (activeJobs.length > 0) {
            currentJob = activeJobs[0];
            jobStatus = 'active';
        } else if (waitingJobs.length > 0) {
            currentJob = waitingJobs[0];
            jobStatus = 'waiting';
        } else {
            // Check if a job JUST finished (so we can show 100% and trigger the reload script)
            const completedJobs = await uploadQueue.getCompleted(0, 0); // Get the most recent completed job
            if (completedJobs.length > 0) {
                const latestCompleted = completedJobs[0];
                // If it finished in the last 10 seconds
                if (latestCompleted.finishedOn && (Date.now() - latestCompleted.finishedOn < 10000)) {
                    currentJob = latestCompleted;
                    jobStatus = 'completed';
                }
            }
        }

        if (!currentJob) {
            // No active, waiting, or recently completed jobs
            return res.send('<div id="ar-upload-progress" hx-get="/ar/upload/status" hx-trigger="every 2s" hx-swap="outerHTML" style="display:none;"></div>');
        }

        let progress = currentJob.progress || 0;
        if (jobStatus === 'completed') progress = 100;

        const jobType = currentJob.data?.type || 'ar_report';
        const isAR = jobType !== 'customer_master';

        let step = 0; // 0=queue,1=read,2=parse,3=clean,4=save,5=done
        let message = 'Waiting in queue...';

        if (jobStatus === 'waiting') { step = 0; message = 'Waiting in queue...'; }
        else if (progress < 15)     { step = 1; message = 'Reading Excel file...'; }
        else if (progress < 25)     { step = 2; message = isAR ? 'Parsing invoice rows...' : 'Parsing customer records...'; }
        else if (progress < 40)     { step = 3; message = isAR ? 'Cleaning settled invoices...' : 'Preparing records...'; }
        else if (progress < 100)    { step = 4; message = isAR ? `Saving invoices... ${progress}%` : `Saving customers... ${progress}%`; }
        else                        { step = 5; message = 'Sync complete!'; }

        res.render('partials/upload_progress', { progress, message, jobStatus, jobType, step });

    } catch (error) {
        console.error('Error fetching queue status:', error);
        res.send('<div id="ar-upload-progress" hx-get="/ar/upload/status" hx-trigger="every 2s" hx-swap="outerHTML" style="display:none;"></div>');
    }
});

module.exports = router;
