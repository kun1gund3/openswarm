// Shared skipIf predicates. Each returns true when the corresponding step
// is already-done in current Redux state — used to pre-mark completed
// milestones for upgrading users and to short-circuit "Show me" if the
// user already did the thing.

import type { RootState } from '@/shared/state/store';
import {
  hasAnyActiveSubscription,
} from '@/shared/state/subscriptionsSlice';

export function hasModelConnected(s: RootState): boolean {
  const d = s.settings.data as any;
  if (!d) return false;
  // Path 1: OpenSwarm Pro cloud bearer.
  if (d.connection_mode === 'openswarm-pro' && d.openswarm_bearer_token) return true;
  // Path 2: first-party API keys typed into Settings → Models.
  if (
    d.anthropic_api_key ||
    d.openai_api_key ||
    d.google_api_key ||
    d.openrouter_api_key
  ) {
    return true;
  }
  // Path 3: custom OpenAI-compatible providers (LM Studio, Ollama, etc.).
  // Match the validity rule the Settings page uses to render the provider
  // row: name + base_url present. The api_key field is intentionally
  // optional — local OpenAI-compatible servers don't require one.
  const customs = (d.custom_providers || []) as any[];
  if (customs.some((cp) => cp?.name?.trim() && cp?.base_url?.trim())) {
    return true;
  }
  // Path 4: external OAuth subscriptions (Claude Max, ChatGPT, etc.). The
  // tokens live in 9Router-managed storage and are surfaced to the frontend
  // only via the subscriptionsSlice mirror of /agents/subscriptions/status.
  if (hasAnyActiveSubscription(s)) return true;
  return false;
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

// True if the PDF-handling skill is installed. Used by step 7 in place
// of hasAnySkillInstalled so installing any *other* skill doesn't
// auto-skip the PDF-specific install demo. Matches on id OR name OR
// command containing 'pdf' (case-insensitive) — the skill might land
// under any of those depending on how the user installed it.
export function hasPdfSkillInstalled(s: RootState): boolean {
  const items = s.skills?.items as any;
  const list: any[] = Array.isArray(items) ? items : Object.values(items ?? {});
  return list.some((sk: any) => {
    const id = (sk?.id ?? '').toString().toLowerCase();
    const name = (sk?.name ?? '').toString().toLowerCase();
    const cmd = (sk?.command ?? '').toString().toLowerCase();
    return id.includes('pdf') || name.includes('pdf') || cmd.includes('pdf');
  });
}

// True if any browser card exists on the canvas. Used by step 4 to
// auto-skip the "open a browser" walkthrough for users who already
// have one parked on their dashboard.
export function hasAnyBrowserSpawned(s: RootState): boolean {
  const cards = (s as any).dashboardLayout?.browserCards ?? {};
  return Object.keys(cards).length > 0;
}
