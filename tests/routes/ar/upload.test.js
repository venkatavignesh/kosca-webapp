// tests/routes/ar/upload.test.js
jest.mock('../../../src/prisma', () => require('../../setup').makePrismaMock());
jest.mock('../../../src/queue', () => ({
    uploadQueue: {
        add:          jest.fn().mockResolvedValue({ id: 'mock-job-id' }),
        getActive:    jest.fn().mockResolvedValue([]),
        getWaiting:   jest.fn().mockResolvedValue([]),
        getCompleted: jest.fn().mockResolvedValue([])
    },
    connection: { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') }
}));

const request      = require('supertest');
const { makeApp }  = require('../../setup');
const { uploadQueue } = require('../../../src/queue');
const router       = require('../../../src/routes/ar/upload');

describe('Upload routes', () => {
    beforeEach(() => jest.clearAllMocks());

    describe('GET /ar/upload', () => {
        it('returns 200 for authenticated user with ar_upload module', async () => {
            const res = await request(makeApp(router)).get('/ar/upload');
            expect(res.status).toBe(200);
        });

        it('redirects to /login when unauthenticated', async () => {
            const res = await request(makeApp(router, { userId: null })).get('/ar/upload');
            expect(res.status).toBe(302);
        });
    });

    describe('POST /ar/upload', () => {
        it('returns 200 with success HTML when valid xlsx uploaded', async () => {
            const res = await request(makeApp(router))
                .post('/ar/upload')
                .attach('excelFile', Buffer.from('fake-xlsx-content'), {
                    filename:    'report.xlsx',
                    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                });
            expect(res.status).toBe(200);
            expect(res.text).toContain('bg-green-100');
            expect(uploadQueue.add).toHaveBeenCalledWith('process-excel', expect.objectContaining({
                type: 'ar_report'
            }));
        });

        it('returns 400 when file has wrong MIME type', async () => {
            const res = await request(makeApp(router))
                .post('/ar/upload')
                .attach('excelFile', Buffer.from('not-excel'), {
                    filename:    'report.xlsx',
                    contentType: 'text/plain'
                });
            expect(res.status).toBe(400);
        });
    });

    describe('POST /ar/sync-now', () => {
        it('returns 403 when user is USER role (not ADMIN/MANAGER)', async () => {
            const res = await request(makeApp(router, { userRole: 'USER', userModules: [] }))
                .post('/ar/sync-now');
            expect(res.status).toBe(403);
        });

        it('returns 400 when no env paths configured (ADMIN role)', async () => {
            // Temporarily clear env vars so the route hits the 400 branch
            const savedAR = process.env.AR_REPORT_PATH;
            const savedCM = process.env.CUSTOMER_MASTER_PATH;
            delete process.env.AR_REPORT_PATH;
            delete process.env.CUSTOMER_MASTER_PATH;
            try {
                const res = await request(makeApp(router)).post('/ar/sync-now');
                expect(res.status).toBe(400);
            } finally {
                if (savedAR !== undefined) process.env.AR_REPORT_PATH = savedAR;
                if (savedCM !== undefined) process.env.CUSTOMER_MASTER_PATH = savedCM;
            }
        });
    });

    describe('GET /ar/upload/status', () => {
        it('returns 200 with hidden progress div when no jobs active', async () => {
            const res = await request(makeApp(router)).get('/ar/upload/status');
            expect(res.status).toBe(200);
            expect(res.text).toContain('ar-upload-progress');
        });
    });
});
