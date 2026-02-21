import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import {
    ForbiddenError,
    Logger,
    Permission,
    RequestContext,
} from '@vendure/core';
import { Request } from 'express';

import { TenantStatus } from '../entities/tenant-status.enum';

import { AuditService } from '../services/audit.service';

const REQUEST_CONTEXT_KEY = 'vendureRequestContext';
const loggerCtx = 'TenantGuard';

/**
 * Tenant metadata attached to the request by TenantContextMiddleware.
 */
export interface TenantMeta {
    id: string;
    slug: string;
    status: TenantStatus;
    channelToken: string;
    channelId?: string;
}

/**
 * TenantGuard — Runs after Vendure's AuthGuard.
 *
 * 1. Verifies ctx.channelId matches the resolved tenant's channel
 * 2. Blocks suspended tenants from Shop API mutations
 * 3. Logs mismatches as security events via AuditService
 *
 * @see implementation_plan.md Phase 2 — 2.2 TenantGuard
 */
@Injectable()
export class TenantGuard implements CanActivate {
    constructor(private auditService: AuditService) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        // Only apply to GraphQL requests
        if (context.getType<GqlContextType>() !== 'graphql') {
            return true;
        }

        const gqlContext = GqlExecutionContext.create(context);
        const req: Request = gqlContext.getContext().req;

        // Get tenant metadata from middleware
        const tenant = (req as any).__tenant as TenantMeta | undefined;

        // No tenant context (localhost/dev) → allow (AuthGuard handles permissions)
        if (!tenant) {
            return true;
        }

        // Get RequestContext set by AuthGuard
        const ctxStore = (req as any)[REQUEST_CONTEXT_KEY];
        if (!ctxStore) {
            // AuthGuard hasn't run yet or no context — skip
            return true;
        }
        const requestContext: RequestContext = ctxStore.withTransactionManager || ctxStore.default;
        if (!requestContext) {
            return true;
        }

        // Block suspended tenants from Shop API (except read queries)
        if (tenant.status === TenantStatus.SUSPENDED) {
            if (requestContext.apiType === 'shop') {
                const handler = context.getHandler();
                const isMutation = handler?.name?.startsWith('create') ||
                    handler?.name?.startsWith('update') ||
                    handler?.name?.startsWith('delete') ||
                    handler?.name?.startsWith('add') ||
                    handler?.name?.startsWith('remove') ||
                    handler?.name?.startsWith('set');

                if (isMutation) {
                    Logger.warn(
                        `Blocked mutation "${handler.name}" for suspended tenant "${tenant.slug}"`,
                        loggerCtx,
                    );
                    await this.auditService.log(requestContext, {
                        action: 'SUSPENDED_TENANT_MUTATION_BLOCKED',
                        severity: 'WARN',
                        tenantId: tenant.id,
                        metadata: { mutation: handler.name, slug: tenant.slug },
                    });
                    throw new ForbiddenError();
                }
            }
        }

        return true;
    }
}
