import type { StackFrame } from '@agentlensjs/shared';
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';

/** A frame as it appears in a raw V8 stack string, before source mapping. */
export interface RawFrame {
  functionName: string | null;
  url: string;
  line: number;
  column: number;
}

// Matches `    at fnName (url:line:col)` and `    at url:line:col`.
const STACK_LINE = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;

// The last sourceMappingURL comment wins, mirroring browser behavior.
const SOURCE_MAPPING_URL = /\/\/[#@]\s*sourceMappingURL=(\S+)/g;

const INLINE_MAP_PREFIX = 'data:application/json;base64,';

export function parseStack(stack: string): RawFrame[] {
  const frames: RawFrame[] = [];
  for (const line of stack.split('\n')) {
    const match = STACK_LINE.exec(line);
    if (!match) {
      continue;
    }
    const [, functionName, url, lineText, columnText] = match;
    if (url === undefined || lineText === undefined || columnText === undefined) {
      continue;
    }
    frames.push({
      functionName: functionName ?? null,
      url,
      line: Number(lineText),
      column: Number(columnText),
    });
  }
  return frames;
}

/** Strips cache-busting query strings (`?t=`, `?v=`) and `/@fs` prefixes. */
function cleanFileName(url: string): string {
  const withoutQuery = url.split('?')[0] ?? url;
  return withoutQuery.replace(/^https?:\/\/[^/]+\/@fs/, '').replace(/^https?:\/\/[^/]+/, '');
}

function isLoopbackUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return (
      (protocol === 'http:' || protocol === 'https:') &&
      (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]')
    );
  } catch {
    return false;
  }
}

export interface StackResolverOptions {
  /** Timeout for each module/map download. @default 3000 */
  fetchTimeoutMs?: number;
}

/**
 * Resolves raw browser stack traces back to original source coordinates by
 * downloading the referenced dev-server modules and applying their source
 * maps. Downloads are restricted to loopback hosts: stacks arrive from
 * untrusted pages and must not turn the daemon into an SSRF proxy.
 */
export class StackResolver {
  private readonly cache = new Map<string, Promise<TraceMap | null>>();
  private readonly fetchTimeoutMs: number;

  constructor(options: StackResolverOptions = {}) {
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 3000;
  }

  async resolve(stack: string | null): Promise<StackFrame[]> {
    if (stack === null || stack === '') {
      return [];
    }
    return Promise.all(parseStack(stack).map((frame) => this.resolveFrame(frame)));
  }

  private async resolveFrame(frame: RawFrame): Promise<StackFrame> {
    const fallback: StackFrame = {
      functionName: frame.functionName,
      fileName: cleanFileName(frame.url),
      line: frame.line,
      column: frame.column,
    };

    if (!isLoopbackUrl(frame.url)) {
      return fallback;
    }
    const map = await this.getMap(frame.url);
    if (!map) {
      return fallback;
    }

    // V8 columns are 1-based; trace-mapping expects 0-based columns.
    const position = originalPositionFor(map, { line: frame.line, column: frame.column - 1 });
    if (position.source === null) {
      return fallback;
    }
    return {
      functionName: position.name ?? frame.functionName,
      fileName: cleanFileName(position.source),
      line: position.line,
      column: position.column + 1,
    };
  }

  private getMap(url: string): Promise<TraceMap | null> {
    let cached = this.cache.get(url);
    if (!cached) {
      cached = this.loadMap(url).catch(() => null);
      this.cache.set(url, cached);
    }
    return cached;
  }

  private async loadMap(url: string): Promise<TraceMap | null> {
    const source = await this.download(url);
    let mapUrl: string | null = null;
    for (const match of source.matchAll(SOURCE_MAPPING_URL)) {
      mapUrl = match[1] ?? null;
    }
    if (mapUrl === null) {
      return null;
    }

    let rawMap: string;
    if (mapUrl.startsWith(INLINE_MAP_PREFIX)) {
      rawMap = Buffer.from(mapUrl.slice(INLINE_MAP_PREFIX.length), 'base64').toString('utf8');
    } else {
      const absoluteMapUrl = new URL(mapUrl, url).href;
      if (!isLoopbackUrl(absoluteMapUrl)) {
        return null;
      }
      rawMap = await this.download(absoluteMapUrl);
    }
    return new TraceMap(rawMap);
  }

  private async download(url: string): Promise<string> {
    const response = await fetch(url, { signal: AbortSignal.timeout(this.fetchTimeoutMs) });
    if (!response.ok) {
      throw new Error(`Failed to download ${url}: ${String(response.status)}`);
    }
    return response.text();
  }
}
