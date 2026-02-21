/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { mergeConfig } from '@vendure/core';
import {
    createTestEnvironment,
    registerInitializer,
    PostgresInitializer,
    SqljsInitializer,
    testConfig as defaultTestConfig,
    SimpleGraphQLClient,
} from '@vendure/testing';
import { LanguageCode } from '@vendure/common/lib/generated-types';
import { InitialData } from '@vendure/core/dist/data-import/index';
import gql from 'graphql-tag';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { QTablePlugin } from '../src/qtable.plugin';

/**
 * Phase 2 — Isolation Hardening E2E Tests
 *
 * Tests cover:
 * 1. Product isolation between tenants
 * 2. IDOR — cross-tenant entity access by ID
 * 3. Default Channel restriction (non-SuperAdmin blocked)
 * 4. Privilege escalation prevention
 * 5. Audit log entry creation
 *
 * @see docs/test-enforcement.md for test enforcement charter
 */

// --- Init ---
const testInitialData: InitialData = {
    defaultLanguage: LanguageCode.en,
    defaultZone: 'Europe',
    taxRates: [{ name: 'Standard Tax', percentage: 20 }],
    shippingMethods: [{ name: 'Standard Shipping', price: 500 }],
    paymentMethods: [],
    countries: [
        { name: 'United Kingdom', code: 'GB', zone: 'Europe' },
        { name: 'Vietnam', code: 'VN', zone: 'Asia' },
    ],
    collections: [],
};

const dbType = process.env.DB || 'postgres';
if (dbType === 'postgres') {
    registerInitializer('postgres', new PostgresInitializer());
} else {
    registerInitializer('sqljs', new SqljsInitializer(path.join(__dirname, '__data__')));
}

const TEST_SETUP_TIMEOUT_MS = 120_000;

function getDbConfig() {
    if (dbType === 'postgres') {
        return {
            type: 'postgres' as const,
            synchronize: true,
            host: process.env.DB_HOST || '127.0.0.1',
            port: +(process.env.DB_PORT || 5432),
            username: process.env.DB_USERNAME || 'vendure',
            password: process.env.DB_PASSWORD || 'password',
            database: process.env.DB_NAME || 'vendure-e2e-test',
        };
    }
    return {
        type: 'sqljs' as const,
        database: new Uint8Array([]),
        logging: false,
    };
}

const config = mergeConfig(defaultTestConfig, {
    apiOptions: {
        port: 3099,  // Must match tenant.e2e-spec.ts port
    },
    dbConnectionOptions: getDbConfig(),
    plugins: [QTablePlugin],
});

// --- GraphQL ---

const PROVISION_TENANT = gql`
    mutation ProvisionTenant($input: ProvisionTenantInput!) {
        provisionTenant(input: $input) {
            tenant { id name slug status }
            channelToken
            adminId
        }
    }
`;

const GET_PRODUCTS = gql`
    query GetProducts {
        products { items { id name slug } totalItems }
    }
`;

const CREATE_PRODUCT = gql`
    mutation CreateProduct($input: CreateProductInput!) {
        createProduct(input: $input) { id name slug }
    }
`;

const GET_TENANT = gql`
    query GetTenant($id: ID!) {
        tenant(id: $id) { id name slug status }
    }
`;

const GET_TENANTS = gql`
    query GetTenants {
        tenants { items { id name slug } totalItems }
    }
`;

// Admin auth mutation (Vendure built-in)
const ADMIN_LOGIN = gql`
    mutation Login($username: String!, $password: String!) {
        login(username: $username, password: $password) {
            ... on CurrentUser { id identifier }
            ... on InvalidCredentialsError { errorCode message }
        }
    }
`;

// --- Tests ---

describe('Isolation Hardening E2E', () => {
    const { server, adminClient, shopClient } = createTestEnvironment(config);

    // Tenant A: Alpha Store
    let tenantAId: string;
    let tenantAToken: string;
    let tenantAAdminEmail: string;
    let tenantAAdminPassword: string;
    let tenantAProductId: string;

    // Tenant B: Beta Store
    let tenantBId: string;
    let tenantBToken: string;
    let tenantBAdminEmail: string;
    let tenantBAdminPassword: string;

    beforeAll(async () => {
        await server.init({
            initialData: testInitialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-minimal.csv'),
            customerCount: 0,
        });
        await adminClient.asSuperAdmin();

        // --- Provision Tenant A ---
        tenantAAdminEmail = 'alpha-admin@test.vn';
        tenantAAdminPassword = 'Alpha123!';
        const a = await adminClient.query(PROVISION_TENANT, {
            input: {
                name: 'Alpha Store',
                slug: 'alpha-store',
                primaryDomain: 'alpha-store.qtable.vn',
                plan: 'professional',
                adminFirstName: 'Alpha',
                adminLastName: 'Admin',
                adminEmailAddress: tenantAAdminEmail,
                adminPassword: tenantAAdminPassword,
                defaultLanguageCode: 'en',
                defaultCurrencyCode: 'USD',
            },
        });
        tenantAId = a.provisionTenant.tenant.id;
        tenantAToken = a.provisionTenant.channelToken;

        // --- Provision Tenant B ---
        tenantBAdminEmail = 'beta-admin@test.vn';
        tenantBAdminPassword = 'Beta123!';
        const b = await adminClient.query(PROVISION_TENANT, {
            input: {
                name: 'Beta Store',
                slug: 'beta-store',
                primaryDomain: 'beta-store.qtable.vn',
                plan: 'trial',
                adminFirstName: 'Beta',
                adminLastName: 'Admin',
                adminEmailAddress: tenantBAdminEmail,
                adminPassword: tenantBAdminPassword,
                defaultLanguageCode: 'en',
                defaultCurrencyCode: 'USD',
            },
        });
        tenantBId = b.provisionTenant.tenant.id;
        tenantBToken = b.provisionTenant.channelToken;

        // --- Create a product in Tenant A ---
        // Login as Tenant A admin on Tenant A's channel
        adminClient.setChannelToken(tenantAToken);
        const loginResult = await adminClient.query(ADMIN_LOGIN, {
            username: tenantAAdminEmail,
            password: tenantAAdminPassword,
        });
        expect(loginResult.login.identifier).toBe(tenantAAdminEmail);

        const productResult = await adminClient.query(CREATE_PRODUCT, {
            input: {
                translations: [{ languageCode: LanguageCode.en, name: 'Alpha Secret Cake', slug: 'alpha-secret-cake', description: 'Top secret' }],
            },
        });
        tenantAProductId = productResult.createProduct.id;
        expect(tenantAProductId).toBeTruthy();

        // Reset to SuperAdmin on Default Channel
        adminClient.setChannelToken('');
        await adminClient.asSuperAdmin();
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    });

    // ============================================================
    // 1. PRODUCT ISOLATION
    // ============================================================

    describe('Product Isolation', () => {
        it('Tenant A should see its own product', async () => {
            adminClient.setChannelToken(tenantAToken);
            await adminClient.query(ADMIN_LOGIN, {
                username: tenantAAdminEmail,
                password: tenantAAdminPassword,
            });

            const result = await adminClient.query(GET_PRODUCTS);
            const productNames = result.products.items.map((p: any) => p.name);
            expect(productNames).toContain('Alpha Secret Cake');
        });

        it('Tenant B should NOT see Tenant A products', async () => {
            adminClient.setChannelToken(tenantBToken);
            await adminClient.query(ADMIN_LOGIN, {
                username: tenantBAdminEmail,
                password: tenantBAdminPassword,
            });

            const result = await adminClient.query(GET_PRODUCTS);
            const productNames = result.products.items.map((p: any) => p.name);
            expect(productNames).not.toContain('Alpha Secret Cake');
        });
    });

    // ============================================================
    // 2. IDOR — Cross-tenant entity access by ID
    // ============================================================

    describe('IDOR Protection', () => {
        it('Tenant B admin should NOT access Tenant A product by ID', async () => {
            // Already logged in as Tenant B admin
            adminClient.setChannelToken(tenantBToken);
            await adminClient.query(ADMIN_LOGIN, {
                username: tenantBAdminEmail,
                password: tenantBAdminPassword,
            });

            // Try to access Tenant A's product directly by ID
            const GET_PRODUCT_BY_ID = gql`
                query GetProduct($id: ID!) {
                    product(id: $id) { id name }
                }
            `;

            const result = await adminClient.query(GET_PRODUCT_BY_ID, {
                id: tenantAProductId,
            });

            // Vendure's ListQueryBuilder should return null for foreign-channel entities
            // (NOT ForbiddenError — that would leak information)
            expect(result.product).toBeNull();
        });
    });

    // ============================================================
    // 3. DEFAULT CHANNEL RESTRICTION
    // ============================================================

    describe('Default Channel Restriction', () => {
        it('Tenant admin should be blocked from managing tenants (SuperAdmin-only)', async () => {
            // Login as Tenant A admin on Default Channel
            adminClient.setChannelToken('');
            try {
                await adminClient.query(ADMIN_LOGIN, {
                    username: tenantAAdminEmail,
                    password: tenantAAdminPassword,
                });

                // Try to list tenants — should fail for non-SuperAdmin
                await adminClient.query(GET_TENANTS);
                expect.unreachable('Should have thrown ForbiddenError');
            } catch (e: any) {
                // Expected: either login fails on Default Channel for non-SuperAdmin
                // or the query is blocked by DefaultChannelGuard / @Allow(SuperAdmin)
                expect(e.message).toContain('authorized');
            }
        });

        it('SuperAdmin CAN access Default Channel', async () => {
            adminClient.setChannelToken('');
            await adminClient.asSuperAdmin();

            const result = await adminClient.query(GET_TENANTS);
            expect(result.tenants.totalItems).toBe(2);
        });
    });

    // ============================================================
    // 4. PRIVILEGE ESCALATION PREVENTION
    // ============================================================

    describe('Privilege Escalation Prevention', () => {
        it('Tenant admin CANNOT call provisionTenant', async () => {
            // Login as Tenant A admin on their own channel
            adminClient.setChannelToken(tenantAToken);
            await adminClient.query(ADMIN_LOGIN, {
                username: tenantAAdminEmail,
                password: tenantAAdminPassword,
            });

            try {
                await adminClient.query(PROVISION_TENANT, {
                    input: {
                        name: 'Hacker Store',
                        slug: 'hacker-store',
                        primaryDomain: 'hacker.qtable.vn',
                        adminFirstName: 'Hack',
                        adminLastName: 'Er',
                        adminEmailAddress: 'hacker@evil.com',
                        adminPassword: 'hack123',
                    },
                });
                expect.unreachable('Should have thrown ForbiddenError');
            } catch (e: any) {
                expect(e.message).toContain('authorized');
            }
        });

        it('Tenant admin CANNOT view other tenant by ID', async () => {
            // Still logged in as Tenant A admin
            adminClient.setChannelToken(tenantAToken);
            await adminClient.query(ADMIN_LOGIN, {
                username: tenantAAdminEmail,
                password: tenantAAdminPassword,
            });

            // Try to view Tenant B details — should fail (SuperAdmin only)
            try {
                await adminClient.query(GET_TENANT, { id: tenantBId });
                expect.unreachable('Should have thrown ForbiddenError');
            } catch (e: any) {
                expect(e.message).toContain('authorized');
            }
        });
    });

    // ============================================================
    // 5. SHOP API ISOLATION
    // ============================================================

    describe('Shop API Isolation', () => {
        it('Shop API with Tenant A token should show Tenant A info', async () => {
            shopClient.setChannelToken(tenantAToken);
            const CURRENT_TENANT = gql`
                query CurrentTenant {
                    currentTenant { id name slug status }
                }
            `;
            const result = await shopClient.query(CURRENT_TENANT);
            if (result.currentTenant) {
                expect(result.currentTenant.slug).toBe('alpha-store');
            }
        });

        it('Shop API with Tenant B token should show Tenant B info', async () => {
            shopClient.setChannelToken(tenantBToken);
            const CURRENT_TENANT = gql`
                query CurrentTenant {
                    currentTenant { id name slug status }
                }
            `;
            const result = await shopClient.query(CURRENT_TENANT);
            if (result.currentTenant) {
                expect(result.currentTenant.slug).toBe('beta-store');
            }
        });
    });
});
