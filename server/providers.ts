import type { GenerationOutput, GenerationRequest, MediaKind, Provider } from '../src/shared/types.js';
import { isSafeReferenceField, parseGenerationParams, parseProviders } from '../src/shared/schema.js';
import {
  readPolicy,
  safeJsonRequest,
  validateBaseUrl,
  validateMediaUrl,
  validateProviderRequestUrl,
  type SafeRequestOptions,
  type SecurityPolicy,
} from './security.js';

export type ProviderTransport = (
  url: string,
  options: SafeRequestOptions,
  policy: SecurityPolicy,
) => Promise<unknown>;

export interface GenerateOptions {
  policy?: SecurityPolicy;
  env?: NodeJS.ProcessEnv;
  transport?: ProviderTransport;
  pollIntervalMs?: number;
  maxPolls?: number;
}

export interface GenerationPreflightRequest {
  kind: MediaKind;
  model: string;
  params: Record<string, unknown>;
  referenceField: string;
}

export interface GenerationPreflightOptions {
  policy?: SecurityPolicy;
  env?: NodeJS.ProcessEnv;
}

class AdapterError extends Error {}

function fail(message: string): never {
  throw new AdapterError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ownString(record: Record<string, unknown>, key: string): string | undefined {
  const value = Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
  return typeof value === 'string' ? value : undefined;
}

function readSecret(env: NodeJS.ProcessEnv, key: string): string {
  if (!key || !Object.prototype.hasOwnProperty.call(env, key)) fail('Provider credential is unavailable');
  const value = env[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384) fail('Provider credential is unavailable');
  return value;
}

function joinFixedPath(base: URL, suffix: string): string {
  const prefix = base.pathname.replace(/\/+$/, '');
  const result = new URL(`${prefix}${suffix}`, base.origin);
  if (result.origin !== base.origin || !result.pathname.startsWith(`${prefix}/`)) fail('Invalid provider path');
  return result.href;
}

function validateFalModel(model: string): string[] {
  const segments = model.split('/');
  if (
    segments.length < 2 || segments.length > 8 ||
    segments.some((segment) => !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/.test(segment))
  ) {
    fail('Invalid provider model');
  }
  return segments;
}

function validateReplicateModel(model: string): [string, string] {
  const segments = model.split('/');
  if (segments.length !== 2 || segments.some((segment) => !/^[A-Za-z0-9_-]{1,64}$/.test(segment))) {
    fail('Invalid provider model');
  }
  return [segments[0], segments[1]];
}

function inspectGeneration(
  providerValue: Provider,
  request: GenerationPreflightRequest,
  options: GenerationPreflightOptions,
): { provider: Provider; policy: SecurityPolicy; base?: URL; key?: string } {
  let provider: Provider;
  try {
    provider = parseProviders([providerValue])[0];
    parseGenerationParams(request.params);
  } catch {
    fail('Invalid provider configuration');
  }
  const policy = options.policy ?? readPolicy(options.env);
  if (request.kind !== 'image' && request.kind !== 'video') fail('Provider capability is not supported');
  if (typeof request.model !== 'string' || !request.model || request.model.length > 200) fail('Invalid provider model');
  if (!isSafeReferenceField(request.referenceField)) {
    fail('Invalid reference field');
  }
  if (provider.protocol === 'demo') return { provider, policy };
  if (!policy.remoteEnabled) fail('Remote generation is disabled');
  if (provider.protocol === 'openai' && request.kind !== 'image') fail('Provider capability is not supported');
  if (provider.protocol === 'fal') validateFalModel(request.model);
  if (provider.protocol === 'replicate') validateReplicateModel(request.model);
  const base = validateBaseUrl(provider.baseUrl, policy);
  const key = readSecret(options.env ?? process.env, provider.keyEnv);
  return { provider, policy, base, key };
}

export function preflightGeneration(
  provider: Provider,
  request: GenerationPreflightRequest,
  options: GenerationPreflightOptions = {},
): void {
  inspectGeneration(provider, request, options);
}

function safeInput(request: GenerationRequest): Record<string, unknown> {
  const input: Record<string, unknown> = { ...request.params };
  input.prompt = request.prompt;
  if (request.referenceUrl) input[request.referenceField || 'image_url'] = request.referenceUrl;
  return input;
}

function sameOriginProviderUrl(value: string, origin: string, policy: SecurityPolicy): string {
  const url = validateProviderRequestUrl(value, policy);
  if (url.origin !== origin) fail('Provider returned an invalid URL');
  return url.href;
}

function artifact(kind: MediaKind, value: string, policy: SecurityPolicy): GenerationOutput {
  return { artifacts: [{ kind, url: validateMediaUrl(value, policy) }] };
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[character] ?? character));
}

function demo(request: GenerationRequest, policy: SecurityPolicy): GenerationOutput {
  if (request.kind === 'video') {
    return { artifacts: [{ kind: 'video', url: validateMediaUrl('/demo-motion.mp4', policy, { allowDemo: true }), demo: true }] };
  }
  const caption = escapeXml(request.prompt.slice(0, 500) || 'Relay Canvas Demo');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#141915"/><stop offset="1" stop-color="#9fe870"/></linearGradient></defs><rect width="1280" height="720" fill="url(#g)"/><circle cx="960" cy="170" r="220" fill="#d9ffb8" opacity=".3"/><text x="72" y="610" fill="white" font-family="system-ui,sans-serif" font-size="38">${caption}</text><text x="72" y="665" fill="#d9ffb8" font-family="system-ui,sans-serif" font-size="22">DEMO · no remote generation</text></svg>`;
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return { artifacts: [{ kind: 'image', url: validateMediaUrl(url, policy, { allowDemo: true }), demo: true, mimeType: 'image/svg+xml' }] };
}

function extractFalOutput(value: unknown, kind: MediaKind, policy: SecurityPolicy): GenerationOutput {
  if (!isRecord(value)) fail('Provider returned an invalid response');
  if (kind === 'image') {
    const images = value.images;
    if (!Array.isArray(images) || !isRecord(images[0])) fail('Provider returned an invalid response');
    const url = ownString(images[0], 'url');
    if (!url) fail('Provider returned an invalid response');
    return artifact('image', url, policy);
  }
  const video = value.video;
  if (!isRecord(video)) fail('Provider returned an invalid response');
  const url = ownString(video, 'url');
  if (!url) fail('Provider returned an invalid response');
  return artifact('video', url, policy);
}

function extractReplicateOutput(value: unknown, kind: MediaKind, policy: SecurityPolicy): GenerationOutput {
  const candidate = typeof value === 'string' ? value : Array.isArray(value) ? value.find((entry) => typeof entry === 'string') : undefined;
  if (typeof candidate !== 'string') fail('Provider returned an invalid response');
  return artifact(kind, candidate, policy);
}

async function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) fail('Generation aborted');
  if (milliseconds === 0) return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new AdapterError('Generation aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function openAi(
  provider: Provider,
  request: GenerationRequest,
  base: URL,
  key: string,
  transport: ProviderTransport,
  policy: SecurityPolicy,
): Promise<GenerationOutput> {
  if (request.kind !== 'image' || request.referenceUrl) fail('Provider capability is not supported');
  const body: Record<string, unknown> = { ...request.params, model: request.model, prompt: request.prompt, n: 1 };
  const response = await transport(joinFixedPath(base, '/images/generations'), {
    method: 'POST', headers: { authorization: `Bearer ${key}` }, body, signal: request.signal,
  }, policy);
  if (!isRecord(response) || !Array.isArray(response.data) || !isRecord(response.data[0])) fail('Provider returned an invalid response');
  const first = response.data[0];
  const url = ownString(first, 'url');
  if (url) return artifact('image', url, policy);
  const base64 = ownString(first, 'b64_json');
  if (!base64 || base64.length > 6 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    fail('Provider returned an invalid response');
  }
  return artifact('image', `data:image/png;base64,${base64}`, policy);
}

async function fal(
  provider: Provider,
  request: GenerationRequest,
  base: URL,
  key: string,
  transport: ProviderTransport,
  policy: SecurityPolicy,
  pollIntervalMs: number,
  maxPolls: number,
): Promise<GenerationOutput> {
  const segments = validateFalModel(request.model);
  const createUrl = joinFixedPath(base, `/${segments.map(encodeURIComponent).join('/')}`);
  const created = await transport(createUrl, {
    method: 'POST', headers: { authorization: `Key ${key}` }, body: safeInput(request), signal: request.signal,
  }, policy);
  if (!isRecord(created)) fail('Provider returned an invalid response');
  const remoteId = ownString(created, 'request_id');
  if (!remoteId || !/^[A-Za-z0-9_-]{1,200}$/.test(remoteId)) fail('Provider returned an invalid response');
  await request.onSubmitted(remoteId);
  const statusValue = ownString(created, 'status_url');
  const responseValue = ownString(created, 'response_url');
  if (!statusValue) fail('Provider returned an invalid response');
  const statusUrl = sameOriginProviderUrl(statusValue, base.origin, policy);
  const responseUrl = responseValue ? sameOriginProviderUrl(responseValue, base.origin, policy) : undefined;

  for (let index = 0; index < maxPolls; index += 1) {
    await pause(pollIntervalMs, request.signal);
    const statusResponse = await transport(statusUrl, {
      method: 'GET', headers: { authorization: `Key ${key}` }, signal: request.signal,
    }, policy);
    if (!isRecord(statusResponse)) fail('Provider returned an invalid response');
    const status = ownString(statusResponse, 'status');
    if (status === 'COMPLETED') {
      const finalResponse = responseUrl
        ? await transport(responseUrl, { method: 'GET', headers: { authorization: `Key ${key}` }, signal: request.signal }, policy)
        : statusResponse;
      return { ...extractFalOutput(finalResponse, request.kind, policy), remoteId };
    }
    if (status !== 'IN_QUEUE' && status !== 'IN_PROGRESS') fail('Provider generation failed');
  }
  fail('Provider polling limit reached');
}

async function replicate(
  provider: Provider,
  request: GenerationRequest,
  base: URL,
  key: string,
  transport: ProviderTransport,
  policy: SecurityPolicy,
  pollIntervalMs: number,
  maxPolls: number,
): Promise<GenerationOutput> {
  const [owner, name] = validateReplicateModel(request.model);
  const createUrl = joinFixedPath(base, `/models/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/predictions`);
  const created = await transport(createUrl, {
    method: 'POST', headers: { authorization: `Bearer ${key}` }, body: { input: safeInput(request) }, signal: request.signal,
  }, policy);
  if (!isRecord(created)) fail('Provider returned an invalid response');
  const remoteId = ownString(created, 'id');
  if (!remoteId || !/^[A-Za-z0-9_-]{1,200}$/.test(remoteId)) fail('Provider returned an invalid response');
  await request.onSubmitted(remoteId);
  const pollUrl = joinFixedPath(base, `/predictions/${encodeURIComponent(remoteId)}`);

  for (let index = 0; index < maxPolls; index += 1) {
    await pause(pollIntervalMs, request.signal);
    const polled = await transport(pollUrl, {
      method: 'GET', headers: { authorization: `Bearer ${key}` }, signal: request.signal,
    }, policy);
    if (!isRecord(polled)) fail('Provider returned an invalid response');
    const status = ownString(polled, 'status');
    if (status === 'succeeded') return { ...extractReplicateOutput(polled.output, request.kind, policy), remoteId };
    if (status === 'failed' || status === 'canceled') fail('Provider generation failed');
    if (status !== 'starting' && status !== 'processing') fail('Provider returned an invalid response');
  }
  fail('Provider polling limit reached');
}

export async function generate(
  providerValue: Provider,
  request: GenerationRequest,
  options: GenerateOptions = {},
): Promise<GenerationOutput> {
  try {
    const inspected = inspectGeneration(providerValue, request, options);
    const { provider, policy } = inspected;
    if (
      typeof request.prompt !== 'string' || request.prompt.length > 16_000 ||
      typeof request.onSubmitted !== 'function' || !(request.signal instanceof AbortSignal) ||
      (request.referenceUrl !== undefined && typeof request.referenceUrl !== 'string')
    ) fail('Invalid generation request');
    if (request.signal.aborted) fail('Generation aborted');
    if (provider.protocol === 'demo') return demo(request, policy);
    if (request.referenceUrl) validateMediaUrl(request.referenceUrl, policy, { allowDemo: true });
    const base = inspected.base!;
    const key = inspected.key!;
    const transport = options.transport ?? safeJsonRequest;
    const pollIntervalMs = options.pollIntervalMs ?? 5_000;
    const maxPolls = options.maxPolls ?? 60;
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 300_000) fail('Invalid polling policy');
    if (!Number.isInteger(maxPolls) || maxPolls < 1 || maxPolls > 60 || pollIntervalMs * maxPolls > 300_000) {
      fail('Invalid polling policy');
    }

    if (provider.protocol === 'openai') return await openAi(provider, request, base, key, transport, policy);
    if (provider.protocol === 'fal') return await fal(provider, request, base, key, transport, policy, pollIntervalMs, maxPolls);
    if (provider.protocol === 'replicate') return await replicate(provider, request, base, key, transport, policy, pollIntervalMs, maxPolls);
    fail('Provider protocol is not supported');
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    if (request.signal?.aborted) throw new AdapterError('Generation aborted');
    throw new AdapterError('Provider request failed');
  }
}
