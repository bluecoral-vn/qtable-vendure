import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
    Allow,
    Ctx,
    ForbiddenError,
    Permission,
    RequestContext,
    Transaction,
} from '@vendure/core';

import { TenantService } from '../services/tenant.service';

/**
 * Shop API resolver — tenant self-service for authenticated admins.
 *
 * Provides:
 * - `currentTenant` query (public)
 * - `updateMyTenant` mutation (authenticated, name/config updates)
 * - `addMyDomain` / `removeMyDomain` mutations (authenticated)
 *
 * All mutations operate on the current channel's tenant only.
 */
@Resolver()
export class TenantShopResolver {
    constructor(
        private tenantService: TenantService,
    ) { }

    @Query()
    @Allow(Permission.Public)
    async currentTenant(@Ctx() ctx: RequestContext) {
        return this.tenantService.findByChannelId(ctx, ctx.channelId);
    }

    @Transaction()
    @Mutation()
    @Allow(Permission.Authenticated)
    async updateMyTenant(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: { name?: string; config?: any } },
    ) {
        const tenant = await this.tenantService.findByChannelId(ctx, ctx.channelId);
        if (!tenant) {
            throw new ForbiddenError();
        }
        return this.tenantService.update(ctx, {
            id: tenant.id,
            name: args.input.name,
            config: args.input.config,
        });
    }

    @Transaction()
    @Mutation()
    @Allow(Permission.Authenticated)
    async addMyDomain(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: { domain: string; isPrimary?: boolean } },
    ) {
        const tenant = await this.tenantService.findByChannelId(ctx, ctx.channelId);
        if (!tenant) {
            throw new ForbiddenError();
        }
        return this.tenantService.addDomain(
            ctx,
            tenant.id,
            args.input.domain,
            args.input.isPrimary ?? false,
        );
    }

    @Transaction()
    @Mutation()
    @Allow(Permission.Authenticated)
    async removeMyDomain(
        @Ctx() ctx: RequestContext,
        @Args() args: { domainId: string },
    ) {
        const tenant = await this.tenantService.findByChannelId(ctx, ctx.channelId);
        if (!tenant) {
            throw new ForbiddenError();
        }
        return this.tenantService.removeDomain(ctx, tenant.id, args.domainId);
    }
}
