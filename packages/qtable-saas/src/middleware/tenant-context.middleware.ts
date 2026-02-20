import { Injectable, NestMiddleware } from '@nestjs/common';
import { Logger } from '@vendure/core';
import { Request, Response, NextFunction } from 'express';

import { TenantResolutionService } from '../services/tenant-resolution.service';

/**
 * Default channel token key used by Vendure.
 * This is the header/query param that Vendure reads to determine
 * which Channel to use for the current request.
 */
const CHANNEL_TOKEN_KEY = 'vendure-token';

/**
 * TenantContextMiddleware — resolves the tenant from the incoming
 * request's Host header and injects the corresponding channel token.
 *
 * Flow:
 * 1. Extract domain from Host header
 * 2. Skip if domain is localhost/dev (no tenant resolution needed)
 * 3. Resolve domain → TenantDomain → Tenant → Channel.token
 * 4. Override the `vendure-token` header with the resolved channel token
 * 5. Attach tenant metadata to the request for downstream use
 *
 * This middleware MUST run before Vendure's RequestContextService
 * processes the request (which reads the vendure-token header).
 *
 * @see security-and-isolation.md §2 "Tenant Detection"
 * @see plugin-architecture.md §3 "TenantContextMiddleware"
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
    /**
     * Domains that skip tenant resolution (dev/localhost).
     */
    private readonly skipDomains = new Set([
        'localhost',
        '127.0.0.1',
        '0.0.0.0',
    ]);

    constructor(private tenantResolutionService: TenantResolutionService) { }

    async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
        const host = req.get('host') || req.get('x-forwarded-host') || '';
        const domain = host.split(':')[0].toLowerCase();

        // Skip tenant resolution for dev/localhost or if vendure-token
        // is already explicitly set (allowing manual override for admin API)
        if (this.skipDomains.has(domain) || req.headers[CHANNEL_TOKEN_KEY]) {
            return next();
        }

        try {
            const resolution = await this.tenantResolutionService.resolve(domain);

            if (resolution) {
                // Override vendure-token header so Vendure resolves to the tenant's channel
                req.headers[CHANNEL_TOKEN_KEY] = resolution.channelToken;

                // Attach tenant metadata to request for downstream use
                (req as any).__tenant = {
                    id: resolution.tenantId,
                    slug: resolution.tenantSlug,
                    status: resolution.tenantStatus,
                    channelToken: resolution.channelToken,
                };
            }
            // If no resolution found, request proceeds without a channel token
            // (Vendure will use the default channel)
        } catch (error) {
            // Log but don't block — fail open to default channel
            Logger.error('[TenantContextMiddleware] Error resolving tenant: ' + String(error), 'TenantContextMiddleware');
        }

        next();
    }
}
