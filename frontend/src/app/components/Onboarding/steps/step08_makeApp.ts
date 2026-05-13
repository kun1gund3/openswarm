import type { OnboardingStep } from './types';
import { S } from '../selectors';

export const step08: OnboardingStep = {
  id: 'make_app',
  stage: 'learn_features',
  index: 8,
  title: 'Make an App',
  description: 'Prompt interactive applications into existence.',
  videoSrc: './onboarding-videos/v2/08.mp4',
  videoDurationLabel: '0:42',
  ops: [
    { kind: 'move_to', target: S.sidebarApps },
    { kind: 'popup', text: 'Swing by Apps.' },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: S.sidebarApps },
    },
    { kind: 'move_to', target: S.appsNewButton },
    { kind: 'popup', text: 'Spin up a fresh one.' },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: S.appsNewButton },
    },
    // After clicking +, the /apps/new route mounts ViewEditor which
    // asynchronously renders AgentChat in the left pane. Three failure
    // modes we have to defend against:
    //   1. Cold start can take well over 8 s before AgentChat mounts
    //      inside the app-builder scope wrapper — vite warm-up + session
    //      creation + three parallel onboarding sessions racing the
    //      backend's probe-model queue stack up under load.
    //   2. The /apps/new route briefly mounts → unmounts → remounts
    //      ViewEditor (runtime/start → runtime/stop → runtime/start
    //      visible in the dev log when the React Strict-Mode double-
    //      effect collides with the route transition). The scope
    //      wrapper disappears during the unmount, and wait_for_dom
    //      polling can land in that gap.
    //   3. AgentChat's hardcoded `disabled={false}` means the
    //      contenteditable attribute is always "true" when the input
    //      mounts — so we don't need to gate on it (and gating on a
    //      stringly-serialized React attribute introduces a brittle
    //      dependency on React's attribute reflection).
    //
    // Fix: wait for the SCOPED chat-input. 30 s timeout swallows any
    // reasonable cold start including the mount-unmount-remount cycle.
    // An extra 350 ms `delay` lets the post-mount React commit settle
    // (refs, event handlers, focus shims) before we move the cursor.
    {
      kind: 'popup',
      text: 'Loading the App Builder...',
    },
    {
      kind: 'wait_for_dom',
      css: '[data-onboarding-scope="app-builder"] [data-onboarding="chat-input"]',
      timeoutMs: 60000,
    },
    { kind: 'delay', ms: 350 },
    // The App Builder chat lives in the left pane on /apps/new — the
    // chat-input selector resolves to it via the App Builder scope
    // priority in resolveSelector.
    { kind: 'move_to', target: S.chatInput },
    {
      kind: 'type_into',
      target: S.chatInput,
      text: 'Make me a pdf previewer app',
      speedMs: 12,
    },
    // AC auto-clicks send per spec ("the AC should auto send this").
    // Tiny pause first to let onInput's draft-state commit land — the
    // send button is disabled-while-empty, so clicking before React's
    // next commit sometimes lands on the stale-disabled button.
    { kind: 'delay', ms: 120 },
    { kind: 'move_to', target: S.chatSendButton },
    { kind: 'click', target: S.chatSendButton, simulate: true },
    // Wait only for chat:message_sent (the prompt actually going out).
    // Don't wait for app:generation_done — the App Builder agent can
    // take any of several legitimate paths: save as a standalone HTML
    // to ~/Downloads and open in the system browser, save as an
    // OpenSwarm Output, or skip saving entirely. We can't reliably
    // detect every completion shape, and trapping the user in step 8
    // until a specific one happens is the worst possible UX.
    {
      kind: 'wait_user',
      condition: { kind: 'event_bus', event: 'chat:message_sent' },
      timeoutMs: 30000,
    },
    {
      kind: 'popup',
      text: "Cooking up your app! It'll pop up in a sec. Go explore while it brews.",
    },
    { kind: 'delay', ms: 4000 },
    { kind: 'outro' },
  ],
};
