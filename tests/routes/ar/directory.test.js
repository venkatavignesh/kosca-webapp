// tests/routes/ar/directory.test.js
jest.mock('../../../src/prisma', () => require('../../setup').makePrismaMock());
jest.mock('../../../src/queue', () => ({
    uploadQueue: { add: jest.fn().mockResolvedValue({ id: 'mock-job-id' }) },
    connection:  { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') }
}));

const request  = require('supertest');
const prisma   = require('../../../src/prisma');
const { makeApp } = require('../../setup');
const router   = require('../../../src/routes/ar/directory');

describe('Directory routes', () => {
    beforeEach(() => jest.clearAllMocks());

    describe('GET /ar/directory', () => {
        it('returns 200 for authenticated user with ar_directory module', async () => {
            prisma.invoice.findMany.mockResolvedValue([]);
            prisma.customerGroup.findMany.mockResolvedValue([]);
            prisma.customerMaster.findMany.mockResolvedValue([]);
            const res = await request(makeApp(router)).get('/ar/directory');
            expect(res.status).toBe(200);
        });

        it('builds allPsrData from customerMaster and invoice queries', async () => {
            prisma.customerMaster.findMany.mockResolvedValue([
                { customerCode: 'BNG001', psrName: 'Alice' },
                { customerCode: 'HYD001', psrName: 'Bob' }
            ]);
            prisma.invoice.findMany.mockResolvedValue([
                { customerCode: 'BNG001', siteName: 'Bangalore' },
                { customerCode: 'HYD001', siteName: 'Hyderabad' }
            ]);
            prisma.customerGroup.findMany.mockResolvedValue([]);
            const res = await request(makeApp(router)).get('/ar/directory');
            expect(res.status).toBe(200);
            expect(res.text).toContain('Alice');
            expect(res.text).toContain('Bob');
        });

        it('passes selectedPsrs from query to template', async () => {
            prisma.customerMaster.findMany.mockResolvedValue([
                { customerCode: 'BNG001', psrName: 'Alice' }
            ]);
            prisma.invoice.findMany.mockResolvedValue([
                { customerCode: 'BNG001', siteName: 'Bangalore' }
            ]);
            prisma.customerGroup.findMany.mockResolvedValue([]);
            const res = await request(makeApp(router)).get('/ar/directory?psr=Alice');
            expect(res.status).toBe(200);
            expect(res.text).toContain('checked');
        });

        it('redirects to /login when unauthenticated', async () => {
            const res = await request(makeApp(router, { userId: null })).get('/ar/directory');
            expect(res.status).toBe(302);
            expect(res.headers.location).toBe('/login');
        });

        it('returns 403 when user lacks ar_directory module', async () => {
            const res = await request(makeApp(router, { userRole: 'USER', userModules: [] })).get('/ar/directory');
            expect(res.status).toBe(403);
        });
    });

    describe('GET /ar/groups', () => {
        it('returns 200', async () => {
            const res = await request(makeApp(router)).get('/ar/groups');
            expect(res.status).toBe(200);
        });
    });

    describe('GET /ar/groups-data', () => {
        it('returns 200 with HTML content for tab=key', async () => {
            // getKeyAccountCodes queries invoices with prefix match, then groups-data queries CustomerGroup
            prisma.invoice.findMany.mockResolvedValue([]);
            prisma.customerGroup.findMany.mockResolvedValue([]);
            prisma.customerMaster.findMany.mockResolvedValue([]);
            const res = await request(makeApp(router)).get('/ar/groups-data?tab=key');
            expect(res.status).toBe(200);
            expect(res.text).toContain('<');
        });

        it('returns 200 for tab=ungrouped', async () => {
            prisma.invoice.findMany.mockResolvedValue([]);
            prisma.customerGroup.findMany.mockResolvedValue([]);
            prisma.customerMaster.findMany.mockResolvedValue([]);
            const res = await request(makeApp(router)).get('/ar/groups-data?tab=ungrouped');
            expect(res.status).toBe(200);
        });
    });

    describe('GET /ar/key-accounts, /ar/sub-distributors', () => {
        it('GET /ar/key-accounts redirects to directory', async () => {
            const res = await request(makeApp(router)).get('/ar/key-accounts');
            expect(res.status).toBe(302);
            expect(res.headers.location).toContain('keyOnly=1');
        });

        it('GET /ar/sub-distributors redirects to directory', async () => {
            const res = await request(makeApp(router)).get('/ar/sub-distributors');
            expect(res.status).toBe(302);
            expect(res.headers.location).toContain('subOnly=1');
        });
    });
});
