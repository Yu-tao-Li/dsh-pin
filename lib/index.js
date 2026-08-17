/**
 * dsh-pin host entry: the plugin is browser-side only. Nothing is mounted on
 * the host; the entry exists so the package is a loader entry the
 * client-module scanner can discover and serve under /plugins.
 *
 * @module dsh-pin
 */
export const name = "dsh-pin";

/** No-op host half. @param _ctx - host context. @param _config - entry config. */
export function apply(_ctx, _config) {}
