import { Query, Resolver } from '@nestjs/graphql';
import {
    Ctx,
    RequestContext,
} from '@vendure/core';

import { TenantService } from '../services/tenant.service';

/**
 * Shop API resolver — exposes read-only current tenant info.
 *
 * The currentTenant query returns tenant details based on the
 * channel that was resolved by TenantContextMiddleware.
 * Returns null if the request is on the default channel.
 */
@Resolver()
export class TenantShopResolver {
    constructor(
        private tenantService: TenantService,
    ) { }

    @Query()
    async currentTenant(@Ctx() ctx: RequestContext) {
        // Look up tenant by the current channel
        return this.tenantService.findByChannelId(ctx, ctx.channelId);
    }
}
