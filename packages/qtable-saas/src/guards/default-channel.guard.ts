import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import {
    ChannelService,
    ForbiddenError,
    Logger,
    Permission,
    RequestContext,
} from '@vendure/core';
import { Request } from 'express';

import { AuditService } from '../services/audit.service';

const REQUEST_CONTEXT_KEY = 'vendureRequestContext';
const PERMISSIONS_METADATA_KEY = 'permissions';
const loggerCtx = 'DefaultChannelGuard';

/**
 * DefaultChannelGuard — Prevents non-SuperAdmin users from
 * accessing the Default Channel.
 *
 * In a multi-tenant system, the Default Channel acts as "god mode"
 * with visibility into all tenants' data. Only SuperAdmin should
 * be able to access it.
 *
 * Exceptions:
 * - Public endpoints (login, health checks) are always allowed
 * - Requests without a session (pre-auth) are allowed
 *
 * @see implementation_plan.md Phase 2 — 2.3 Default Channel Restriction
 */
@Injectable()
export class DefaultChannelGuard implements CanActivate {
    private defaultChannelId: string | undefined;

    constructor(
        private reflector: Reflector,
        private channelService: ChannelService,
        private auditService: AuditService,
    ) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        // Only apply to GraphQL requests
        if (context.getType<GqlContextType>() !== 'graphql') {
            return true;
        }

        // Allow public endpoints (login, register, etc.)
        const permissions = this.reflector.get<Permission[]>(PERMISSIONS_METADATA_KEY, context.getHandler());
        if (!permissions || permissions.includes(Permission.Public)) {
            return true;
        }

        const gqlContext = GqlExecutionContext.create(context);
        const req: Request = gqlContext.getContext().req;

        // Get RequestContext set by AuthGuard
        const ctxStore = (req as any)[REQUEST_CONTEXT_KEY];
        if (!ctxStore) {
            return true;
        }
        const requestContext: RequestContext = ctxStore.withTransactionManager || ctxStore.default;
        if (!requestContext) {
            return true;
        }

        // No authenticated user → allow (AuthGuard already handles auth checks)
        if (!requestContext.activeUserId) {
            return true;
        }

        // Cache the default channel ID
        if (!this.defaultChannelId) {
            const defaultChannel = await this.channelService.getDefaultChannel(requestContext);
            this.defaultChannelId = String(defaultChannel.id);
        }

        // Check if current channel is default channel
        if (String(requestContext.channelId) === this.defaultChannelId) {
            // Only SuperAdmin can access default channel
            if (!requestContext.userHasPermissions([Permission.SuperAdmin])) {
                const userId = requestContext.activeUserId;
                Logger.warn(
                    `Non-SuperAdmin user ${String(userId)} attempted to access Default Channel`,
                    loggerCtx,
                );
                await this.auditService.log(requestContext, {
                    action: 'DEFAULT_CHANNEL_ACCESS_BLOCKED',
                    severity: 'CRITICAL',
                    metadata: { userId: String(userId) },
                });
                throw new ForbiddenError();
            }
        }

        return true;
    }
}
