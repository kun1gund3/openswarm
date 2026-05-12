import type { OnboardingStep } from './types';
import { S } from '../selectors';
import { hasAnyAgentLaunched, isYoutubeEnabled } from './skipPredicates';

// Primary demo: summarize a YouTube video — requires the YouTube
// transcript MCP, which step 2 enables. If a user reaches step 3 with
// YouTube not enabled (they skipped step 2's flow, dismissed it, or
// toggled YouTube back off), the agent would hang trying to call a
// missing MCP. The fallback prompt uses the agent's built-in web tools
// to do live research — same "agent does real work" demo, no MCP
// dependency.
const YOUTUBE_PROMPT =
  'What is this youtube video about: https://youtu.be/_NKj8KQMY-k?si=rEk4KO2bOpa5Vo0z. Do not use browser agents.';
const FALLBACK_PROMPT =
  'Find the latest news about AI from the web and give me a short summary.';

export const step03: OnboardingStep = {
  id: 'launch_agent',
  stage: 'get_started',
  index: 3,
  title: 'Launch your first Agent',
  description: 'Click + to fire up a new Agent in a dashboard.',
  videoSrc: './onboarding-videos/v2/03.mp4',
  videoDurationLabel: '0:24',
  skipIf: hasAnyAgentLaunched,
  requiresDashboard: true,
  ops: [
    { kind: 'move_to', target: S.newAgentButton },
    { kind: 'popup', text: 'Tap the plus to start a fresh chat.' },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: S.newAgentButton },
    },
    // Chat input mounts asynchronously after + is clicked. waitForSelector
    // inside the runtime handles the small delay before type_into runs.
    {
      kind: 'type_into',
      target: S.chatInput,
      // Anti-browser-agent directive on the YouTube path: the summary
      // can be answered entirely from the youtube transcript MCP, and
      // browser agents misbehave under load. The fallback path
      // intentionally USES web tools — that's the whole point of the
      // fallback (no MCP needed, agent still demonstrates real work).
      text: (state) => (isYoutubeEnabled(state) ? YOUTUBE_PROMPT : FALLBACK_PROMPT),
      speedMs: 12,
    },
    // Auto-send the prompt — same pattern as steps 5/6/8. Without this,
    // the user lands on a typed-but-unsent prompt and has to hit send
    // themselves, which is awkward and out-of-line with the other steps.
    { kind: 'move_to', target: S.chatSendButton },
    { kind: 'click', target: S.chatSendButton, simulate: true },
    {
      kind: 'wait_user',
      condition: { kind: 'event_bus', event: 'chat:message_sent' },
      timeoutMs: 30000,
    },
    { kind: 'outro' },
  ],
};
