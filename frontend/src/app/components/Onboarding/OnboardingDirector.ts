// Singleton glue between the Onboarding panel UI and the AC runtime.
//
// Lifecycle:
//   - OnboardingRoot mounts, calls Director.attach({ acRef, store, getAccentColor })
//   - Panel "Show me" click → Director.startStep(stepId, sourceRect)
//   - Director creates an AbortController, hands off to acRuntime.runStep
//   - User dismisses panel mid-step → Director.cancelStep() → controller.abort()
//
// The runtime is the only place that touches the cursor handle directly.
// The Director is just a thin policy layer — it picks the spawn point,
// resolves dependencies, and translates Redux state into "should we walk
// step 4 again before step 5."

import type { Store } from '@reduxjs/toolkit';
import type { RootState } from '@/shared/state/store';
import type { RefObject } from 'react';
import { runStep } from './ac/acRuntime';
import type { AgenticCursorHandle } from './ac/AgenticCursor';
import type { OnboardingStep } from './steps/types';
import { STEPS, findStepById } from './steps';
import { report } from './telemetry';

interface AttachArgs {
  acRef: RefObject<AgenticCursorHandle | null>;
  store: Store<RootState>;
  getAccentColor: () => string;
  // Resolves whether a dependency's outcome is still satisfied. If true,
  // the dependency's flow is skipped during walk_again. Step-5's depCheck,
  // for example, asks "is there still a live browser card on the canvas?"
  isDependencySatisfied: (depId: string) => boolean;
}

class OnboardingDirector {
  private acRef: RefObject<AgenticCursorHandle | null> | null = null;
  private store: Store<RootState> | null = null;
  private getAccentColor: () => string = () => '#E8927A';
  private isDependencySatisfied: (depId: string) => boolean = () => false;
  private currentAbort: AbortController | null = null;

  attach(args: AttachArgs) {
    this.acRef = args.acRef;
    this.store = args.store;
    this.getAccentColor = args.getAccentColor;
    this.isDependencySatisfied = args.isDependencySatisfied;
  }

  detach() {
    this.cancelStep();
    this.acRef = null;
    this.store = null;
  }

  isRunning(): boolean {
    return this.currentAbort !== null;
  }

  cancelStep(): void {
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }
  }

  async startStep(
    stepId: string,
    spawnPoint: { x: number; y: number },
  ): Promise<void> {
    if (!this.acRef || !this.store) {
      console.warn('[onboarding] Director not attached');
      return;
    }
    const ac = this.acRef.current;
    if (!ac) {
      console.warn('[onboarding] AC ref not yet mounted');
      return;
    }
    const step = findStepById(stepId);
    if (!step) {
      console.warn('[onboarding] step not found', stepId);
      return;
    }

    this.cancelStep();
    const controller = new AbortController();
    this.currentAbort = controller;

    // Adaptive abort hooks — fire controller.abort() so the runtime's
    // existing cleanup path takes over (cursor outros, popup retreats,
    // panel re-shows for the user to re-attempt).
    //
    // 1. Lost target — tracker fires this when its cached element has
    //    been disconnected for >2.5s (user navigated away, collapsed
    //    the section, swapped a card out from under us).
    // 2. Hash-route change — user clicked a sidebar entry / dashboard
    //    item / settings link mid-flow. Capture the route at start time
    //    and abort if it changes; lets the user explore freely without
    //    the AC stranding itself on the wrong page.
    const startHash = window.location.hash;
    const onLost = () => {
      report('step_aborted_lost_target', { step_id: stepId });
      controller.abort();
    };
    const onRouteChange = () => {
      if (window.location.hash !== startHash) {
        report('step_aborted_route_change', {
          step_id: stepId,
          from: startHash,
          to: window.location.hash,
        });
        controller.abort();
      }
    };
    window.addEventListener('openswarm:onboarding:lost_target', onLost);
    window.addEventListener('hashchange', onRouteChange);

    try {
      await runStep({
        step,
        spawnPoint,
        ac,
        store: this.store,
        accentColor: this.getAccentColor(),
        signal: controller.signal,
        findStep: findStepById,
        isDependencySatisfied: this.isDependencySatisfied,
      });
    } finally {
      window.removeEventListener('openswarm:onboarding:lost_target', onLost);
      window.removeEventListener('hashchange', onRouteChange);
      if (this.currentAbort === controller) {
        this.currentAbort = null;
      }
    }
  }

  // Step 6 previously triggered seed-orchestration-demo here to drop a
  // stub "research" agent on the canvas. We removed it — step 6 now
  // reuses the real chat the user created in step 3 as the "previous
  // chat" the orchestrator bosses around, so no stub is needed.
}

export const onboardingDirector = new OnboardingDirector();

// Convenience: return the ordered roadmap (1..10) so callers don't import STEPS
// directly when they just need the schedule. STEPS itself is the source of truth.
export function getRoadmap(): OnboardingStep[] {
  return STEPS;
}
