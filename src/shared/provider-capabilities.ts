import type { MediaKind, Protocol, ProviderCapability } from './types.js';

const CAPABILITIES: Readonly<Record<Protocol, readonly ProviderCapability[]>> = Object.freeze({
  demo: Object.freeze(['image', 'video'] as const),
  openai: Object.freeze(['image'] as const),
  videos: Object.freeze(['video'] as const),
  relay: Object.freeze(['image', 'video'] as const),
  fal: Object.freeze(['image', 'video'] as const),
  replicate: Object.freeze(['image', 'video'] as const),
});

export function providerCapabilities(protocol: Protocol): ProviderCapability[] {
  return [...CAPABILITIES[protocol]];
}

export function providerSupportsKind(protocol: Protocol, kind: MediaKind): boolean {
  return CAPABILITIES[protocol].includes(kind);
}
