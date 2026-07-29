/** Version of the wire protocol between runtime SDK and the daemon. */
export const PROTOCOL_VERSION = 1;

/** Default port the AgentLens daemon listens on for runtime connections. */
export const DEFAULT_WS_PORT = 8631;

/** WebSocket path runtime clients connect to. */
export const WS_PATH = '/agentlens';

/**
 * DOM attribute carrying the original source location (`file:line`) of an
 * element. Written by the Vite plugin, read back by the runtime's snapshot
 * and interaction collectors.
 */
export const SOURCE_ATTRIBUTE = 'data-agentlens-source';
