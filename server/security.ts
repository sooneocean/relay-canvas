import { lookup as dnsLookup } from 'node:dns/promises';
import { timingSafeEqual } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import type { ClientRequest } from 'node:http';
import type { LookupFunction } from 'node:net';
import type { RequestHandler } from 'express';
import ipaddr from 'ipaddr.js';

export interface SecurityPolicy {
  remoteEnabled: boolean;
  providerOrigins: string[];
  mediaOrigins: string[];
}

export interface SafeRequestOptions {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: unknown;
  signal: AbortSignal;
  resolve?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

const DEFAULT_PROVIDER_ORIGINS = [
  'https://api.openai.com',
  'https://queue.fal.run',
  'https://api.replicate.com',
];
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

function safeError(message: string): Error {
  return new Error(message);
}

function parseExactOrigins(value: string | undefined, defaults: string[]): string[] {
  const entries = value === undefined ? defaults : value.split(',').map((entry) => entry.trim()).filter(Boolean);
  const unique = new Set<string>();
  for (const entry of entries) {
    try {
      const url = new URL(entry);
      if (
        url.protocol !== 'https:' || url.username || url.password || url.port ||
        url.pathname !== '/' || url.search || url.hash || url.origin !== entry ||
        url.hostname.endsWith('.') || isIpHostname(url.hostname)
      ) throw new Error();
      unique.add(entry);
    } catch {
      throw safeError('Invalid security policy');
    }
  }
  return [...unique];
}

export function readPolicy(env: NodeJS.ProcessEnv = process.env): SecurityPolicy {
  const remoteFlag = env.RELAY_ENABLE_REMOTE ?? 'false';
  if (remoteFlag !== 'true' && remoteFlag !== 'false') throw safeError('Invalid security policy');
  return {
    remoteEnabled: remoteFlag === 'true',
    providerOrigins: parseExactOrigins(env.RELAY_PROVIDER_ORIGINS, DEFAULT_PROVIDER_ORIGINS),
    mediaOrigins: parseExactOrigins(env.RELAY_MEDIA_ORIGINS, []),
  };
}

function isIpHostname(hostname: string): boolean {
  const candidate = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return ipaddr.isValid(candidate);
}

function parseHttpsUrl(value: string): URL {
  if (value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) throw safeError('Invalid URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw safeError('Invalid URL');
  }
  if (
    url.protocol !== 'https:' || url.username || url.password ||
    (url.port && url.port !== '443') || url.hostname.endsWith('.') || isIpHostname(url.hostname)
  ) throw safeError('Invalid URL');
  return url;
}

function parseSecureBaseUrl(value: string): URL {
  if (
    value.length > 4096 || /[\\\u0000-\u001f\u007f]/.test(value) || /%[0-9a-f]{2}/i.test(value) ||
    /(?:^|\/)\.{1,2}(?:\/|$)/.test(value)
  ) {
    throw safeError('Invalid URL');
  }
  const url = parseHttpsUrl(value);
  if (url.search || url.hash) throw safeError('Invalid URL');
  return url;
}

export function validateBaseUrl(value: string, policy: SecurityPolicy): URL {
  const url = parseSecureBaseUrl(value);
  if (!policy.providerOrigins.includes(url.origin)) throw safeError('Provider origin is not allowed');
  return url;
}

export function validateProviderRequestUrl(value: string, policy: SecurityPolicy): URL {
  const url = parseHttpsUrl(value);
  if (url.hash || !policy.providerOrigins.includes(url.origin)) throw safeError('Provider origin is not allowed');
  return url;
}

function validBase64DataUrl(value: string): boolean {
  if (value.length > 6 * 1024 * 1024) return false;
  return /^data:(image\/(?:png|jpeg|webp)|video\/(?:mp4|webm));base64,[A-Za-z0-9+/]*={0,2}$/i.test(value);
}

export function validateMediaUrl(value: string, policy: SecurityPolicy, options: { allowDemo?: boolean } = {}): string {
  if (options.allowDemo && value === '/demo-motion.mp4') return value;
  if (options.allowDemo && /^data:image\/svg\+xml;charset=utf-8,/.test(value)) return value;
  if (validBase64DataUrl(value)) return value;
  const url = parseHttpsUrl(value);
  if (url.hash) throw safeError('Invalid URL');
  if (!policy.mediaOrigins.includes(url.origin)) throw safeError('Media origin is not allowed');
  return url.href;
}

export function isPublicAddress(address: string): boolean {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
      parsed = (parsed as ipaddr.IPv6).toIPv4Address();
    }
    return parsed.range() === 'unicast';
  } catch {
    return false;
  }
}

function tokenMatches(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function mediaCookie(cookie: string | undefined): string | undefined {
  if (cookie === undefined || cookie.length > 4096 || /[\u0000-\u001f\u007f]/.test(cookie)) return undefined;
  let found: string | undefined;
  for (const part of cookie.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) return undefined;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || !/^[\x21-\x3A\x3C-\x7E]*$/.test(value)) return undefined;
    if (name === 'relay_canvas_media') {
      if (found !== undefined) return undefined;
      if (!/^[A-Za-z0-9]+$/.test(value)) return undefined;
      found = value;
    }
  }
  return found;
}

function deny(res: Parameters<RequestHandler>[1], status: number, code: string): void {
  res.status(status).json({ error: 'Request rejected', code });
}

export function createBoundary(options: {
  origin: string;
  token: string;
  dev: boolean;
  policy: SecurityPolicy;
}): RequestHandler {
  const serverOrigin = new URL(options.origin);
  if (
    serverOrigin.protocol !== 'http:' || serverOrigin.hostname !== '127.0.0.1' ||
    serverOrigin.pathname !== '/' || options.origin !== serverOrigin.origin
  ) {
    throw safeError('Invalid server origin');
  }
  const mediaSources = options.policy.mediaOrigins.map((origin) => origin.replace(/'/g, ''));
  const connectSources = options.dev
    ? ["'self'", 'ws://127.0.0.1:*', 'http://127.0.0.1:*', 'ws://localhost:*', 'http://localhost:*']
    : ["'self'"];
  const csp = [
    "default-src 'self'",
    `connect-src ${connectSources.join(' ')}`,
    `img-src 'self' data: ${mediaSources.join(' ')}`.trim(),
    `media-src 'self' data: ${mediaSources.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    options.dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

    if (req.headers.host !== serverOrigin.host) return deny(res, 403, 'invalid_host');
    const requestOrigin = req.get('origin');
    if (requestOrigin !== undefined && requestOrigin !== options.origin) return deny(res, 403, 'invalid_origin');

    const path = req.path;
    if (path === '/healthz') {
      if (req.method !== 'GET') return deny(res, 405, 'method_not_allowed');
      return next();
    }
    if (path !== '/api' && !path.startsWith('/api/')) return next();
    res.setHeader('Cache-Control', 'no-store');

    const mediaRoute = path.startsWith('/api/media/');
    if (!['GET', 'POST', 'PUT'].includes(req.method) && !(mediaRoute && req.method === 'HEAD')) return deny(res, 405, 'method_not_allowed');
    const sameOriginMetadata = req.get('sec-fetch-site') === 'same-origin';
    if (path === '/api/session') {
      if (req.method !== 'GET') return deny(res, 405, 'method_not_allowed');
      if (req.get('x-canvas-client') !== 'ui' || (requestOrigin !== options.origin && !sameOriginMetadata)) {
        return deny(res, 403, 'invalid_session_request');
      }
      return next();
    }

    if (mediaRoute) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return deny(res, 405, 'method_not_allowed');
      const headerAuthorized = tokenMatches(req.get('x-canvas-token'), options.token) &&
        (requestOrigin === options.origin || (requestOrigin === undefined && sameOriginMetadata));
      const cookieAuthorized = sameOriginMetadata &&
        (requestOrigin === undefined || requestOrigin === options.origin) &&
        tokenMatches(mediaCookie(req.get('cookie')), options.token);
      if (!headerAuthorized && !cookieAuthorized) return deny(res, 403, 'invalid_token');
      return next();
    }

    if (requestOrigin === undefined && !(req.method === 'GET' && sameOriginMetadata)) {
      return deny(res, 403, 'invalid_origin');
    }
    if (!tokenMatches(req.get('x-canvas-token'), options.token)) return deny(res, 403, 'invalid_token');
    return next();
  };
}

export async function safeJsonRequest(
  value: string,
  options: SafeRequestOptions,
  policy: SecurityPolicy,
): Promise<unknown> {
  const url = validateProviderRequestUrl(value, policy);
  if (options.signal.aborted) throw safeError('Request aborted');

  let addresses: Array<{ address: string; family: number }>;
  const startedAt = Date.now();
  let lookupTimer: ReturnType<typeof setTimeout> | undefined;
  let abortLookup: (() => void) | undefined;
  try {
    addresses = await Promise.race([
      options.resolve
        ? options.resolve(url.hostname)
        : dnsLookup(url.hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        lookupTimer = setTimeout(() => reject(safeError('Provider request timed out')), REQUEST_TIMEOUT_MS);
      }),
      new Promise<never>((_resolve, reject) => {
        abortLookup = () => reject(safeError('Request aborted'));
        options.signal.addEventListener('abort', abortLookup, { once: true });
      }),
    ]);
  } catch (error) {
    if (error instanceof Error && (error.message === 'Request aborted' || error.message === 'Provider request timed out')) throw error;
    throw safeError('Provider request failed');
  } finally {
    if (lookupTimer) clearTimeout(lookupTimer);
    if (abortLookup) options.signal.removeEventListener('abort', abortLookup);
  }
  if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw safeError('Provider address is not allowed');
  }
  if (options.signal.aborted) throw safeError('Request aborted');
  const pinned = addresses[0];
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(options.headers)) {
    const normalized = name.toLowerCase();
    if (['host', 'connection', 'transfer-encoding', 'content-length'].includes(normalized) || /[\r\n]/.test(headerValue)) {
      throw safeError('Invalid request headers');
    }
    headers[normalized] = headerValue;
  }
  if (body !== undefined) {
    headers['content-type'] ??= 'application/json';
    headers['content-length'] = String(Buffer.byteLength(body));
  }
  const pinnedLookup: LookupFunction = (_hostname, lookupOptions, callback) => {
    const family = typeof lookupOptions === 'number' ? lookupOptions : lookupOptions.family;
    if (family && family !== 0 && family !== pinned.family) {
      callback(new Error('Address family mismatch'), '', 0);
      return;
    }
    callback(null, pinned.address, pinned.family);
  };

  return await new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let request: ClientRequest;
    let totalTimer: ReturnType<typeof setTimeout>;
    const remainingMs = Math.max(1, REQUEST_TIMEOUT_MS - (Date.now() - startedAt));
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      options.signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(result);
    };
    const onAbort = () => {
      request.destroy();
      finish(safeError('Request aborted'));
    };
    request = httpsRequest(url, {
      method: options.method,
      headers,
      lookup: pinnedLookup,
      agent: false,
      servername: url.hostname,
    }, (response) => {
      const status = response.statusCode ?? 0;
      const declaredLength = Number(response.headers['content-length'] ?? 0);
      if (declaredLength > MAX_RESPONSE_BYTES) {
        response.destroy();
        finish(safeError('Provider response is too large'));
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      response.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_RESPONSE_BYTES) {
          response.destroy();
          finish(safeError('Provider response is too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (status < 200 || status >= 300) {
          finish(safeError(`Provider request failed (HTTP ${status})`));
          return;
        }
        const contentType = String(response.headers['content-type'] ?? '');
        if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(contentType)) {
          finish(safeError('Provider returned an invalid response'));
          return;
        }
        try {
          finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
        } catch {
          finish(safeError('Provider returned an invalid response'));
        }
      });
      response.on('error', () => finish(safeError('Provider request failed')));
    });
    totalTimer = setTimeout(() => {
      request.destroy();
      finish(safeError('Provider request timed out'));
    }, remainingMs);
    options.signal.addEventListener('abort', onAbort, { once: true });
    if (options.signal.aborted) return onAbort();
    request.on('error', () => finish(safeError(options.signal.aborted ? 'Request aborted' : 'Provider request failed')));
    if (body !== undefined) request.write(body);
    request.end();
  });
}
