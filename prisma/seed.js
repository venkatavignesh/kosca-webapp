const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const prisma = new PrismaClient();

async function main() {
    console.log('Starting seed...');

    const adminPassword = await bcrypt.hash('admin123', 10);

    const admin = await prisma.user.upsert({
        where: { email: 'admin@kosca.com' },
        update: {},
        create: {
            name: 'System Admin',
            email: 'admin@kosca.com',
            password: adminPassword,
            role: 'ADMIN',
            modules: ['ar_dashboard', 'ar_directory', 'ar_upload']
        }
    });

    console.log('Seed finished:', admin);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
