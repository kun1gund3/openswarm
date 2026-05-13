// AC runtime — executes a step's ACOp[] sequence by calling into the
// AgenticCursor handle and the gesture/typing helpers. Runs ops sequentially
// with `await`; aborts cleanly when the AbortSignal fires (user dismisses
// panel mid-step, opens a different step, etc).
//
// Pure async. Not a class. Director (in OnboardingDirector.ts) is the
// caller — it owns the lifecycle (AbortController, AC ref, accent color
// resolution from the theme).

import type { Store } from '@reduxjs/toolkit';
import type { RootState } from '@/shared/state/store';
import {
  recordMultiChoice,
  markStepCompleted,
  clearJustCompleted,
  setRunning,
  setCurrentStep,
} from '../OnboardingProgressSlice';
import { report, markStepStarted, clearStepTiming } from '../telemetry';
import { onboardingBus, type OnboardingEvent } from '../eventBus';
// (gate bump done via onboardingBus.resetReplayGate at runStep entry)
import { waitForSelector, resolveSelector } from '../selectors';
import {
  spawnGlowRect,
  clickRipple,
  animateDragSelect,
  sleep,
} from './ACGestures';
import { typeInto } from './ACTypewriter';
import type {
  ACOp,
  AdvanceCondition,
  OnboardingStep,
} from '../steps/types';
import type { AgenticCursorHandle } from './AgenticCursor';

interface RunContext {
  ac: AgenticCursorHandle;
  store: Store<RootState>;
  spawnPoint: { x: number; y: number };
  accentColor: string;
  signal: AbortSignal;
  silent: boolean; // suppress popups during dependency re-walks
  stepId: string;
  // Resolver function for finding a step by id (avoids circular import).
  findStep: (id: string) => OnboardingStep | undefined;
  // Cleanup for the highlight_section big glow.
  highlightCleanup: { current: (() => void) | null };
  // Wall-clock timestamp the current popup was shown at, or null if no
  // popup is active. Used by ensurePopupDwell to guarantee every popup
  // stays visible for at least MIN_POPUP_DWELL_MS before being replaced
  // or cleared by the next auto-transition op.
  popupShownAt: { current: number | null };
}

// Minimum time every popup stays visible before an auto-transition
// (move_to, click, type_into, drag_select, outro) or a popup replacement
// is allowed to clear it. user-driven transitions (wait_user resolving)
// also flow through here, but typically the user has already been
// reading for longer than this anyway. 6 s = streaming typewriter
// cadence + ~3 s post-stream read time, which was the user-asked floor
// for popups that don't require an explicit user action to advance.
const MIN_POPUP_DWELL_MS = 6000;

// Resolves once `ms` has elapsed or the signal aborts (whichever
// comes first). Used inside ensurePopupDwell so a step cancel doesn't
// hang on a popup that just appeared.
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Awaits the remaining minimum dwell time for the currently-displayed
// popup. No-op if no popup is active or the dwell has already elapsed.
async function ensurePopupDwell(ctx: RunContext): Promise<void> {
  const shownAt = ctx.popupShownAt.current;
  if (shownAt == null) return;
  const elapsed = performance.now() - shownAt;
  const remaining = MIN_POPUP_DWELL_MS - elapsed;
  if (remaining > 0) await abortableSleep(remaining, ctx.signal);
}

export interface RunStepArgs {
  step: OnboardingStep;
  spawnPoint: { x: number; y: number };
  ac: AgenticCursorHandle;
  store: Store<RootState>;
  accentColor: string;
  signal: AbortSignal;
  findStep: (id: string) => OnboardingStep | undefined;
  // Optional gate — if step.dependsOn[i] doesn't need re-walking (the
  // dependency's outcome is still satisfied), the caller passes a function
  // that returns true to skip it.
  isDependencySatisfied?: (depId: string) => boolean;
}

export async function runStep(args: RunStepArgs): Promise<void> {
  const { step, spawnPoint, ac, store, accentColor, signal, findStep } = args;

  store.dispatch(setRunning(true));
  store.dispatch(setCurrentStep(step.id));
  markStepStarted();
  // Bump the bus replay gate so any cached emits from prior steps (or
  // the user's exploration in between) can't accidentally satisfy this
  // step's wait_user gates. Subsequent once() subscriptions will only
  // match emits that happen AFTER this bump.
  onboardingBus.resetReplayGate();
  report('step_started', { step_id: step.id, stage: step.stage });

  const highlightCleanup: { current: (() => void) | null } = { current: null };
  const popupShownAt: { current: number | null } = { current: null };
  const ctx: RunContext = {
    ac,
    store,
    spawnPoint,
    accentColor,
    signal,
    silent: false,
    stepId: step.id,
    findStep,
    highlightCleanup,
    popupShownAt,
  };

  try {
    await ac.fadeIn(spawnPoint);

    // Pre-flight: if the step needs a dashboard route and the user is on
    // a different page (Settings closed but they're on /actions, /skills,
    // etc), walk them into a dashboard first. Without this, the very
    // first move_to of step 3/4/5/6/8 hits a missing target and the
    // cursor stalls or strands itself over unrelated UI.
    if (step.requiresDashboard && !isInDashboardRoute()) {
      await runOps(buildOpenDashboardOps(), ctx);
    }

    if (step.dependsOn?.length) {
      for (const dep of step.dependsOn) {
        if (args.isDependencySatisfied?.(dep.stepId)) continue;
        const depStep = findStep(dep.stepId);
        if (!depStep) continue;
        if (dep.reopen === 'walk_again') {
          report('dependency_walk', { step_id: step.id, dep_id: dep.stepId });
          // Brief framing popup so the user knows why the cursor is
          // about to walk them through a previous step's flow (e.g.
          // step 5 asking step 4 to re-open a browser because they
          // closed the one they spawned originally).
          ac.showPopup('Quick setup before we continue.');
          ctx.popupShownAt.current = performance.now();
          await sleep(700);
          // Non-silent walk: show popups so the user understands what
          // each move_to is asking. Previously silent=true meant the
          // cursor wandered through the dep's ops with no labels —
          // robust but confusing. Telemetry isn't bumped for op-level
          // events to avoid double-counting (silent kept for that).
          await runOps(depStep.ops, { ...ctx, silent: false, stepId: depStep.id });
        }
      }
    }

    await runOps(step.ops, ctx);
    report('step_completed', { step_id: step.id });
    store.dispatch(markStepCompleted(step.id));
    // Belt-and-suspenders: dispatch clearJustCompleted from the runtime
    // 950ms after the celebration starts. The OnboardingPanel ALSO has
    // its own useEffect timer for this, but the runtime-side timer
    // guarantees the celebration unsticks even if the panel's effect
    // gets cancelled by a re-render race or AnimatePresence interaction
    // — both dispatches go through the same idempotent reducer, so
    // double-firing is harmless.
    window.setTimeout(() => {
      const cur = store.getState().onboardingProgress;
      if (cur?.justCompletedStepId === step.id) {
        store.dispatch(clearJustCompleted());
      }
    }, 950);
  } catch (err) {
    const isAbort =
      (err as DOMException)?.name === 'AbortError' || signal.aborted;
    const msg = (err as Error)?.message ?? String(err);
    const isSelectorTimeout = /^waitForSelector:/.test(msg);

    if (isAbort) {
      report('step_aborted', { step_id: step.id });
    } else if (isSelectorTimeout) {
      report('step_selector_timeout', { step_id: step.id, error: msg });
    } else {
      console.error('[onboarding] step failed', step.id, err);
      report('step_error', { step_id: step.id, error: msg });
    }

    // Re-show the panel IMMEDIATELY so the user sees it slide back in
    // alongside the cursor's friendly retreat. Otherwise the panel
    // stays hidden through the 1.8s recovery popup + fadeOut, which
    // looks like the onboarding has crashed.
    store.dispatch(setRunning(false));

    try {
      ac.hidePopup();
      ac.stopTracking();
      if (highlightCleanup.current) {
        highlightCleanup.current();
        highlightCleanup.current = null;
      }
      const showMessage = !signal.reason || signal.reason !== 'user-cancel';
      if (showMessage) {
        // Diagnostic: surface a short version of the actual error in
        // the recovery popup so we can see WHY the step bailed without
        // needing DevTools open. 180-char cap keeps it readable.
        const isAbortErr =
          (err as DOMException)?.name === 'AbortError' || signal.aborted;
        const errSnippet = isAbortErr
          ? ''
          : ((err as Error)?.message ?? String(err)).slice(0, 180);
        const debugSuffix = errSnippet
          ? `\n\n[debug] ${errSnippet}`
          : '';
        // Stash the full error on window so a dev can grab it from
        // DevTools (`window.__OPENSWARM_LAST_ONBOARDING_ERR__`) even
        // if the streaming popup hides the suffix. Full untruncated
        // message + stack lives here, the 180-char snippet is just
        // for the popup.
        try {
          (window as any).__OPENSWARM_LAST_ONBOARDING_ERR__ = {
            step_id: step.id,
            message: (err as Error)?.message ?? String(err),
            stack: (err as Error)?.stack,
            at: new Date().toISOString(),
          };
          // eslint-disable-next-line no-console
          console.error(
            '[onboarding] step bailed:',
            step.id,
            (err as Error)?.message ?? err,
            err,
          );
        } catch {
          /* defensive — never let diagnostics throw */
        }
        ac.showPopup(
          "No worries, feel free to explore. Tap Show me whenever you're ready." +
            debugSuffix,
        );
        // ACPopup streams text at ~30 ms/char + ~210 ms per punctuation
        // mark, so a 240-char popup (base copy + 180-char debug
        // suffix) takes ~10 s just to finish streaming. With a 5 s
        // dwell the [debug] line never even appears on screen before
        // the popup closes — which is why the user saw only the base
        // recovery copy in every failure run. 14 s gives the streamer
        // time to finish AND leaves a few seconds for the user to
        // actually read the diagnostic line.
        await new Promise<void>((r) => window.setTimeout(r, 14000));
      }
    } catch {
      /* defensive — never let cleanup throw */
    }

    // Retreat to the original spawnPoint — that's the icon's home
    // position from before the panel hid itself, and after the
    // setRunning(false) above the panel slides back to that exact spot.
    // We previously re-read the live icon rect here, but that fires
    // mid-slide-animation and yields transient coordinates (sometimes
    // (0,0) if Framer hasn't applied the transform yet) — which is
    // why the cursor was landing in the title-bar / kill-button area.
    try {
      await ac.fadeOut(spawnPoint);
    } catch {
      /* swallow */
    }
  } finally {
    if (highlightCleanup.current) {
      highlightCleanup.current();
      highlightCleanup.current = null;
    }
    store.dispatch(setRunning(false));
    clearStepTiming();
  }
}

async function runOps(ops: ACOp[], ctx: RunContext): Promise<void> {
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (ctx.signal.aborted) {
      throw new DOMException('aborted', 'AbortError');
    }
    // Op-level telemetry — gives drop-off granularity beyond
    // step_started / step_completed. Skipped during silent dependency
    // re-walks to avoid double-reporting.
    if (!ctx.silent) {
      report('op_started', {
        step_id: ctx.stepId,
        op_index: i,
        op_kind: op.kind,
      });
    }
    const opStart = Date.now();
    try {
      await runOp(op, ctx);
      if (!ctx.silent) {
        report('op_completed', {
          step_id: ctx.stepId,
          op_index: i,
          op_kind: op.kind,
          duration_ms: Date.now() - opStart,
        });
      }
    } catch (err) {
      if (!ctx.silent && (err as DOMException)?.name !== 'AbortError') {
        report('op_failed', {
          step_id: ctx.stepId,
          op_index: i,
          op_kind: op.kind,
          duration_ms: Date.now() - opStart,
          error: String(err),
        });
        // Console-visible breadcrumb so a dev with DevTools open can
        // see WHICH op of WHICH step blew up without parsing telemetry.
        // The catch in runStep above selectively logs based on error
        // kind — this is more reliable and pinpoints the failing op.
        // eslint-disable-next-line no-console
        console.error(
          `[onboarding] op failed: step=${ctx.stepId} op#${i}=${op.kind} ` +
            `duration=${Date.now() - opStart}ms`,
          { op, error: err },
        );
      }
      throw err;
    }
  }
}

async function runOp(op: ACOp, ctx: RunContext): Promise<void> {
  const { ac, store, signal, accentColor } = ctx;

  // Ops that physically move the cursor or change context implicitly
  // clear any active popup, sticky tracker, AND active highlight glow —
  // the previous instruction / pin / glow no longer applies once the
  // cursor is heading somewhere new. wait_user / delay / popup /
  // highlight_section / multi_choice keep all three visible (in
  // particular, wait_user keeps tracking so the cursor stays glued to
  // its target while we wait for the user's click).
  const clearsTransients =
    op.kind === 'move_to' ||
    op.kind === 'click' ||
    op.kind === 'type_into' ||
    op.kind === 'drag_select' ||
    op.kind === 'outro';
  if (clearsTransients) {
    // Hold the previous popup on screen for MIN_POPUP_DWELL_MS before
    // letting the next auto-transition clear it. Without this, a fast
    // sequence like `popup → delay 350 → move_to → click` would yank
    // the bubble before the user has a chance to read it. wait_user
    // gates aren't routed through here because they don't transition
    // until the user acts.
    await ensurePopupDwell(ctx);
    ac.hidePopup();
    ctx.popupShownAt.current = null;
    ac.stopTracking();
    if (ctx.highlightCleanup.current) {
      ctx.highlightCleanup.current();
      ctx.highlightCleanup.current = null;
    }
  }

  switch (op.kind) {
    case 'move_to': {
      // Pre-flight order matters: open the whole sidebar first (so
      // sub-section markers exist in DOM), THEN check the Customization
      // collapse, THEN target.
      //
      // Sidebar collapsed case ("AC freezes when user had sidebar
      // hidden") — without this guard, waitForSelector for any
      // sidebar-* target would hit its 2.5s lost-target timeout because
      // the entire panel is unrendered.
      const expandSidebarOps = maybeBuildExpandSidebarOps(op.target);
      if (expandSidebarOps) {
        await runOps(expandSidebarOps, ctx);
      }
      // Customization collapsed case ("asks me to click on it twice")
      // — without this guard, AC's popup pointed at an Actions/Skills/
      // Modes item that wasn't yet visible, the user would click
      // Customization to reveal it (which didn't satisfy the wait),
      // then click the item, looking like a duplicate prompt.
      const expandOps = maybeBuildExpandCustomizationOps(op.target);
      if (expandOps) {
        await runOps(expandOps, ctx);
      }
      const el = await waitForSelector(op.target);
      const scrolled = scrollIntoViewIfNeeded(el);
      // Cheaper rect-settle: instead of unconditionally sleeping 180ms
      // after every scroll AND a possible 200ms retry, read the rect
      // immediately and only wait if it actually looks bad. In the
      // happy path (target already in view, layout stable), this skips
      // both sleeps entirely.
      const offX = op.offset?.x ?? 0;
      const offY = op.offset?.y ?? 0;
      const TITLE_BAR_BOTTOM = 38;
      // "Truly broken" rect = zero size or pinned in title bar. NOT
      // "below viewport" — that just means a smooth-scroll is still in
      // progress. Treating below-viewport as degenerate caused step 2
      // to abort with the recovery message every time the YouTube row
      // was below the fold and AC had to scroll-then-pin.
      const isBroken = (rr: DOMRect, y: number): boolean =>
        y < TITLE_BAR_BOTTOM ||
        rr.width === 0 ||
        rr.height === 0;
      // Off-viewport but valid — element exists, scroll just hasn't
      // landed it yet. Worth waiting through, not an abort condition.
      const isOffViewport = (y: number): boolean =>
        y > window.innerHeight || y < 0;
      let r = el.getBoundingClientRect();
      let cx = r.left + r.width / 2 + offX;
      let cy = r.top + r.height / 2 + offY;
      // Active poll for scroll-settle. Smooth-scrolls take 250-500ms;
      // poll the rect every 60ms up to 1s. Bails the moment the element
      // is in viewport with a non-broken rect, so the happy path stays
      // fast (single poll, immediate exit).
      const SCROLL_SETTLE_MAX_MS = 1000;
      const POLL_MS = 60;
      const startedAt = performance.now();
      const needsSettle = scrolled || isBroken(r, cy) || isOffViewport(cy);
      if (needsSettle) {
        while (performance.now() - startedAt < SCROLL_SETTLE_MAX_MS) {
          await sleep(POLL_MS);
          r = el.getBoundingClientRect();
          cx = r.left + r.width / 2 + offX;
          cy = r.top + r.height / 2 + offY;
          if (!isBroken(r, cy) && !isOffViewport(cy)) break;
        }
      }
      // Only abort if the rect is BROKEN after the settle window —
      // off-viewport at this point means the scroll never landed,
      // which usually means the page hasn't fully rendered yet, but
      // pinning the cursor off-screen is harmless (user just sees
      // nothing land for a moment).
      if (isBroken(r, cy)) {
        throw new Error(`waitForSelector: "${op.target}" rect did not settle`);
      }
      // Rect-stability check: when the user clicks "+" to open the
      // dock chat, the chat input mounts then nudges into final
      // position over a couple frames as siblings render. If we read
      // the rect during that window and start the spring immediately,
      // the cursor lands on a stale-target location and then the
      // tracker has to drag it the remaining ~10-30px — visible as
      // a "jump" right after the spring lands. Polling the rect for
      // 2 stable consecutive frames (within 1.5px) guarantees we
      // start the spring against the FINAL position. Capped at 200ms
      // so we never block visibly. Most paths break out in 0-2 frames.
      const STABILITY_MAX_MS = 200;
      const STABILITY_THRESHOLD_PX = 1.5;
      const stabilityStart = performance.now();
      let prevCx = cx;
      let prevCy = cy;
      let stableFrames = 0;
      while (
        stableFrames < 2 &&
        performance.now() - stabilityStart < STABILITY_MAX_MS
      ) {
        await new Promise<void>((res) => requestAnimationFrame(() => res()));
        r = el.getBoundingClientRect();
        cx = r.left + r.width / 2 + offX;
        cy = r.top + r.height / 2 + offY;
        if (
          Math.abs(cx - prevCx) <= STABILITY_THRESHOLD_PX &&
          Math.abs(cy - prevCy) <= STABILITY_THRESHOLD_PX
        ) {
          stableFrames += 1;
        } else {
          stableFrames = 0;
        }
        prevCx = cx;
        prevCy = cy;
      }
      await ac.moveTo(cx, cy);
      // One-frame yield before handing transform control to the
      // sticky-tracker rAF. Without this, the tracker's first tick
      // can fire while Framer's spring is still settling the final
      // ~10px of the move, and the tracker's controls.set() cancels
      // the spring mid-overshoot — visible as the cursor "teleporting"
      // or disappearing into the destination. A single rAF lets the
      // spring resolve before the tracker starts re-pinning every
      // frame, which is when the cursor needs to start tracking
      // anyway.
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      ac.startTracking(op.target, op.offset);
      return;
    }
    case 'popup': {
      if (ctx.silent) return;
      // Replacing a popup-with-popup also has to honor the dwell floor,
      // otherwise back-to-back popups would flash by too fast to read.
      await ensurePopupDwell(ctx);
      ac.showPopup(op.text);
      ctx.popupShownAt.current = performance.now();
      return;
    }
    case 'multi_choice': {
      if (ctx.silent) return;
      // Multi-choice supersedes any showing popup. Same dwell floor.
      await ensurePopupDwell(ctx);
      ctx.popupShownAt.current = null;
      const id = await ac.showMultiChoice(op.question, op.options);
      if (id) {
        store.dispatch(
          recordMultiChoice({ stepId: ctx.stepId, opId: op.opId, answerId: id }),
        );
        report('multi_choice_answered', {
          step_id: ctx.stepId,
          op_id: op.opId,
          answer_id: id,
        });
      }
      const choice = op.options.find((o) => o.id === id);
      if (choice?.thenOps?.length) {
        await runOps(choice.thenOps, ctx);
      }
      return;
    }
    case 'highlight_section': {
      const el = await waitForSelector(op.target);
      // Replace any previous highlight first so we don't stack glows.
      if (ctx.highlightCleanup.current) {
        ctx.highlightCleanup.current();
        ctx.highlightCleanup.current = null;
      }
      const cleanup = spawnGlowRect(el, accentColor);
      ctx.highlightCleanup.current = cleanup;
      // Only show the popup if one was supplied — the runtime relies on
      // the next op (typically wait_user) to keep the glow visible while
      // the user reads. The glow is cleared by the next clearsTransients
      // op (move_to / click / type_into / drag_select / outro) or at
      // step-end in the runStep finally block.
      if (op.popup && !ctx.silent) {
        await ensurePopupDwell(ctx);
        ac.showPopup(op.popup);
        ctx.popupShownAt.current = performance.now();
      }
      // Optional minimum dwell so very-fast paths still register the
      // glow visually. Defaults to a short beat; explicit durationMs
      // overrides.
      await sleep(op.durationMs ?? 600);
      return;
    }
    case 'type_into': {
      // Resolve text up-front — string-or-function. Function form lets a
      // step pick its prompt at run-time based on current Redux state
      // (e.g. step 3's YouTube vs. web-research fallback).
      const resolvedText =
        typeof op.text === 'function' ? op.text(ctx.store.getState()) : op.text;
      const targetTrimmed = resolvedText.trim();

      const readText = (e: HTMLElement): string => {
        if (e.isContentEditable) return (e.textContent ?? '').trim();
        if (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement)
          return (e.value ?? '').trim();
        return (e.textContent ?? '').trim();
      };

      // Type-and-verify is wrapped in a retry loop because the App
      // Builder's chat input can be detached out from under us mid-
      // stream: the workspace's `runtime/start → stop → start` cycle +
      // ViewEditor's seed-then-navigate causes React to swap the
      // AgentChat instance the user can see, leaving the element our
      // `el` ref points at detached from the DOM. execCommand fires
      // silently into the dead node, no text lands, hasContent stays
      // false, and the send button never renders — which is what was
      // pushing the wizard into the recovery popup. On a verify-miss
      // we re-fetch the selector (which now resolves to the FRESH
      // AgentChat's input) and type again. Two attempts is the max —
      // a real "the input is genuinely broken" case shouldn't loop.
      const MAX_ATTEMPTS = 3;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const el = await waitForSelector(op.target);
        if (scrollIntoViewIfNeeded(el)) {
          await sleep(180);
        }
        const r = el.getBoundingClientRect();
        await ac.moveTo(
          Math.min(r.right - 14, r.left + r.width / 2),
          r.top + r.height / 2,
        );
        ac.startTracking(op.target, { x: 0, y: 0 });
        await typeInto(el, resolvedText, { speedMs: op.speedMs });

        // Let React's onInput commit land before verifying. 80 ms is
        // enough in the warm-path; we sleep longer between retries
        // because a remount window is what we're racing.
        await sleep(80);

        if (!targetTrimmed) return;
        // Re-fetch in case the original `el` was detached by a remount.
        // resolveSelector will return whatever the CURRENT canonical
        // chat-input is in the scope priority order.
        const currentEl = resolveSelector(op.target);
        const verifyEl = currentEl ?? el;
        const landed = readText(verifyEl);
        if (landed.length >= Math.floor(targetTrimmed.length * 0.8)) {
          // Success — text is in the live input.
          return;
        }

        if (attempt < MAX_ATTEMPTS) {
          // eslint-disable-next-line no-console
          console.warn(
            `[onboarding] type_into verify-miss for "${op.target}" attempt ${attempt}/${MAX_ATTEMPTS} — typed=${landed.length}/${targetTrimmed.length}, retrying`,
          );
          // Wait long enough for any in-flight remount + reconcile to
          // settle. 600 ms is longer than the ~500 ms stability window
          // wait_for_dom uses, so by the time we retry the DOM is in
          // its steady state.
          await sleep(600);
          continue;
        }

        // Final attempt — same single-shot re-insert the old anti-
        // revert guard used, against whatever element is current.
        if (verifyEl.isContentEditable) {
          verifyEl.focus();
          const range = document.createRange();
          range.selectNodeContents(verifyEl);
          const sel = window.getSelection();
          if (sel) {
            sel.removeAllRanges();
            sel.addRange(range);
          }
          try {
            document.execCommand('delete', false);
            const ok = document.execCommand('insertText', false, resolvedText);
            if (!ok) {
              verifyEl.textContent = resolvedText;
              verifyEl.dispatchEvent(new Event('input', { bubbles: true }));
            }
          } catch {
            verifyEl.textContent = resolvedText;
            verifyEl.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
        // One last verify after the fallback — if text STILL didn't land,
        // throw with a descriptive error so the wizard's catch block
        // shows a useful diagnostic instead of letting the next op
        // (move_to chatSendButton) burn 15 s on a button that will
        // never render because hasContent is false. The thrown message
        // appears in DevTools console via the op-failed breadcrumb.
        await sleep(120);
        const finalLanded = readText(resolveSelector(op.target) ?? verifyEl);
        if (finalLanded.length < Math.floor(targetTrimmed.length * 0.5)) {
          throw new Error(
            `type_into: text never landed in "${op.target}" after ` +
              `${MAX_ATTEMPTS} attempts (final length=${finalLanded.length}/${targetTrimmed.length}). ` +
              `The chat input was probably detached by an in-flight remount — ` +
              `check whether ViewEditor's seed-then-navigate is firing twice ` +
              `or whether AgentChat's session key is swapping mid-stream.`,
          );
        }
      }
      return;
    }
    case 'click': {
      const el = await waitForSelector(op.target);
      if (scrollIntoViewIfNeeded(el)) {
        await sleep(180);
      }
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      await ac.moveTo(x, y);
      await ac.pressClick();
      clickRipple(x, y, accentColor);
      if (op.simulate !== false) {
        // Disabled-button guard. If the resolved element (or any
        // ancestor IconButton/Button wrapper) is in a disabled state
        // when we go to fire the synthetic click, the click is a
        // no-op AND we silently move on — which is the "AC clicks
        // send and nothing happens" bug for step 6 (the contentEditable
        // chat input sometimes reverts AC's typed text under load,
        // leaving the send button disabled at click time). Detect it
        // and try a brief recovery: wait one frame and re-check, in
        // case the button just-now-enabled because state landed late.
        const isDisabled = (n: HTMLElement | null): boolean => {
          while (n) {
            if (n.hasAttribute('disabled')) return true;
            if (n.getAttribute('aria-disabled') === 'true') return true;
            n = n.parentElement;
          }
          return false;
        };
        if (isDisabled(el)) {
          await new Promise<void>((res) =>
            requestAnimationFrame(() => res()),
          );
          await sleep(120);
        }
        try {
          el.click();
        } catch {
          /* swallow — degrade to visual-only */
        }
      }
      // Do NOT start tracking after a click. Many click targets are
      // ephemeral — chat send buttons morph into stop buttons after
      // submit, modal triggers unmount when the modal opens, etc.
      // Tracking a disappearing element triggers lost-target → step
      // abort, which kills the step before outro runs and prevents
      // markStepCompleted from firing (the user is stuck on the same
      // step forever). The cursor's last-set position from moveTo holds
      // steady until the next op explicitly moves it.
      return;
    }
    case 'drag_select': {
      const el = await waitForSelector(op.target);
      if (scrollIntoViewIfNeeded(el)) {
        await sleep(180);
      }
      // Rect-stability poll. Without this, the dashed selection box is
      // drawn at coordinates read mid-animation — e.g. when step 6
      // clicks fit-to-view right before this op, the camera is still
      // panning and the target's viewport rect changes frame-to-frame.
      // Result: a box that's the wrong size or offset from the actual
      // card. Wait for 2 stable consecutive frames (within 1.5px) up
      // to 500ms before reading the final rect.
      let r = el.getBoundingClientRect();
      const stableStart = performance.now();
      let prevLeft = r.left;
      let prevTop = r.top;
      let stableFrames = 0;
      while (stableFrames < 2 && performance.now() - stableStart < 500) {
        await new Promise<void>((res) => requestAnimationFrame(() => res()));
        r = el.getBoundingClientRect();
        if (Math.abs(r.left - prevLeft) <= 1.5 && Math.abs(r.top - prevTop) <= 1.5) {
          stableFrames += 1;
        } else {
          stableFrames = 0;
        }
        prevLeft = r.left;
        prevTop = r.top;
      }
      const fromX = r.left - 12;
      const fromY = r.top - 12;
      const toX = r.right + 12;
      const toY = r.bottom + 12;
      await ac.moveTo(fromX, fromY);
      // Run the cursor and the dashed-rect animation in parallel, so the
      // cursor visually leads the selection from top-left to bottom-right
      // (matching how a real drag works) instead of stranding itself at
      // the start corner while the box draws itself across the target.
      // The cursor uses a 600ms tween with the same cubic-bezier the rect
      // uses (ACGestures.ts) so the two motions stay in lock-step. Spring
      // physics here would overshoot and desync from the CSS transition.
      const RECT_DURATION_MS = 600;
      await Promise.all([
        animateDragSelect(
          { fromX, fromY, toX, toY },
          accentColor,
          RECT_DURATION_MS,
        ),
        ac.moveTo(toX, toY, {
          duration: RECT_DURATION_MS / 1000,
          ease: [0.4, 0, 0.2, 1],
        }),
      ]);
      // No tracking after drag_select — the visual ends at a calculated
      // bottom-right corner, not the center of any element. Next op
      // (typically wait_user or move_to) takes over positioning.
      return;
    }
    case 'wait_user': {
      const first = await waitForCondition(
        op.condition,
        signal,
        store,
        op.timeoutMs,
      );
      // Retry-on-timeout for event_bus waits only: those fire on real
      // user actions (browser:spawned, skill:installed, chat:message_sent,
      // agent:attached_to_browser) — if the event never arrived the
      // step's actual goal didn't happen, so silently marking the step
      // done would let the user proceed against a half-broken state.
      // One retry with a "didn't seem to go through" popup gives the
      // user a clear chance to redo the action; if it times out a
      // second time, we soft-succeed (same as before) so the step
      // doesn't strand them forever.
      //
      // click_target + redux_predicate timeouts keep the original
      // soft-success policy: the user might legitimately have done
      // the underlying thing without our listener catching it.
      if (first.timedOut && op.condition.kind === 'event_bus') {
        report('wait_user_retry_prompted', {
          step_id: ctx.stepId,
          event: op.condition.event,
        });
        ac.showPopup("Didn't seem to go through. Try again?");
        ctx.popupShownAt.current = performance.now();
        await waitForCondition(
          op.condition,
          signal,
          store,
          op.timeoutMs,
        );
      }
      ac.hidePopup();
      // The user just did the thing — they don't need a dwell floor on
      // top of having engaged with the popup. Clearing popupShownAt
      // makes the next op's clearsTransients block a no-op for dwell,
      // so the cursor starts moving toward the next target the instant
      // the click registers. Without this, the cursor sat idle for up
      // to MIN_POPUP_DWELL_MS while the next op's click listener was
      // unregistered — so a quick follow-up click (e.g. clicking the
      // chat-input select-mode toggle right after opening the chat)
      // was being dropped on the floor, and the user saw "Show me"
      // reset because the wait never resolved.
      ctx.popupShownAt.current = null;
      // Quick layout-settle — one frame is enough in 95% of cases
      // (React commits on the next animation frame). The move_to
      // op also has its own settle if the rect comes out degenerate,
      // so this is just a cheap "let the click handler run" beat.
      await sleep(16);
      return;
    }
    case 'delay': {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(resolve, op.ms);
        const onAbort = () => {
          window.clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          reject(new DOMException('aborted', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort);
      });
      return;
    }
    case 'wait_for_dom': {
      const timeoutMs = op.timeoutMs ?? 8000;
      const POLL_MS = 100;
      // Stability gate: the matched element has to be the SAME node for
      // STABILITY_POLLS consecutive polls (≈ 500 ms continuous presence)
      // before we return success. Without this, step 8 was finding the
      // App Builder's chat-input on poll N, returning, then the next
      // op's typing ran straight into AgentChat's remount (the
      // `runtime/start → stop → start` cycle from a draftLaunchMap swap
      // + React Strict Mode double-effect) — the input became detached
      // mid-stream, execCommand('insertText') silently no-op'd into the
      // dead node, no text landed, hasContent stayed false, the send
      // button was never rendered, and the wizard's next move_to
      // chatSendButton burned its 15 s waitForSelector and threw into
      // the recovery popup. Requiring stable identity walls off the
      // remount window so we only proceed once the runtime has settled.
      const STABILITY_POLLS = 5;
      const startedAt = performance.now();
      let stableEl: Element | null = null;
      let stableCount = 0;
      while (performance.now() - startedAt < timeoutMs) {
        if (signal.aborted) {
          throw new DOMException('aborted', 'AbortError');
        }
        const hit = document.querySelector(op.css);
        if (hit) {
          if (hit === stableEl) {
            stableCount += 1;
            if (stableCount >= STABILITY_POLLS) return;
          } else {
            stableEl = hit;
            stableCount = 1;
          }
        } else {
          stableEl = null;
          stableCount = 0;
        }
        await sleep(POLL_MS);
      }
      // Hard error on timeout, with DOM-state diagnostics so the dev
      // console tells us WHY the selector didn't match — bare selector
      // mismatch vs. the marker being on the right element but the
      // wrong scope vs. nothing in DOM at all are three different bugs
      // and we couldn't tell which from "step failed".
      const scopeEls = Array.from(
        document.querySelectorAll('[data-onboarding-scope]'),
      ).map((e) => (e as HTMLElement).getAttribute('data-onboarding-scope'));
      const chatInputEls = Array.from(
        document.querySelectorAll('[data-onboarding="chat-input"]'),
      );
      const chatInputScopes = chatInputEls.map((el) => {
        let p: HTMLElement | null = el.parentElement;
        while (p) {
          const s = p.getAttribute('data-onboarding-scope');
          if (s) return s;
          p = p.parentElement;
        }
        return '<no-scope>';
      });
      const msg =
        `wait_for_dom: "${op.css}" did not appear within ${timeoutMs}ms ` +
        `[scopes=${JSON.stringify(scopeEls)}; chatInputs=${chatInputEls.length}; ` +
        `chatInputScopes=${JSON.stringify(chatInputScopes)}]`;
      console.error('[onboarding]', msg);
      throw new Error(msg);
    }
    case 'outro': {
      await ac.fadeOut(ctx.spawnPoint);
      return;
    }
  }
}

// Bring the target into view if any part of it is outside the viewport.
// Returns true if a scroll was actually triggered, false otherwise — the
// runtime uses this to decide whether to wait the smooth-scroll-settle
// beat. Scrolling-already-visible-element + 180ms wait would be pure
// added latency on every cursor move (~10s across the whole tour).
function scrollIntoViewIfNeeded(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const PAD = 24;
  const offTop = r.top < PAD;
  const offBottom = r.bottom > vh - PAD;
  const offLeft = r.left < PAD;
  const offRight = r.right > vw - PAD;
  if (!offTop && !offBottom && !offLeft && !offRight) return false;
  try {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  } catch {
    // Older webview / jsdom — fall back to instant scroll.
    try {
      el.scrollIntoView();
    } catch {
      /* nothing to do — tracker will still try to pin once visible */
    }
  }
  return true;
}

// True when the current URL is `#/dashboard/<id>` (a specific dashboard,
// where the toolbar with + / browser / etc. mounts). False on `#/`
// (dashboard list), `#/skills`, etc. HashRouter only — production app
// uses HashRouter so window.location.hash is the source of truth.
//
// Note: path is singular `/dashboard/`, not `/dashboards/` — that mismatch
// previously had the runtime thinking the user was always in a dashboard
// (since neither shape ever matched), which is why "Show me" from the
// Actions/Skills pages would barrel into a missing-+ button.
function isInDashboardRoute(): boolean {
  const h = window.location.hash || '';
  return /^#\/dashboard\/[^/?#]+/.test(h);
}

// Ops the runtime prepends when a step requires being inside a dashboard
// but the user isn't. State-aware: reads the live DOM to skip sub-steps
// the user has already satisfied, so we never force a click that would
// undo the desired state (e.g. clicking the Dashboards section header
// when it's already expanded — which would collapse it).
//
// The two sub-conditions:
//   1. Sidebar Dashboards section is expanded (so rows are visible).
//      Marked via data-expanded="true" / aria-expanded="true" on the
//      ListItemButton in AppShell.
//   2. The user has clicked into a dashboard (route #/dashboard/<id>).
//
// If (1) is already met, we skip the section-click. If (2) is met, we
// don't run any of these ops at all — the caller already gates on
// isInDashboardRoute().
function buildOpenDashboardOps(): ACOp[] {
  const sectionEl = document.querySelector<HTMLElement>(
    '[data-onboarding="sidebar-dashboards"]',
  );
  const sectionExpanded =
    sectionEl?.dataset.expanded === 'true' ||
    sectionEl?.getAttribute('aria-expanded') === 'true';

  const ops: ACOp[] = [];
  if (!sectionExpanded) {
    ops.push(
      { kind: 'move_to', target: 'sidebar-dashboards' },
      { kind: 'popup', text: 'Open the Dashboards list.' },
      {
        kind: 'wait_user',
        condition: { kind: 'click_target', target: 'sidebar-dashboards' },
        timeoutMs: 60000,
      },
    );
  }
  ops.push(
    { kind: 'move_to', target: 'dashboard-row-first' },
    { kind: 'popup', text: 'Click into a dashboard to continue.' },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: 'dashboard-row-first' },
      timeoutMs: 60000,
    },
  );
  return ops;
}

// Set of targets that live INSIDE the sidebar's Customization collapse.
// If a step's move_to points at one of these and the section is closed,
// the user can't see (or click) the target — they'd have to click
// Customization first to expand it. The runtime checks this before each
// move_to and, if needed, walks the user through the expand-click first.
// Same pattern as buildOpenDashboardOps: state-aware, no redundant clicks.
const CUSTOMIZATION_AREA_TARGETS = new Set<string>([
  'sidebar-actions',
  'sidebar-skills',
  'sidebar-modes',
]);

// Targets that live anywhere inside the sidebar (top-level nav rows,
// section headers, items revealed by an expanded section). If a step's
// move_to points at one of these and the WHOLE sidebar is collapsed
// (the AppShell ViewSidebar toggle hides the entire panel), the target
// element isn't in the DOM at all and waitForSelector would freeze the
// AC for a full 2.5s lost-target timeout before giving up.
//
// `sidebar-toggle` is deliberately excluded — it lives in the top bar
// and is the thing we click to expand. Recursing on it would loop.
const SIDEBAR_AREA_TARGETS = new Set<string>([
  'sidebar-settings-button',
  'sidebar-dashboards',
  'sidebar-customization',
  'sidebar-skills',
  'sidebar-actions',
  'sidebar-modes',
  'sidebar-apps',
  'dashboard-row-first',
]);

/**
 * If the requested target lives inside the sidebar panel and the panel
 * is currently collapsed (aria-expanded="false" on the top-bar
 * ViewSidebar toggle), return ops to walk the user through clicking the
 * toggle. Otherwise return null. Caller should runOps() the result
 * before its own move_to.
 *
 * This guard MUST run before maybeBuildExpandCustomizationOps because
 * the Customization header itself lives inside the collapsible panel —
 * checking for an expanded Customization on a hidden panel would always
 * read "not expanded" and queue an impossible click.
 */
function maybeBuildExpandSidebarOps(target: string): ACOp[] | null {
  if (!SIDEBAR_AREA_TARGETS.has(target)) return null;
  const toggle = document.querySelector<HTMLElement>(
    '[data-onboarding="sidebar-toggle"]',
  );
  // aria-expanded reflects !sidebarCollapsed (true = sidebar visible).
  // Missing / undefined means we couldn't find the toggle — assume
  // visible and let waitForSelector handle the (unlikely) real failure
  // so we don't gate on a missing marker.
  const expanded =
    toggle?.getAttribute('aria-expanded') === 'true' || toggle === null;
  if (expanded) return null;
  // Auto-expand: simulate-click the toggle. Previously we asked the
  // user to click it themselves, which fell over in two ways: (1) if
  // the AC's popup positioning glitched on collapsed-layout shift, the
  // user saw the cursor freeze with no obvious instruction, and (2) the
  // user shouldn't have to undo their own sidebar collapse to continue
  // onboarding anyway. simulate:true fires the React onClick on the
  // IconButton, the sidebar slides open, and the original move_to
  // continues against the now-mounted target.
  return [
    { kind: 'click', target: 'sidebar-toggle', simulate: true },
    // Sidebar slide-in is ~200ms; the small delay lets the slide
    // animation land before the next move_to reads rects.
    { kind: 'delay', ms: 260 },
  ];
}

/**
 * If the requested target lives inside the Customization collapse and the
 * section is currently closed, return ops to walk the user through
 * expanding it. Otherwise return null. Caller should runOps() the result
 * before its own move_to.
 */
function maybeBuildExpandCustomizationOps(target: string): ACOp[] | null {
  if (!CUSTOMIZATION_AREA_TARGETS.has(target)) return null;
  const header = document.querySelector<HTMLElement>(
    '[data-onboarding="sidebar-customization"]',
  );
  const expanded =
    header?.dataset.expanded === 'true' ||
    header?.getAttribute('aria-expanded') === 'true';
  if (expanded) return null;
  return [
    { kind: 'move_to', target: 'sidebar-customization' },
    { kind: 'popup', text: 'Open Customization.' },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: 'sidebar-customization' },
      timeoutMs: 60000,
    },
  ];
}

interface WaitResult {
  timedOut: boolean;
}

function waitForCondition(
  cond: AdvanceCondition,
  signal: AbortSignal,
  store: Store<RootState>,
  timeoutMs?: number,
): Promise<WaitResult> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('aborted', 'AbortError'));
  }

  return new Promise((resolve, reject) => {
    let cleanup: () => void = () => {};
    let timer: number | null = null;

    const finish = (timedOut: boolean) => {
      cleanup();
      if (timer !== null) window.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ timedOut });
    };

    const onAbort = () => {
      cleanup();
      if (timer !== null) window.clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort);

    if (timeoutMs && timeoutMs > 0) {
      timer = window.setTimeout(() => {
        // Surface the timeout to the caller so wait_user can decide
        // whether to soft-succeed (the previous policy) or prompt the
        // user to retry (the event_bus path — see wait_user handler).
        finish(true);
      }, timeoutMs);
    }

    switch (cond.kind) {
      case 'click_target': {
        const handler = (e: Event) => {
          const el = e.target as HTMLElement | null;
          if (
            el?.closest(
              `[data-onboarding="${cond.target}"], [data-select-type="${cond.target}"]`,
            )
          ) {
            finish(false);
          }
        };
        document.addEventListener('click', handler, true);
        cleanup = () => document.removeEventListener('click', handler, true);
        return;
      }
      case 'redux_predicate': {
        const check = () => {
          const value = cond.selector(store.getState());
          const ok =
            cond.equals !== undefined
              ? value === cond.equals
              : cond.truthy
                ? Boolean(value)
                : Boolean(value);
          if (ok) finish(false);
        };
        check();
        const unsub = store.subscribe(check);
        cleanup = unsub;
        return;
      }
      case 'event_bus': {
        const off = onboardingBus.once(cond.event as OnboardingEvent, () =>
          finish(false),
        );
        cleanup = off;
        return;
      }
    }
  });
}
