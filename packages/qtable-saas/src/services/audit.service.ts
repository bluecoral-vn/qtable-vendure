import { Injectable, OnModuleInit } from '@nestjs/common';
import {
    EventBus,
    Logger,
    PaginatedList,
    RequestContext,
    TransactionalConnection,
} from '@vendure/core';
import { ID } from '@vendure/common/lib/shared-types';

import { AuditLog } from '../entities/audit-log.entity';
import { TenantCreatedEvent, TenantStatusChangedEvent } from '../events/tenant.events';

const loggerCtx = 'AuditService';

/**
 * Input for creating an audit log entry.
 */
export interface AuditLogInput {
    action: string;
    severity: 'INFO' | 'WARN' | 'CRITICAL';
    tenantId?: ID | string;
    metadata?: Record<string, any>;
}

/**
 * AuditService — records security-relevant events and
 * provides query capabilities for platform admins.
 *
 * Auto-subscribes to tenant lifecycle events (TenantCreatedEvent,
 * TenantStatusChangedEvent) and exposes a manual `log()` method
 * for guards and middleware to record security events.
 *
 * @see implementation_plan.md Phase 2 — 2.6 Audit Logging
 */
@Injectable()
export class AuditService implements OnModuleInit {
    constructor(
        private connection: TransactionalConnection,
        private eventBus: EventBus,
    ) { }

    onModuleInit() {
        // Auto-log tenant lifecycle events
        this.eventBus.ofType(TenantCreatedEvent).subscribe(event => {
            this.log(event.ctx, {
                action: 'TENANT_CREATED',
                severity: 'INFO',
                tenantId: event.tenant.id,
                metadata: { tenantName: event.tenant.name, slug: event.tenant.slug },
            }).catch(err => Logger.error(`Failed to log TENANT_CREATED: ${String(err)}`, loggerCtx));
        });

        this.eventBus.ofType(TenantStatusChangedEvent).subscribe(event => {
            this.log(event.ctx, {
                action: 'TENANT_STATUS_CHANGED',
                severity: event.toStatus === 'SUSPENDED' ? 'WARN' : 'INFO',
                tenantId: event.tenant.id,
                metadata: {
                    from: event.fromStatus,
                    to: event.toStatus,
                },
            }).catch(err => Logger.error(`Failed to log TENANT_STATUS_CHANGED: ${String(err)}`, loggerCtx));
        });
    }

    /**
     * Write an audit log entry.
     */
    async log(ctx: RequestContext, input: AuditLogInput): Promise<AuditLog> {
        const repo = this.connection.getRepository(ctx, AuditLog);

        const entry = new AuditLog({
            action: input.action,
            severity: input.severity,
            userId: ctx.activeUserId ? Number(ctx.activeUserId) : null,
            channelId: ctx.channelId ? Number(ctx.channelId) : null,
            tenantId: input.tenantId ? Number(input.tenantId) : null,
            metadata: input.metadata ?? {},
            ipAddress: ctx.req?.ip ?? ctx.req?.connection?.remoteAddress ?? null,
        });

        const saved = await repo.save(entry);

        // Also log to Vendure's logger for observability
        const level = input.severity === 'CRITICAL' ? 'error' : input.severity === 'WARN' ? 'warn' : 'info';
        Logger[level](
            `[AUDIT] ${input.action} | user=${String(ctx.activeUserId || 'anon')} | channel=${String(ctx.channelId)} | ${JSON.stringify(input.metadata || {})}`,
            loggerCtx,
        );

        return saved;
    }

    /**
     * Query audit logs with pagination. SuperAdmin only.
     */
    async findAll(
        ctx: RequestContext,
        options?: { take?: number; skip?: number; action?: string; severity?: string; tenantId?: ID },
    ): Promise<PaginatedList<AuditLog>> {
        const repo = this.connection.getRepository(ctx, AuditLog);
        const qb = repo.createQueryBuilder('audit');

        if (options?.action) {
            qb.andWhere('audit.action = :action', { action: options.action });
        }
        if (options?.severity) {
            qb.andWhere('audit.severity = :severity', { severity: options.severity });
        }
        if (options?.tenantId) {
            qb.andWhere('audit.tenantId = :tenantId', { tenantId: options.tenantId });
        }

        qb.orderBy('audit.createdAt', 'DESC');

        const take = options?.take ?? 25;
        const skip = options?.skip ?? 0;
        qb.take(take).skip(skip);

        const [items, totalItems] = await qb.getManyAndCount();
        return { items, totalItems };
    }
}
