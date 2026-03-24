// tests/routes/ar/invoices.test.js
jest.mock('../../../src/prisma', () => require('../../setup').makePrismaMock());
jest.mock('../../../src/queue', () => ({
    uploadQueue: { add: jest.fn().mockResolvedValue({ id: 'mock-job-id' }) },
    connection:  { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') }
}));

const request  = require('supertest');
const prisma   = require('../../../src/prisma');
const { makeApp } = require('../../setup');
const router   = require('../../../src/routes/ar/invoices');

describe('Invoice routes', () => {
    beforeEach(() => jest.clearAllMocks());

    describe('GET /ar/invoices', () => {
        it('returns 200 for ADMIN (default — no filter flags)', async () => {
            const res = await request(makeApp(router)).get('/ar/invoices');
            expect(res.status).toBe(200);
        });

        it('returns 200 for keyOnly=1 with ADMIN role', async () => {
            const res = await request(makeApp(router)).get('/ar/invoices?keyOnly=1');
            expect(res.status).toBe(200);
        });

        it('returns 403 for keyOnly=1 when USER lacks ar_key_accounts module', async () => {
            const res = await request(makeApp(router, {
                userRole:    'USER',
                userModules: ['ar_directory']
            })).get('/ar/invoices?keyOnly=1');
            expect(res.status).toBe(403);
            expect(res.text).toContain('Access denied');
        });

        it('returns 403 for subOnly=1 when USER lacks ar_sub_distributors', async () => {
            const res = await request(makeApp(router, {
                userRole:    'USER',
                userModules: ['ar_directory']
            })).get('/ar/invoices?subOnly=1');
            expect(res.status).toBe(403);
        });

        it('returns 403 when USER lacks ar_directory (default view)', async () => {
            const res = await request(makeApp(router, {
                userRole:    'USER',
                userModules: []
            })).get('/ar/invoices');
            expect(res.status).toBe(403);
            expect(res.text).toContain('Module not assigned');
        });

        it('calls prisma.invoice.groupBy for pagination', async () => {
            prisma.invoice.groupBy.mockResolvedValue([]);
            await request(makeApp(router)).get('/ar/invoices');
            expect(prisma.invoice.groupBy).toHaveBeenCalled();
        });

        it('filters by PSR name when psr param is provided', async () => {
            prisma.customerMaster.findMany.mockResolvedValue([
                { customerCode: 'BNG001', psrName: 'Alice' }
            ]);
            prisma.invoice.groupBy.mockResolvedValue([]);
            const res = await request(makeApp(router)).get('/ar/invoices?psr=Alice');
            expect(res.status).toBe(200);
            // customerMaster.findMany called for PSR lookup
            expect(prisma.customerMaster.findMany).toHaveBeenCalledWith(
                expect.objectContaining({ where: { psrName: { in: ['Alice'] } } })
            );
        });

        it('intersects PSR codes with existing finalCodes when multiple filters active', async () => {
            // PSR filter on top of bucket filter: both reduce the code set
            prisma.customerMaster.findMany.mockResolvedValue([
                { customerCode: 'BNG001', psrName: 'Alice' }
            ]);
            // bucket filter returns a different customer code
            prisma.invoice.findMany
                .mockResolvedValueOnce([{ customerCode: 'BNG002' }]) // bucket codes
                .mockResolvedValue([]);                               // rawInvoices
            prisma.invoice.groupBy.mockResolvedValue([]);
            const res = await request(makeApp(router)).get('/ar/invoices?psr=Alice&bucket=0_30');
            expect(res.status).toBe(200);
        });

        it('returns 200 with no results when psr matches no customers', async () => {
            prisma.customerMaster.findMany.mockResolvedValue([]); // no match
            prisma.invoice.groupBy.mockResolvedValue([]);
            const res = await request(makeApp(router)).get('/ar/invoices?psr=Ghost');
            expect(res.status).toBe(200);
        });

        it('handles multiple PSR values as array', async () => {
            prisma.customerMaster.findMany.mockResolvedValue([
                { customerCode: 'BNG001', psrName: 'Alice' },
                { customerCode: 'HYD001', psrName: 'Bob' }
            ]);
            prisma.invoice.groupBy.mockResolvedValue([]);
            const res = await request(makeApp(router)).get('/ar/invoices?psr=Alice&psr=Bob');
            expect(res.status).toBe(200);
            expect(prisma.customerMaster.findMany).toHaveBeenCalledWith(
                expect.objectContaining({ where: { psrName: { in: ['Alice', 'Bob'] } } })
            );
        });
    });

    describe('GET /ar/invoices/:customerCode', () => {
        it('returns 200 with customer invoices', async () => {
            prisma.invoice.findMany.mockResolvedValue([
                { invoiceNo: 'INV001', customerCode: 'BNG001', customerName: 'Test Co',
                  balanceAmount: 1000, agingDays: 30, status: 'ACTIVE',
                  invoiceDate: new Date(), dueDate: new Date() }
            ]);
            prisma.customerMaster.findUnique.mockResolvedValue(null);
            prisma.customerDispute.findUnique.mockResolvedValue(null);
            prisma.customerGroup.findUnique.mockResolvedValue(null);
            prisma.customerGroup.findMany.mockResolvedValue([]);
            const res = await request(makeApp(router)).get('/ar/invoices/BNG001');
            expect(res.status).toBe(200);
        });
    });
});
