import type { OnboardingStep } from './types';
import { S } from '../selectors';

export const step05: OnboardingStep = {
  id: 'agent_use_browser',
  stage: 'learn_features',
  index: 5,
  title: 'Have an agent use the browser',
  description: 'Let an agent take control of your browser.',
  videoSrc: '/onboarding-videos/v2/05.mp4',
  videoDurationLabel: '0:30',
  requiresDashboard: true,
  dependsOn: [{ stepId: 'use_browser', reopen: 'walk_again' }],
  ops: [
    { kind: 'move_to', target: S.newAgentButton },
    { kind: 'popup', text: 'Time for a fresh chat that surfs the web.' },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: S.newAgentButton },
    },
    // Offset nudge: cursor SVG is asymmetric (tip top-left, body down-right),
    // so default rect-center pinning makes the body bleed over the
    // paperclip "Attach file" button right next to this icon. Pulling
    // the tip ~8px left keeps the body inside this icon's footprint.
    { kind: 'move_to', target: S.elementSelectionToggle, offset: { x: -8, y: 0 } },
    { kind: 'popup', text: 'Tap here to plug a browser into this chat.' },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: S.elementSelectionToggle },
    },
    // AC demonstrates the drag-select on the browser card, then asks the
    // user to do the same gesture for real (the actual product wires up
    // the selection during a real mouse drag).
    { kind: 'drag_select', target: 'browser-card' },
    {
      kind: 'popup',
      text: 'Now you try! Drag a box around the browser to link it.',
    },
    {
      kind: 'wait_user',
      condition: { kind: 'event_bus', event: 'agent:attached_to_browser' },
      timeoutMs: 90000,
    },
    { kind: 'move_to', target: S.chatInput },
    {
      kind: 'type_into',
      target: S.chatInput,
      text: 'Pull up the open swarm website (openswarm.com) and find the docs',
      speedMs: 12,
    },
    { kind: 'move_to', target: S.chatSendButton },
    { kind: 'click', target: S.chatSendButton, simulate: true },
    // Quick canvas-controls tour, NOT a real step. The user now has a
    // browser + chat on the canvas, which is the first time those
    // toolbar buttons (fit-to-view, tidy, minimap) actually have
    // anything meaningful to do. AC just hovers each one and drops a
    // single short popup; no waits, no clicks expected from the user.
    { kind: 'move_to', target: S.canvasFitToView },
    { kind: 'popup', text: 'Heads up! This snaps everything back into view.' },
    { kind: 'delay', ms: 1800 },
    { kind: 'move_to', target: S.canvasTidyLayout },
    { kind: 'popup', text: 'And this auto tidies your layout.' },
    { kind: 'delay', ms: 1800 },
    { kind: 'move_to', target: S.canvasMinimapToggle },
    { kind: 'popup', text: 'Pop on a minimap whenever things get crowded.' },
    { kind: 'delay', ms: 1800 },
    { kind: 'outro' },
  ],
};
