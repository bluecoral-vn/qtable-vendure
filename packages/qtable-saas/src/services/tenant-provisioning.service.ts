import { Injectable } from '@nestjs/common';
import {
    ChannelService,
    EventBus,
    isGraphQlErrorResult,
    Permission,
    RequestContext,
    RequestContextService,
    RoleService,
    SellerService,
    AdministratorService,
    TransactionalConnection,
} from '@vendure/core';
import { CurrencyCode, LanguageCode } from '@vendure/common/lib/generated-types';

import { TenantStatus } from '../entities/tenant-status.enum';
import { Tenant } from '../entities/tenant.entity';
import { TenantService } from './tenant.service';
import { TenantCreatedEvent } from '../events/tenant.events';

/**
 * Input for provisioning a new tenant.
 */
export interface ProvisionTenantInput {
    /** Human-readable tenant name, e.g. "Alice's Bakery" */
    name: string;
    /** URL-safe unique slug, e.g. "alices-bakery" */
    slug: string;
    /** Primary domain for the tenant, e.g. "alices-bakery.qtable.vn" */
    primaryDomain: string;
    /** Plan identifier, defaults to 'trial' */
    plan?: string;
    /** Admin user details */
    admin: {
        firstName: string;
        lastName: string;
        emailAddress: string;
        password: string;
    };
    /** Channel defaults */
    defaults?: {
        languageCode?: LanguageCode;
        currencyCode?: CurrencyCode;
        pricesIncludeTax?: boolean;
    };
}

/**
 * Result of tenant provisioning.
 */
export interface ProvisionTenantResult {
    tenant: Tenant;
    channelToken: string;
    adminId: string | number;
}

/**
 * TenantProvisioningService — orchestrates the creation of all resources
 * needed for a new tenant:
 *
 * 1. Seller — represents the tenant's business
 * 2. Channel — Vendure's data scope (linked to seller)
 * 3. Role — tenant admin role with appropriate permissions
 * 4. Administrator — the tenant's admin user
 * 5. Tenant entity — links to the Channel
 * 6. TenantDomain — maps domain to tenant
 *
 * The entire process is idempotent-safe: if a tenant with the given slug
 * already exists, an error is thrown.
 *
 * @see tenant-lifecycle.md §2 "Provisioning"
 * @see plugin-architecture.md §4 "TenantProvisioningService"
 */
@Injectable()
export class TenantProvisioningService {
    constructor(
        private connection: TransactionalConnection,
        private channelService: ChannelService,
        private sellerService: SellerService,
        private roleService: RoleService,
        private administratorService: AdministratorService,
        private requestContextService: RequestContextService,
        private tenantService: TenantService,
        private eventBus: EventBus,
    ) { }

    /**
     * Provision a new tenant with all required resources.
     *
     * Must be called from a SuperAdmin RequestContext.
     */
    async provision(ctx: RequestContext, input: ProvisionTenantInput): Promise<ProvisionTenantResult> {
        // 1. Validate: slug must be unique
        const existing = await this.tenantService.findBySlug(ctx, input.slug);
        if (existing) {
            throw new Error(`Tenant with slug "${input.slug}" already exists`);
        }

        const defaults = {
            languageCode: input.defaults?.languageCode ?? LanguageCode.en,
            currencyCode: input.defaults?.currencyCode ?? CurrencyCode.USD,
            pricesIncludeTax: input.defaults?.pricesIncludeTax ?? true,
        };

        // 2. Create Seller
        const seller = await this.sellerService.create(ctx, {
            name: input.name,
        });

        // 3. Create Channel (linked to seller)
        // Need default zones — use from the default channel
        const defaultChannel = await this.channelService.getDefaultChannel(ctx);
        const channelResult = await this.channelService.create(ctx, {
            code: `tenant-${input.slug}`,
            token: `tenant-${input.slug}-${this.generateToken()}`,
            defaultLanguageCode: defaults.languageCode,
            defaultCurrencyCode: defaults.currencyCode,
            pricesIncludeTax: defaults.pricesIncludeTax,
            defaultTaxZoneId: defaultChannel.defaultTaxZone?.id ?? ('1' as any),
            defaultShippingZoneId: defaultChannel.defaultShippingZone?.id ?? ('1' as any),
            sellerId: seller.id as string,
        });

        if (isGraphQlErrorResult(channelResult)) {
            throw new Error(`Failed to create channel: ${'message' in channelResult ? String(channelResult.message) : 'Unknown error'}`);
        }
        const channel = channelResult;

        // 3.5. Assign SuperAdmin role to the new channel so that the current user
        // (SuperAdmin) has permissions to create roles and administrators on it.
        // Without this, RoleService.getPermittedChannels() throws ForbiddenError.
        const superAdminRole = await this.roleService.getSuperAdminRole(ctx);
        await this.roleService.assignRoleToChannel(ctx, superAdminRole.id, channel.id);

        // 4. Create tenant admin Role scoped to the new channel
        const tenantAdminRole = await this.roleService.create(ctx, {
            code: `tenant-admin-${input.slug}`,
            description: `Admin role for tenant ${input.name}`,
            channelIds: [channel.id as string],
            permissions: [
                Permission.ReadCatalog,
                Permission.UpdateCatalog,
                Permission.CreateCatalog,
                Permission.DeleteCatalog,
                Permission.ReadCustomer,
                Permission.UpdateCustomer,
                Permission.CreateCustomer,
                Permission.DeleteCustomer,
                Permission.ReadOrder,
                Permission.UpdateOrder,
                Permission.CreateOrder,
                Permission.DeleteOrder,
                Permission.ReadPromotion,
                Permission.UpdatePromotion,
                Permission.CreatePromotion,
                Permission.DeletePromotion,
                Permission.ReadShippingMethod,
                Permission.UpdateShippingMethod,
                Permission.CreateShippingMethod,
                Permission.DeleteShippingMethod,
                Permission.ReadPaymentMethod,
                Permission.UpdatePaymentMethod,
                Permission.CreatePaymentMethod,
                Permission.DeletePaymentMethod,
                Permission.ReadAsset,
                Permission.UpdateAsset,
                Permission.CreateAsset,
                Permission.DeleteAsset,
                Permission.ReadSettings,
                Permission.UpdateSettings,
                Permission.ReadStockLocation,
                Permission.UpdateStockLocation,
                Permission.CreateStockLocation,
                Permission.DeleteStockLocation,
            ],
        });

        // 5. Create Administrator
        const admin = await this.administratorService.create(ctx, {
            firstName: input.admin.firstName,
            lastName: input.admin.lastName,
            emailAddress: input.admin.emailAddress,
            password: input.admin.password,
            roleIds: [tenantAdminRole.id as string],
        });

        // 6. Create Tenant entity
        const tenant = await this.tenantService.create(ctx, {
            name: input.name,
            slug: input.slug,
            channelId: channel.id,
            plan: input.plan || 'trial',
            config: {},
        });

        // 7. Create primary domain
        await this.tenantService.addDomain(ctx, tenant.id, input.primaryDomain, true);

        // 8. Transition to PROVISIONING → TRIAL
        await this.tenantService.changeStatus(ctx, tenant.id, TenantStatus.PROVISIONING);
        await this.tenantService.changeStatus(ctx, tenant.id, TenantStatus.TRIAL);

        // Reload with relations
        const provisionedTenant = await this.tenantService.findById(ctx, tenant.id);
        if (!provisionedTenant) {
            throw new Error('Failed to load provisioned tenant');
        }

        // 9. Emit TenantCreatedEvent
        await this.eventBus.publish(new TenantCreatedEvent(ctx, provisionedTenant));

        return {
            tenant: provisionedTenant,
            channelToken: channel.token,
            adminId: admin.id,
        };
    }

    /**
     * Generate a random token string for channel identification.
     */
    private generateToken(): string {
        return Math.random().toString(36).substring(2, 10) +
            Math.random().toString(36).substring(2, 10);
    }
}
