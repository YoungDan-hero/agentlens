/**
 * Browser-facing re-export of the AgentLens runtime.
 *
 * The virtual module imports this real on-disk file instead of a bare
 * `@agentlensjs/runtime` specifier: a virtual module has no filesystem
 * location, so Vite would resolve the bare import from the project root —
 * where the runtime is not installed. From this file, resolution walks
 * this package's own dependencies, which works under npm, pnpm and yarn
 * without requiring users to install anything beyond the plugin.
 */
export { init } from '@agentlensjs/runtime';
export type { AgentLensClient, InitOptions } from '@agentlensjs/runtime';
