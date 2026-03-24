// tests/routes/ar/customers.test.js
jest.mock('../../../src/prisma', () => require('../../setup').makePrismaMock());
jest.mock('../../../src/queue', () => ({
    uploadQueue: { add: jest.fn().mockResolvedValue({ id: 'mock-job-id' }) },
    connection:  { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') }
}));

const request  = require('supertest');
const prisma   = require('../../../src/prisma');
const { makeApp } = require('../../setup');
const router   = require('../../../src/routes/ar/customers');

describe('Customer routes', () => {
    beforeEach(() => jest.clearAllMocks());

    describe('POST /ar/customers/:code/dispute', () => {
        it('returns 200 and creates a dispute for a new code', async () => {
            prisma.customerDispute.findUnique.mockResolvedValue(null);
            prisma.customerMaster.findUnique.mockResolvedValue({ customerName: 'Test Co' });
            prisma.customerDispute.create.mockResolvedValue({});
            const res = await request(makeApp(router)).post('/ar/customers/BNG001/dispute');
            expect(res.status).toBe(200);
            expect(res.text).toContain('Disputed');
        });
    });

    describe('GET /ar/customers/:code/export', () => {
        it('returns 200 with xlsx content-type', async () => {
            prisma.invoice.findMany.mockResolvedValue([]);
            const res = await request(makeApp(router)).get('/ar/customers/BNG001/export');
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toContain(
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            );
        });
    });

    describe('GET /ar/customers/:code/statement', () => {
        const mockInvoices = [
            {
                id: 'inv1', invoiceNo: 'BNG-2526-001', customerCode: 'BNG001',
                customerName: 'Test Co', invoiceDate: new Date('2026-01-01'),
                dueDate: new Date('2026-03-24'), balanceAmount: 50000,
                invoiceAmount: 60000, paidAmount: 10000, agingDays: 82, status: 'ACTIVE'
            },
            {
                id: 'inv2', invoiceNo: 'BNG-2526-002', customerCode: 'BNG001',
                customerName: 'Test Co', invoiceDate: new Date('2026-02-15'),
                dueDate: new Date('2026-03-24'), balanceAmount: 25000,
                invoiceAmount: 25000, paidAmount: 0, agingDays: 37, status: 'ACTIVE'
            }
        ];

        // Confirmation: route renders with data
        it('returns 200 and renders statement HTML', async () => {
            prisma.invoice.findMany.mockResolvedValue(mockInvoices);
            prisma.customerMaster.findUnique.mockResolvedValue({ customerName: 'Test Co', mobileNo: null });
            const res = await request(makeApp(router)).get('/ar/customers/BNG001/statement');
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toMatch(/html/);
        });

        // Integration: embedded data for client-side PDF generation
        it('embeds _stmtData JSON for client-side PDF generation', async () => {
            prisma.invoice.findMany.mockResolvedValue(mockInvoices);
            prisma.customerMaster.findUnique.mockResolvedValue({ customerName: 'Test Co', mobileNo: null });
            const res = await request(makeApp(router)).get('/ar/customers/BNG001/statement');
            expect(res.text).toContain('_stmtData');
            expect(res.text).toContain('invoices:');
            expect(res.text).toContain('BNG-2526-001');
        });

        // Integration: jsPDF script paths present in page
        it('references jsPDF from local paths', async () => {
            prisma.invoice.findMany.mockResolvedValue(mockInvoices);
            prisma.customerMaster.findUnique.mockResolvedValue({ customerName: 'Test Co', mobileNo: null });
            const res = await request(makeApp(router)).get('/ar/customers/BNG001/statement');
            expect(res.text).toContain('/jspdf.umd.min.js');
            expect(res.text).toContain('/jspdf.plugin.autotable.min.js');
        });

        // Integration: customer name from master takes priority
        it('uses customerMaster name when available', async () => {
            prisma.invoice.findMany.mockResolvedValue(mockInvoices);
            prisma.customerMaster.findUnique.mockResolvedValue({ customerName: 'Master Name Override', mobileNo: null });
            const res = await request(makeApp(router)).get('/ar/customers/BNG001/statement');
            expect(res.text).toContain('Master Name Override');
        });

        // Integration: falls back to invoice customerName when no master record
        it('falls back to invoice customerName when master record is absent', async () => {
            prisma.invoice.findMany.mockResolvedValue(mockInvoices);
            prisma.customerMaster.findUnique.mockResolvedValue(null);
            const res = await request(makeApp(router)).get('/ar/customers/BNG001/statement');
            expect(res.status).toBe(200);
            expect(res.text).toContain('Test Co');
        });

        // Integration: ?inv= filter passes id constraint to Prisma
        it('filters invoices by id when ?inv= is provided', async () => {
            prisma.invoice.findMany.mockResolvedValue([mockInvoices[0]]);
            prisma.customerMaster.findUnique.mockResolvedValue({ customerName: 'Test Co', mobileNo: null });
            await request(makeApp(router)).get('/ar/customers/BNG001/statement?inv=inv1');
            const call = prisma.invoice.findMany.mock.calls[0][0];
            expect(call.where).toHaveProperty('id');
        });

        // Regression: unauthenticated request is rejected
        it('returns 302 for unauthenticated request', async () => {
            const res = await request(makeApp(router, { userId: null })).get('/ar/customers/BNG001/statement');
            expect(res.status).toBe(302);
        });
    });

    describe('GET /ar/customer/:code/trend (singular path)', () => {
        it('returns 200 and renders trend view', async () => {
            prisma.aRSnapshot.findMany.mockResolvedValue([]);
            prisma.invoice.findMany.mockResolvedValue([]);
            const res = await request(makeApp(router)).get('/ar/customer/BNG001/trend');
            expect(res.status).toBe(200);
        });
    });

    describe('PUT /ar/customers/:customerCode/mobile', () => {
        it('returns 200 and saves the mobile number', async () => {
            prisma.customerMaster.upsert.mockResolvedValue({});
            const res = await request(makeApp(router))
                .put('/ar/customers/BNG001/mobile')
                .send({ mobileNo: '9876543210' });
            expect(res.status).toBe(200);
            expect(res.text).toContain('9876543210');
        });

        it('returns 403 for USER role', async () => {
            const res = await request(makeApp(router, { userRole: 'USER', userModules: [] }))
                .put('/ar/customers/BNG001/mobile')
                .send({ mobileNo: '9876543210' });
            expect(res.status).toBe(403);
        });
    });

    describe('POST /ar/customers/:customerCode/mobile/fetch', () => {
        it('returns 404 when no master number exists', async () => {
            prisma.customerMaster.findUnique.mockResolvedValue(null);
            const res = await request(makeApp(router))
                .post('/ar/customers/BNG001/mobile/fetch');
            expect(res.status).toBe(404);
        });

        it('returns 200 and restores master mobile number', async () => {
            prisma.customerMaster.findUnique.mockResolvedValue({ masterMobileNo: '9876543210' });
            prisma.customerMaster.update.mockResolvedValue({});
            const res = await request(makeApp(router))
                .post('/ar/customers/BNG001/mobile/fetch');
            expect(res.status).toBe(200);
            expect(res.text).toContain('9876543210');
        });
    });
});
