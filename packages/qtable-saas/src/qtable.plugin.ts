import { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PluginCommonModule, VendurePlugin } from '@vendure/core';

import { adminApiExtensions, shopApiExtensions } from './api/api-extensions';
import { TenantAdminResolver } from './api/tenant-admin.resolver';
import { TenantShopResolver } from './api/tenant-shop.resolver';
import { Tenant, TenantDomain, AuditLog } from './entities';
import { TenantGuard, DefaultChannelGuard } from './guards';
import { TenantContextMiddleware } from './middleware';
import {
    TenantService,
    TenantResolutionService,
    TenantProvisioningService,
    AuditService,
} from './services';

/**
 * QTablePlugin — Entry point for all custom QTable SaaS business logic.
 *
 * Registers multi-tenant entities (Tenant, TenantDomain, AuditLog), services
 * for tenant lifecycle management and provisioning, API extensions
 * for Admin and Shop APIs, the TenantContextMiddleware for
 * domain-based tenant resolution, and security guards (TenantGuard,
 * DefaultChannelGuard) for tenant isolation enforcement.
 *
 * @see ARCHITECTURE.md for development guidelines
 * @see docs/plugin-architecture.md for design decisions
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    entities: [Tenant, TenantDomain, AuditLog],
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
        AuditService,
        {
            provide: APP_GUARD,
            useClass: TenantGuard,
        },
        {
            provide: APP_GUARD,
            useClass: DefaultChannelGuard,
        },
    ],
})
export class QTablePlugin implements NestModule {
    configure(consumer: MiddlewareConsumer) {
        consumer
            .apply(TenantContextMiddleware)
            .forRoutes('*');
    }
}
