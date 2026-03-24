// src/config/categories.js
// Customer categorization rules:
//   Key Accounts  — customer name STARTS WITH any of these prefixes
//   Sub Distributors — specific customer codes
//   Non-Key — everything else

const KEY_ACCOUNT_PREFIXES = [
    'PAULSONS BEAUTY AND FASHION',
    'BODYCRAFT SALON SKIN & COSMETOLOGY',
    'CKR RETAIL',
    'JCB SALONS',
    'HEALTH & GLOW',
];

const SUB_DISTRIBUTOR_CODES = [
    '2002748531',
    '2002748532',
    '2002748533',
    '2002748534',
    '2002748535',
    '2002748536',
    '2002748537',
    '2002772265',
    '2002772271',
    '2002772272',
    '2002772273',
    '2002772274',
    '2002772275',
];

/**
 * Fetch customer codes that qualify as Key Accounts.
 * A customer is a key account if its name STARTS with any prefix (case-insensitive).
 * Customers whose name only contains the prefix at the end are excluded.
 */
async function getKeyAccountCodes(prisma) {
    if (KEY_ACCOUNT_PREFIXES.length === 0) return [];
    const rows = await prisma.invoice.findMany({
        where: {
            status: 'ACTIVE',
            OR: KEY_ACCOUNT_PREFIXES.map(prefix => ({
                customerName: { startsWith: prefix, mode: 'insensitive' }
            }))
        },
        select: { customerCode: true },
        distinct: ['customerCode']
    });
    return rows.map(r => r.customerCode);
}

module.exports = { KEY_ACCOUNT_PREFIXES, SUB_DISTRIBUTOR_CODES, getKeyAccountCodes };
