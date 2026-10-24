// The tunnel provider registry. `agent-relay remote on` walks this list and
// takes the first provider that is installed.
import * as tailscale from './tailscale.mjs';
import * as cloudflare from './cloudflare.mjs';
import * as ngrok from './ngrok.mjs';

export const providers = [tailscale, cloudflare, ngrok];
export const byId = Object.fromEntries(providers.map(provider => [provider.id, provider]));

export const get = id => byId[id] ?? null;

// The order matters: the first installed provider wins.
export async function pick({preferred} = {}) {
  if (preferred) {
    const provider = byId[preferred];
    if (!provider) return {provider: null, reason: 'unknown-provider', hint: `Unknown provider ${preferred}. Choose one of: ${providers.map(p => p.id).join(', ')}.`};
    const state = await provider.detect();
    return {provider, state, reason: state.available ? 'preferred' : 'not-installed'};
  }
  for (const provider of providers) {
    const state = await provider.detect();
    if (state.available) return {provider, state, reason: 'first-available'};
  }
  return {provider: null, reason: 'none', hint: 'No tunnel provider is installed. Install Tailscale for the default, or cloudflared, or ngrok.'};
}
