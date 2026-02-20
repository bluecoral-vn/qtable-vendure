import { PluginCommonModule, VendurePlugin } from '@vendure/core';

/**
 * QTablePlugin — Entry point for all custom QTable business logic.
 *
 * All custom entities, resolvers, services, and event handlers
 * should be registered through this plugin.
 *
 * @see ARCHITECTURE.md for development guidelines
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    entities: [],
    adminApiExtensions: {},
    shopApiExtensions: {},
    providers: [],
})
export class QTablePlugin { }
