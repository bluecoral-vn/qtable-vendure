import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/typeorm';
import { Connection } from 'typeorm';

import { TenantDomain } from '../entities/tenant-domain.entity';
import { TenantStatus } from '../entities/tenant-status.enum';

/**
 * Cached tenant resolution result.
 */
interface TenantResolutionResult {
    channelToken: string;
    tenantId: string | number;
    tenantSlug: string;
    tenantStatus: TenantStatus;
}

/**
 * TenantResolutionService — resolves domains to tenant channel tokens.
 *
 * Uses an in-memory cache with TTL to avoid hitting the database
 * on every request. Cache invalidation happens on TTL expiry.
 *
 * @see security-and-isolation.md §2 "Tenant Detection"
 */
@Injectable()
export class TenantResolutionService {
    /**
     * In-memory cache: domain → resolution result.
     * Each entry has a TTL after which it's refreshed from the DB.
     */
    private cache = new Map<string, { result: TenantResolutionResult; expiresAt: number }>();
    private readonly cacheTtlMs = 60_000; // 1 minute

    constructor(@InjectConnection() private connection: Connection) { }

    /**
     * Resolve a domain (from Host header) to a channel token.
     *
     * Returns undefined if:
     * - Domain is not found
     * - Tenant is not in an active state (TRIAL, ACTIVE)
     */
    async resolve(domain: string): Promise<TenantResolutionResult | undefined> {
        // Normalize: strip port, lowercase
        const normalizedDomain = domain.split(':')[0].toLowerCase();

        // Check cache
        const cached = this.cache.get(normalizedDomain);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.result;
        }

        // Query database
        const tenantDomain = await this.connection
            .getRepository(TenantDomain)
            .findOne({
                where: { domain: normalizedDomain },
                relations: ['tenant', 'tenant.channel'],
            });

        if (!tenantDomain?.tenant?.channel) {
            // Cache negative result briefly (10s) to prevent DB hammering
            this.cache.delete(normalizedDomain);
            return undefined;
        }

        const { tenant } = tenantDomain;

        // Only allow active tenants
        if (tenant.status !== TenantStatus.TRIAL && tenant.status !== TenantStatus.ACTIVE) {
            return undefined;
        }

        const result: TenantResolutionResult = {
            channelToken: tenant.channel.token,
            tenantId: tenant.id,
            tenantSlug: tenant.slug,
            tenantStatus: tenant.status,
        };

        // Cache result
        this.cache.set(normalizedDomain, {
            result,
            expiresAt: Date.now() + this.cacheTtlMs,
        });

        return result;
    }

    /**
     * Invalidate cache for a specific domain.
     * Call this when a tenant domain mapping changes.
     */
    invalidate(domain: string): void {
        this.cache.delete(domain.toLowerCase());
    }

    /**
     * Invalidate all cached entries.
     */
    invalidateAll(): void {
        this.cache.clear();
    }
}
