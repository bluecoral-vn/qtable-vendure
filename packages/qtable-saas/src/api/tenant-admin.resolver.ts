import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
    Allow,
    Ctx,
    Permission,
    RequestContext,
    Transaction,
} from '@vendure/core';
import { CurrencyCode, LanguageCode } from '@vendure/common/lib/generated-types';

import { TenantService } from '../services/tenant.service';
import { TenantProvisioningService } from '../services/tenant-provisioning.service';
import { AuditService } from '../services/audit.service';
import { TenantStatus } from '../entities/tenant-status.enum';

/**
 * Admin API resolver for tenant management.
 *
 * All mutations require SuperAdmin permission since
 * tenant lifecycle management is a platform-level operation.
 */
@Resolver()
export class TenantAdminResolver {
    constructor(
        private tenantService: TenantService,
        private tenantProvisioningService: TenantProvisioningService,
        private auditService: AuditService,
    ) { }

    @Query()
    @Allow(Permission.SuperAdmin)
    async tenants(
        @Ctx() ctx: RequestContext,
        @Args() args: { options?: any },
    ) {
        return this.tenantService.findAll(ctx, args.options);
    }

    @Query()
    @Allow(Permission.SuperAdmin)
    async tenant(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: string },
    ) {
        return this.tenantService.findById(ctx, args.id);
    }

    @Query()
    @Allow(Permission.SuperAdmin)
    async tenantBySlug(
        @Ctx() ctx: RequestContext,
        @Args() args: { slug: string },
    ) {
        return this.tenantService.findBySlug(ctx, args.slug);
    }

    @Query()
    @Allow(Permission.SuperAdmin)
    async auditLogs(
        @Ctx() ctx: RequestContext,
        @Args() args: { options?: { take?: number; skip?: number; action?: string; severity?: string; tenantId?: string } },
    ) {
        return this.auditService.findAll(ctx, args.options);
    }

    @Transaction()
    @Mutation()
    @Allow(Permission.SuperAdmin)
    async provisionTenant(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: ProvisionTenantGqlInput },
    ) {
        return this.tenantProvisioningService.provision(ctx, {
            name: args.input.name,
            slug: args.input.slug,
            primaryDomain: args.input.primaryDomain,
            plan: args.input.plan ?? undefined,
            admin: {
                firstName: args.input.adminFirstName,
                lastName: args.input.adminLastName,
                emailAddress: args.input.adminEmailAddress,
                password: args.input.adminPassword,
            },
            defaults: {
                languageCode: args.input.defaultLanguageCode as LanguageCode ?? undefined,
                currencyCode: args.input.defaultCurrencyCode as CurrencyCode ?? undefined,
                pricesIncludeTax: args.input.pricesIncludeTax ?? undefined,
            },
        });
    }

    @Transaction()
    @Mutation()
    @Allow(Permission.SuperAdmin)
    async updateTenant(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: { id: string; name?: string; plan?: string; config?: any } },
    ) {
        return this.tenantService.update(ctx, args.input);
    }

    @Transaction()
    @Mutation()
    @Allow(Permission.SuperAdmin)
    async changeTenantStatus(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: string; status: TenantStatus },
    ) {
        return this.tenantService.changeStatus(ctx, args.id, args.status);
    }

    @Transaction()
    @Mutation()
    @Allow(Permission.SuperAdmin)
    async addTenantDomain(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: { tenantId: string; domain: string; isPrimary?: boolean } },
    ) {
        return this.tenantService.addDomain(
            ctx,
            args.input.tenantId,
            args.input.domain,
            args.input.isPrimary ?? false,
        );
    }

    @Transaction()
    @Mutation()
    @Allow(Permission.SuperAdmin)
    async removeTenantDomain(
        @Ctx() ctx: RequestContext,
        @Args() args: { tenantId: string; domainId: string },
    ) {
        return this.tenantService.removeDomain(ctx, args.tenantId, args.domainId);
    }

    @Transaction()
    @Mutation()
    @Allow(Permission.SuperAdmin)
    async deleteTenant(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: string },
    ) {
        return this.tenantService.changeStatus(ctx, args.id, TenantStatus.PENDING_DELETION);
    }
}

/**
 * GraphQL input type for provisioning.
 */
interface ProvisionTenantGqlInput {
    name: string;
    slug: string;
    primaryDomain: string;
    plan?: string | null;
    adminFirstName: string;
    adminLastName: string;
    adminEmailAddress: string;
    adminPassword: string;
    defaultLanguageCode?: LanguageCode | null;
    defaultCurrencyCode?: CurrencyCode | null;
    pricesIncludeTax?: boolean | null;
}
