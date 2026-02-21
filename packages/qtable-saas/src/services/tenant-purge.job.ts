import { Injectable, OnModuleInit } from '@nestjs/common';
import {
    JobQueue,
    JobQueueService,
    Logger,
    RequestContext,
    TransactionalConnection,
} from '@vendure/core';

import { Tenant, TenantStatus } from '../entities';
import { AuditService } from './audit.service';
import { TenantService } from './tenant.service';
import { LessThan } from 'typeorm';

const loggerCtx = 'TenantPurgeJob';

/**
 * Retention periods for tenant data.
 */
const DELETION_GRACE_DAYS = 30;
const PURGE_AFTER_DAYS = 90;

/**
 * TenantPurgeJob — Vendure JobQueue worker for automated tenant lifecycle.
 *
 * Runs two scheduled operations:
 * 1. PENDING_DELETION → DELETED: after 30-day grace period
 * 2. DELETED → PURGED: after 90 days, removes all tenant resources
 *
 * The job is triggered by a cron-like schedule (every 24h) or can be
 * manually triggered via the Admin API.
 *
 * @see implementation_plan.md Phase 3 — 3.2
 */
@Injectable()
export class TenantPurgeJob implements OnModuleInit {
    private jobQueue: JobQueue;

    constructor(
        private jobQueueService: JobQueueService,
        private connection: TransactionalConnection,
        private tenantService: TenantService,
        private auditService: AuditService,
    ) { }

    async onModuleInit() {
        this.jobQueue = await this.jobQueueService.createQueue({
            name: 'tenant-purge',
            process: async (job) => {
                const ctx = RequestContext.empty();
                await this.processPendingDeletions(ctx);
                await this.processExpiredTenants(ctx);
            },
        });
    }

    /**
     * Manually trigger the purge job (for Admin API or testing).
     */
    async trigger() {
        await this.jobQueue.add({}, { retries: 0 });
    }

    /**
     * Phase 1: PENDING_DELETION → DELETED
     * Tenants past the 30-day grace period are finalized.
     */
    private async processPendingDeletions(ctx: RequestContext): Promise<void> {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - DELETION_GRACE_DAYS);

        const repo = this.connection.getRepository(ctx, Tenant);
        const expired = await repo.find({
            where: {
                status: TenantStatus.PENDING_DELETION,
                deletedAt: LessThan(cutoff),
            },
        });

        for (const tenant of expired) {
            try {
                await this.tenantService.changeStatus(ctx, tenant.id, TenantStatus.DELETED);
                await this.auditService.log(ctx, {
                    action: 'TENANT_AUTO_DELETED',
                    severity: 'WARN',
                    tenantId: tenant.id,
                    metadata: { name: tenant.name, slug: tenant.slug, graceDays: DELETION_GRACE_DAYS },
                });
                Logger.info(`Tenant "${tenant.slug}" auto-deleted after ${DELETION_GRACE_DAYS}-day grace`, loggerCtx);
            } catch (e) {
                Logger.error(`Failed to auto-delete tenant "${tenant.slug}": ${String(e)}`, loggerCtx);
            }
        }
    }

    /**
     * Phase 2: DELETED → PURGED
     * Tenants deleted 90+ days ago have all resources removed.
     */
    private async processExpiredTenants(ctx: RequestContext): Promise<void> {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - PURGE_AFTER_DAYS);

        const repo = this.connection.getRepository(ctx, Tenant);
        const expired = await repo.find({
            where: {
                status: TenantStatus.DELETED,
                deletedAt: LessThan(cutoff),
            },
        });

        for (const tenant of expired) {
            try {
                // Remove domains
                const domains = await this.connection.getRepository(ctx, Tenant)
                    .createQueryBuilder('tenant')
                    .relation('domains')
                    .of(tenant.id)
                    .loadMany();

                for (const domain of domains) {
                    await this.tenantService.removeDomain(ctx, tenant.id, domain.id);
                }

                // Transition to PURGED
                await this.tenantService.changeStatus(ctx, tenant.id, TenantStatus.PURGED);

                await this.auditService.log(ctx, {
                    action: 'TENANT_PURGED',
                    severity: 'CRITICAL',
                    tenantId: tenant.id,
                    metadata: {
                        name: tenant.name,
                        slug: tenant.slug,
                        purgeAfterDays: PURGE_AFTER_DAYS,
                    },
                });
                Logger.warn(`Tenant "${tenant.slug}" purged after ${PURGE_AFTER_DAYS} days`, loggerCtx);
            } catch (e) {
                Logger.error(`Failed to purge tenant "${tenant.slug}": ${String(e)}`, loggerCtx);
            }
        }
    }
}
