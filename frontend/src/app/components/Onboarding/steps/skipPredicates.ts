// Shared skipIf predicates. Each returns true when the corresponding step
// is already-done in current Redux state — used to pre-mark completed
// milestones for upgrading users and to short-circuit "Show me" if the
// user already did the thing.

import type { RootState } from '@/shared/state/store';

export function hasModelConnected(s: RootState): boolean {
  const d = s.settings.data as any;
  if (!d) return false;
  if (d.connection_mode === 'openswarm-pro' && d.openswarm_bearer_token) return true;
  return Boolean(
    d.anthropic_api_key ||
      d.openai_api_key ||
      d.google_api_key ||
      d.openrouter_api_key,
  );
}

export function hasAnyToolEnabled(s: RootState): boolean {
  const items = s.tools?.items ?? {};
  // Match the Switch's read in Tools.tsx: `tool.enabled !== false`. Tools
  // installed before the `enabled` field existed have it as undefined,
  // which the Switch treats as "on" — so we should too. Otherwise step 2
  // never auto-skips for users who already have integrations installed.
  return Object.values(items).some((t: any) => t?.enabled !== false);
}

// True when a YouTube-shaped tool is currently enabled. Used by step 2's
// wait-for-toggle so the wait only resolves when YouTube is actually ON,
// regardless of how many times the user toggles. Step 2 uses YouTube to
// match the rest of the tour (step 3 prompts for a YouTube video summary,
// so enabling YouTube here is a coherent throughline).
export function isYoutubeEnabled(s: RootState): boolean {
  const items = s.tools?.items ?? {};
  return Object.values(items).some((t: any) => {
    const name = (t?.name ?? '').toLowerCase();
    const command = (t?.command ?? '').toLowerCase();
    const isYoutube = name === 'youtube' || command.includes('youtube');
    return isYoutube && t?.enabled !== false;
  });
}

export function hasAnyAgentLaunched(s: RootState): boolean {
  const sessions = s.agents?.sessions ?? {};
  return Object.keys(sessions).length > 0;
}

export function hasAnySkillInstalled(s: RootState): boolean {
  const items = s.skills?.items ?? [];
  if (Array.isArray(items)) return items.length > 0;
  return Object.keys(items).length > 0;
}
