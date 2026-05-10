// Top-level mount for the onboarding-v2 system. Hydrates persisted state,
// attaches the Director, mounts the Panel + AC.

import React, { useEffect, useRef } from 'react';
import { useStore } from 'react-redux';
import type { Store } from '@reduxjs/toolkit';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { RootState } from '@/shared/state/store';
import {
  hydrate,
  init,
  loadFromStorage,
  persistToStorage,
  markStepCompleted,
} from './OnboardingProgressSlice';
import AgenticCursor, { type AgenticCursorHandle } from './ac/AgenticCursor';
import { onboardingDirector } from './OnboardingDirector';
import { STEPS } from './steps';
import OnboardingPanel from './OnboardingPanel';
import { onboardingBus } from './eventBus';
import { report } from './telemetry';

const PERSIST_DEBOUNCE_MS = 200;

const OnboardingRoot: React.FC = () => {
  const acRef = useRef<AgenticCursorHandle | null>(null);
  const dispatch = useAppDispatch();
  const store = useStore<RootState>() as Store<RootState>;
  const tokens = useClaudeTokens();
  const progress = useAppSelector((s) => s.onboardingProgress);
  const userId = useAppSelector((s) => s.settings.data.user_id ?? null);
  const settingsLoaded = useAppSelector((s) => s.settings.loaded);

  // Hydrate from localStorage on first mount, or initialize fresh state.
  useEffect(() => {
    if (progress.initialized) return;
    if (!settingsLoaded) return;

    const persisted = loadFromStorage();
    if (persisted) {
      dispatch(hydrate(persisted));
      return;
    }

    // Always start with no pre-completed steps. The legitimate "v1.0.29
    // user has a model already configured" case is now handled by the
    // user simply walking through step 1 — the skipIf predicates still
    // exist but they fire only via the live subscriber's baseline-aware
    // path, which gates them behind real user action. Pre-marking at
    // init time was unreliable: backend fetches land async, and at
    // mount time we either don't have data yet (so nothing to mark)
    // or we have it via stale Redux from a previous run (so we
    // wrongly mark the wrong things). Net: simpler + always-fresh.
    dispatch(
      init({
        currentStepId: STEPS[0]?.id ?? null,
        preCompleted: [],
        disableSkipIf: false,
      }),
    );
  }, [progress.initialized, settingsLoaded, dispatch, store]);

  // Watch for "user did the onboarding thing outside the flow" + bridge
  // selected Redux signals to the event bus.
  //
  // Critical perf detail: the naive store.subscribe runs on EVERY dispatch
  // (chat streaming = hundreds per second). The inner work — looping all
  // STEPS, walking sessions, walking browserCards — is small individually
  // but death-by-a-thousand-cuts over a long agent stream.
  //
  // Mitigation: collapse all dispatches in the same microtask into a
  // single check via a `pending` flag + queueMicrotask. The state we
  // care about (skipIf evaluations, card counts, session statuses) only
  // matters at *commit* boundaries, never per-action — so coalescing
  // dispatches is free.
  useEffect(() => {
    let last = new Set(progress.completedSteps);
    let lastBrowserCount = Object.keys(
      store.getState().dashboardLayout?.browserCards ?? {},
    ).length;
    let lastSessionCount = Object.keys(
      (store.getState() as any).agents?.sessions ?? {},
    ).length;
    let lastOutputCount = Object.keys(
      (store.getState() as any).outputs?.items ?? {},
    ).length;

    // Baseline-snapshot of which skipIf predicates were ALREADY satisfied
    // at startup. Any step whose predicate is in this set won't be
    // auto-marked by the live subscriber — the user has to actually go
    // through it (or do the equivalent thing during this run). This kills
    // the "step 3 instantly marks done because backend fetchSessions
    // landed" bug, where async data arriving post-mount caused predicates
    // to flip false→true and the subscriber marked steps without any
    // user interaction.
    //
    // The snapshot is captured on the first store-tick AFTER a small
    // settle delay — enough for fetchSettings/Sessions/Skills/Outputs
    // to all land. Anything true at that point counts as "pre-existing
    // backend state" and is excluded from auto-marking for the rest
    // of the run.
    let baselinePredicateMet: Set<string> | null = null;
    const baselineCaptureAt = Date.now() + 2000;
    let lastStatuses: Record<string, string> = {};
    const seedStatuses = () => {
      const sessions = (store.getState() as any).agents?.sessions ?? {};
      const out: Record<string, string> = {};
      for (const [id, s] of Object.entries(sessions)) {
        const st = (s as any)?.status;
        if (typeof st === 'string') out[id] = st;
      }
      lastStatuses = out;
    };
    seedStatuses();

    let pending = false;
    // Cached slice references — if these are referentially equal to what
    // we saw last microtask, NOTHING we care about could have changed.
    // Redux Toolkit's Immer produces new references only on slice writes,
    // so identity comparison is sound and ~free. Drops the steady-state
    // cost of this subscriber to a 5-pointer comparison per microtask.
    let prevAgents: unknown = null;
    let prevDashboardLayout: unknown = null;
    let prevOutputs: unknown = null;
    let prevSkills: unknown = null;
    let prevSettings: unknown = null;

    const runCheck = () => {
      pending = false;
      const state = store.getState();
      // Reference-equality early-out. If none of the slices that drive
      // any predicate, count, or status walk have changed reference,
      // there's no work to do. Streaming chunks, agent message updates,
      // settings polls all dispatch but most of them touch a single
      // unrelated slice — so this skips ~95% of microtask wakeups.
      const sAgents = (state as any).agents;
      const sLayout = state.dashboardLayout;
      const sOutputs = (state as any).outputs;
      const sSkills = (state as any).skills;
      const sSettings = (state as any).settings;
      const anyChanged =
        sAgents !== prevAgents ||
        sLayout !== prevDashboardLayout ||
        sOutputs !== prevOutputs ||
        sSkills !== prevSkills ||
        sSettings !== prevSettings;
      prevAgents = sAgents;
      prevDashboardLayout = sLayout;
      prevOutputs = sOutputs;
      prevSkills = sSkills;
      prevSettings = sSettings;
      if (!anyChanged) return;
      const suppressSkipIf = state.onboardingProgress?.disableSkipIf === true;

      // Capture the baseline of pre-satisfied predicates after the
      // initial fetch settle. This snapshot is sticky for the run.
      if (baselinePredicateMet === null && Date.now() >= baselineCaptureAt) {
        baselinePredicateMet = new Set();
        for (const s of STEPS) {
          if (s.skipIf?.(state)) baselinePredicateMet.add(s.id);
        }
      }

      const allSkippablesDone = STEPS.every(
        (s) => !s.skipIf || last.has(s.id),
      );
      // Skip the live evaluation entirely if (a) suppression is on,
      // (b) baseline hasn't captured yet (we're still in the settle
      // window — predicates would just see fetch-driven false→true
      // flips that we want to ignore), or (c) every skippable step
      // is already marked.
      if (
        !suppressSkipIf &&
        !allSkippablesDone &&
        baselinePredicateMet !== null
      ) {
        for (const s of STEPS) {
          if (last.has(s.id)) continue;
          if (!s.skipIf) continue;
          // Predicates that were ALREADY true at baseline are excluded —
          // the only way to mark them complete now is via genuine user
          // action (bus events fired from product code) or via the
          // tour's outro path. Prevents fetched-from-backend data from
          // leaking past the gate later in the run.
          if (baselinePredicateMet.has(s.id)) continue;
          if (s.skipIf(state)) {
            last = new Set([...Array.from(last), s.id]);
            dispatch(markStepCompleted(s.id));
            report('step_skipped_via_skipif', { step_id: s.id, stage: s.stage });
          }
        }
      }
      const bc = Object.keys(state.dashboardLayout?.browserCards ?? {}).length;
      if (bc > lastBrowserCount) {
        onboardingBus.emit('browser:spawned');
      }
      lastBrowserCount = bc;

      const sessions = (state as any).agents?.sessions ?? {};
      const sc = Object.keys(sessions).length;
      if (sc > lastSessionCount) {
        onboardingBus.emit('agent:spawned');
      }
      lastSessionCount = sc;

      const outputs = (state as any).outputs?.items ?? {};
      const oc = Object.keys(outputs).length;
      if (oc > lastOutputCount) {
        onboardingBus.emit('app:generation_done');
      }
      lastOutputCount = oc;

      let nextStatuses: Record<string, string> | null = null;
      for (const [id, s] of Object.entries(sessions)) {
        const status = (s as any)?.status;
        if (typeof status !== 'string') continue;
        const prev = lastStatuses[id];
        if (prev !== status) {
          if (status === 'completed' && prev !== 'completed') {
            onboardingBus.emit('agent:completed');
          }
          nextStatuses ??= { ...lastStatuses };
          nextStatuses[id] = status;
        }
      }
      if (nextStatuses) lastStatuses = nextStatuses;
    };

    return store.subscribe(() => {
      // Coalesce N dispatches in the same microtask into 1 check. Cheap
      // boolean flag + queueMicrotask means the cost per dispatch is now
      // a single property write, not a full state walk. The actual work
      // still runs at most once per "tick" of state updates — which is
      // all that matters for skipIf semantics.
      if (pending) return;
      pending = true;
      queueMicrotask(runCheck);
    });
  }, [progress.completedSteps, dispatch, store]);

  // Persist Redux progress → localStorage, debounced.
  useEffect(() => {
    if (!progress.initialized) return;
    const t = window.setTimeout(() => {
      persistToStorage(store.getState().onboardingProgress);
    }, PERSIST_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [progress, store]);

  // Attach Director once the AC is mounted.
  useEffect(() => {
    onboardingDirector.attach({
      acRef,
      store,
      getAccentColor: () => tokens.accent.primary,
      isDependencySatisfied: (depId) => {
        // Step 4's outcome is "a browser card currently exists on the canvas."
        if (depId === 'use_browser') {
          const cards = store.getState().dashboardLayout?.browserCards ?? {};
          return Object.keys(cards).length > 0;
        }
        return false;
      },
    });
    return () => onboardingDirector.detach();
  }, [store, tokens.accent.primary]);

  // Don't render the panel until we know whether the user is signed in. The
  // panel sits on the dashboard, which only mounts post-sign-in anyway, but
  // this guard keeps us out of the SignInGate's z-index space.
  if (!settingsLoaded || !userId) return null;
  if (!progress.initialized) return null;

  return (
    <>
      <AgenticCursor ref={acRef} />
      <OnboardingPanel />
    </>
  );
};

export default OnboardingRoot;
