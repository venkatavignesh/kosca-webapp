// tests/routes/ar/dashboard.test.js
jest.mock('../../../src/prisma', () => require('../../setup').makePrismaMock());
jest.mock('../../../src/queue', () => ({
    uploadQueue: { add: jest.fn().mockResolvedValue({ id: 'mock-job-id' }) },
    connection:  { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') }
}));

const request = require('supertest');
const prisma  = require('../../../src/prisma');
const { makeApp } = require('../../setup');

// Import AFTER mocks are declared
const router = require('../../../src/routes/ar/dashboard');

describe('GET /ar — AR metrics dashboard', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns 200 for authenticated ADMIN with ar_dashboard module', async () => {
        const res = await request(makeApp(router)).get('/ar');
        expect(res.status).toBe(200);
        expect(res.text.length).toBeGreaterThan(50);
    });

    it('redirects to /login when unauthenticated', async () => {
        const res = await request(makeApp(router, { userId: null })).get('/ar');
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/login');
    });

    it('returns 403 when user has no ar_dashboard module and is not ADMIN', async () => {
        const res = await request(makeApp(router, {
            userRole:    'USER',
            userModules: []
        })).get('/ar');
        expect(res.status).toBe(403);
    });

    it('calls prisma.invoice.findMany to fetch invoices', async () => {
        prisma.invoice.findMany.mockResolvedValue([
            { balanceAmount: 5000, agingDays: 45, customerCode: 'BNG001', siteName: 'Bangalore' }
        ]);
        const res = await request(makeApp(router)).get('/ar');
        expect(res.status).toBe(200);
        expect(prisma.invoice.findMany).toHaveBeenCalled();
    });
});
