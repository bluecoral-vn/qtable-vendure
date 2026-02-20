import { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { PluginCommonModule, VendurePlugin } from '@vendure/core';

import { adminApiExtensions, shopApiExtensions } from './api/api-extensions';
import { TenantAdminResolver } from './api/tenant-admin.resolver';
import { TenantShopResolver } from './api/tenant-shop.resolver';
import { Tenant, TenantDomain } from './entities';
import { TenantContextMiddleware } from './middleware';
import {
    TenantService,
    TenantResolutionService,
    TenantProvisioningService,
} from './services';

/**
 * QTablePlugin — Entry point for all custom QTable SaaS business logic.
 *
 * Registers multi-tenant entities (Tenant, TenantDomain), services
 * for tenant lifecycle management and provisioning, API extensions
 * for Admin and Shop APIs, and the TenantContextMiddleware for
 * domain-based tenant resolution.
 *
 * @see ARCHITECTURE.md for development guidelines
 * @see docs/plugin-architecture.md for design decisions
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    entities: [Tenant, TenantDomain],
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: [TenantAdminResolver],
    },
    shopApiExtensions: {
        schema: shopApiExtensions,
        resolvers: [TenantShopResolver],
    },
    providers: [
        TenantService,
        TenantResolutionService,
        TenantProvisioningService,
        TenantContextMiddleware,
    ],
})
export class QTablePlugin implements NestModule {
    configure(consumer: MiddlewareConsumer) {
        consumer
            .apply(TenantContextMiddleware)
            .forRoutes('*');
    }
}
