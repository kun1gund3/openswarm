import React, { useEffect, useCallback, useRef, useState, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import DashboardHeader from './DashboardHeader';
import { report } from '@/shared/serviceClient';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { store } from '@/shared/state/store';
import {
  fetchSessions,
  fetchHistory,
  collapseSession,
  closeSession,
  duplicateSession,
  expandSession,
  launchAndSendFirstMessage,
  generateTitle,
  resumeSession,
  setExpandedSessionIds,
  toggleExpandSession,
} from '@/shared/state/agentsSlice';
import type { AgentConfig } from '@/shared/state/agentsSlice';
import {
  fetchLayout,
  saveLayout,
  reconcileSessions,
  tidyLayout,
  addViewCard,
  addBrowserCard,
  moveCards,
  resetLayout,
  setGlowingBrowserCards,
  removeViewCard,
  removeBrowserCard,
  pasteBrowserCard,
  placeCard,
  setCardPosition,
  removeCard,
  bringToFront,
  setGlowingAgentCard,
  clearGlowingAgentCard,
  clearPendingFocusBrowserId,
  addNote,
  removeNote,
  clearPendingFocusNoteId,
  DEFAULT_CARD_W,
  DEFAULT_CARD_H,
  EXPANDED_CARD_MIN_H,
  GRID_GAP,
} from '@/shared/state/dashboardLayoutSlice';
import { fetchOutputs } from '@/shared/state/outputsSlice';
import { generateDashboardName, updateDashboardThumbnail } from '@/shared/state/dashboardsSlice';
import { dashboardWs } from '@/shared/ws/WebSocketManager';
import { initBrowserCommandHandler } from '@/shared/browserCommandHandler';
import { clearPendingBrowserUrl, clearPendingFocusAgentId } from '@/shared/state/tempStateSlice';
import AgentCard from './AgentCard';
import DashboardViewCard from './DashboardViewCard';
import BrowserCard from './BrowserCard';
import NoteCard from './NoteCard';
import CanvasControls from './CanvasControls';
import CardSearchPalette from './CardSearchPalette';
import DirectionHints from './DirectionHints';
// OnboardingWalkthrough was retired in v2 , the new OnboardingRoot/Panel
// (mounted in Main.tsx) replaces it. Keeping this banner to prevent stale
// imports from sneaking back in via auto-completion.
import DashboardToolbar from './DashboardToolbar';
import { captureDashboardThumbnail } from './captureDashboardThumbnail';
import { useCanvasControls } from './useCanvasControls';
import { useDashboardSelection } from './useDashboardSelection';
import type { CardType } from './useDashboardSelection';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { ContextPath } from '@/app/components/DirectoryBrowser';
import { ElementSelectionProvider, useElementSelection } from '@/app/components/ElementSelectionContext';
import { useDomElementSelector } from '@/app/components/useDomElementSelector';
import SelectionOverlay from '@/app/components/SelectionOverlay';
import { setClipboardCards, getClipboardCards, type ClipboardCard } from '@/shared/dashboardClipboard';
import { API_BASE } from '@/shared/config';
import { useTethers } from './dashboardTethers';
import TetherLayer from './TetherLayer';
import { useArrowNav } from './useArrowNav';
import { useDashboardShortcuts } from './useDashboardShortcuts';
import { useDashboardClipboard } from './useDashboardClipboard';
import { useCardDrag } from './useCardDrag';
import { useSubAgentLifecycle } from './useSubAgentLifecycle';

const SELECT_ATTR = 'data-select-type';

const DashboardSelectionOverlay: React.FC = () => {
  const { overlay, dragRect, dragPreview } = useDomElementSelector();
  return <SelectionOverlay overlay={overlay} dragRect={dragRect} dragPreview={dragPreview} />;
};

function isCardTarget(target: EventTarget | null, boundary: EventTarget | null): boolean {
  let el = target as HTMLElement | null;
  while (el && el !== boundary) {
    if (el.hasAttribute(SELECT_ATTR)) return true;
    el = el.parentElement;
  }
  return false;
}

interface DashboardProps {
  dashboardId: string;
  isActive?: boolean;
}

const DashboardInner: React.FC<DashboardProps> = ({ dashboardId, isActive = true }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const elementSelectionCtx = useElementSelection();
  const isElementSelectMode = elementSelectionCtx?.selectMode ?? false;
  const dashboardName = useAppSelector((state) =>
    dashboardId ? state.dashboards.items[dashboardId]?.name : undefined,
  );
  const sessions = useAppSelector((state) => state.agents.sessions);
  const expandedSessionIds = useAppSelector((state) => state.agents.expandedSessionIds);
  const cards = useAppSelector((state) => state.dashboardLayout.cards);
  const viewCards = useAppSelector((state) => state.dashboardLayout.viewCards);
  const browserCards = useAppSelector((state) => state.dashboardLayout.browserCards);
  const notes = useAppSelector((state) => state.dashboardLayout.notes);
  const pendingFocusNoteId = useAppSelector((state) => state.dashboardLayout.pendingFocusNoteId);
  const layoutInitialized = useAppSelector((state) => state.dashboardLayout.initialized);
  const persistedExpandedSessionIds = useAppSelector((state) => state.dashboardLayout.persistedExpandedSessionIds);
  const zoomSensitivity = useAppSelector((state) => state.settings.data.zoom_sensitivity);
  const newAgentShortcut = useAppSelector((state) => state.settings.data.new_agent_shortcut);
  const browserHomepage = useAppSelector((state) => state.settings.data.browser_homepage);
  const expandNewChats = useAppSelector((state) => state.settings.data.expand_new_chats_in_dashboard);
  const autoRevealSubAgents = useAppSelector((state) => state.settings.data.auto_reveal_sub_agents);
  const outputs = useAppSelector((state) => state.outputs.items);
  const outputsLoaded = useAppSelector((state) => state.outputs.loaded);
  const glowingAgentCards = useAppSelector((state) => state.dashboardLayout.glowingAgentCards);
  const glowingBrowserCards = useAppSelector((state) => state.dashboardLayout.glowingBrowserCards);
  // sessions is the top-level dict; useMemo on its identity so sessionList
  // is stable when sessions hasn't actually changed (RTK only swaps the dict
  // ref when one of its values changes, so this is the right granularity).
  const sessionList = useMemo(() => Object.values(sessions), [sessions]);

  const contentBounds = useMemo(() => {
    const allRects = [
      ...Object.values(cards).map((c) => ({ x: c.x, y: c.y, w: c.width, h: c.height })),
      ...Object.values(viewCards).map((c) => ({ x: c.x, y: c.y, w: c.width, h: c.height })),
      ...Object.values(browserCards).map((c) => ({ x: c.x, y: c.y, w: c.width, h: c.height })),
    ];
    if (allRects.length === 0) return undefined;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of allRects) {
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w);
      maxY = Math.max(maxY, r.y + r.h);
    }
    return { minX, minY, maxX, maxY };
  }, [cards, viewCards, browserCards]);

  const canvas = useCanvasControls(zoomSensitivity, contentBounds, isActive);
  const selection = useDashboardSelection(
    { panX: canvas.panX, panY: canvas.panY, zoom: canvas.zoom, viewportRef: canvas.viewportRef },
    cards,
    viewCards,
    browserCards,
    notes,
  );
  const toolbarRef = useRef<HTMLDivElement>(null);

  const [toolbarOpen, setToolbarOpen] = useState(false);
  const [searchPaletteOpen, setSearchPaletteOpen] = useState(false);
  const [highlightedCardId, setHighlightedCardId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [autoFocusSessionId, setAutoFocusSessionId] = useState<string | null>(null);
  const [pendingSelectSessionId, setPendingSelectSessionId] = useState<string | null>(null);
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);
  const [newAgentBounce, setNewAgentBounce] = useState(false);
  // Cleanup any leftover walkthrough localStorage from v1 , the v2 panel
  // ignores it but it would otherwise hang around forever.
  useEffect(() => {
    try {
      localStorage.removeItem('openswarm_walkthrough_pending');
    } catch { /* ignore */ }
  }, []);

  const handleHighlightCard = useCallback((cardId: string) => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setHighlightedCardId(cardId);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightedCardId(null);
      highlightTimerRef.current = null;
    }, 2000);
  }, []);

  useEffect(() => {
    if (autoFocusSessionId) {
      const timer = setTimeout(() => setAutoFocusSessionId(null), 1500);
      return () => clearTimeout(timer);
    }
  }, [autoFocusSessionId]);

  useEffect(() => {
    if (!pendingSelectSessionId) return;
    if (!cards[pendingSelectSessionId]) return;
    setPendingSelectSessionId(null);
    selection.selectCard(pendingSelectSessionId, 'agent', false);
  }, [pendingSelectSessionId, cards, selection]);

  const spawnOriginsRef = useRef<Record<string, { x: number; y: number; type?: 'branch' }>>({});
  const measuredHeightsRef = useRef<Record<string, number>>({});
  const [measuredHeightsTick, setMeasuredHeightsTick] = useState(0);
  const handleMeasuredHeight = useCallback((sessionId: string, height: number) => {
    if (measuredHeightsRef.current[sessionId] !== height) {
      measuredHeightsRef.current[sessionId] = height;
      setMeasuredHeightsTick((t) => t + 1);
    }
  }, []);
  const revealSpawnedRef = useRef(new Set<string>());
  useEffect(() => {
    revealSpawnedRef.current.forEach((id) => {
      if (!cards[id]) revealSpawnedRef.current.delete(id);
    });
  }, [cards]);
  const hasFittedRef = useRef(false);
  const restoredExpandedRef = useRef(false);
  const canvasStateRef = useRef({ panX: canvas.panX, panY: canvas.panY, zoom: canvas.zoom });
  canvasStateRef.current = { panX: canvas.panX, panY: canvas.panY, zoom: canvas.zoom };
  // Stable getter , AgentCards read pan/zoom on demand during drag math.
  const getCanvasState = useCallback(() => canvasStateRef.current, []);

  const {
    multiDragDelta,
    liveDragInfo,
    handleCardDragStart,
    handleCardDragMove,
    handleCardDragEnd,
  } = useCardDrag({
    panX: canvas.panX,
    panY: canvas.panY,
    zoom: canvas.zoom,
    viewportRef: canvas.viewportRef,
    canvasActions: canvas.actions,
    selection,
  });

  // Helper: get a card's rect from Redux state (uses collapsed height for zoom calculation)
  const getCardRect = useCallback((id: string, type: CardType) => {
    const layoutState = store.getState().dashboardLayout;
    if (type === 'agent') {
      const card = layoutState.cards[id];
      if (!card) return undefined;
      return { x: card.x, y: card.y, width: card.width, height: card.height };
    } else if (type === 'view') {
      const vc = layoutState.viewCards[id];
      if (!vc) return undefined;
      return { x: vc.x, y: vc.y, width: vc.width, height: vc.height };
    } else if (type === 'browser') {
      const bc = layoutState.browserCards[id];
      if (!bc) return undefined;
      return { x: bc.x, y: bc.y, width: bc.width, height: bc.height };
    } else if (type === 'note') {
      const n = layoutState.notes[id];
      if (!n) return undefined;
      return { x: n.x, y: n.y, width: n.width, height: n.height };
    }
    return undefined;
  }, []);

  // Delay single-click collapse so double-click can override
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCardSelect = useCallback((id: string, type: CardType, shiftKey: boolean) => {
    report('dashboard', 'card_clicked', { card_type: type, shift: shiftKey });
    if (shiftKey) {
      selection.selectCard(id, type, true);
      return;
    }

    selection.selectCard(id, type, false);
    dispatch(bringToFront({ id, type }));

    const alreadyExpanded = type === 'agent' && expandedSessionIds.includes(id);

    if (alreadyExpanded) {
      // Delay single-click collapse so double-click can override.
      // Double-click handler (handleCardDoubleClick) clears clickTimerRef.
      clickTimerRef.current = setTimeout(() => {
        clickTimerRef.current = null;
        dispatch(collapseSession(id));
      }, 250);
      return;
    }

    // Expand (if not already) + center + zoom + bring to front
    if (type === 'agent') {
      dispatch(expandSession(id));
    }
    setFocusedCardId(id);
    setTimeout(() => {
      const rect = getCardRect(id, type);
      if (rect) canvas.actions.fitToCards([rect], 1.15, true, type === 'browser' ? 0.8 : undefined);
      setTimeout(() => (document.activeElement as HTMLElement)?.blur?.(), 150);
    }, 100);
  }, [selection, getCardRect, canvas.actions, dispatch, expandedSessionIds]);

  const handleBringToFront = useCallback((id: string, type: CardType) => {
    dispatch(bringToFront({ id, type }));
  }, [dispatch]);

  // ---- Viewport event handlers (compose pan + marquee) ----
  const handleViewportMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1) {
      canvas.handlers.onMouseDown(e);
      return;
    }

    if (e.button === 2) {
      e.preventDefault();
      canvas.handlers.onMouseDown(e);
      return;
    }

    if (e.button !== 0) return;
    if (isCardTarget(e.target, e.currentTarget)) return;

    // Canvas click , drop any lingering input focus so arrow-key nav
    // works immediately without the user having to press Escape first.
    const active = document.activeElement as HTMLElement | null;
    const activeTag = active?.tagName;
    if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || (active as any)?.isContentEditable) {
      active?.blur?.();
    }

    if (isElementSelectMode) {
      if (e.metaKey || e.ctrlKey) {
        canvas.handlers.onMouseDown(e);
      }
      return;
    }

    if (e.metaKey || e.ctrlKey || canvas.spaceHeld) {
      selection.deselectAll();
      canvas.handlers.onMouseDown(e);
    } else {
      selection.handleCanvasMouseDown(e.nativeEvent);
    }
  }, [canvas.handlers, canvas.spaceHeld, selection, isElementSelectMode]);

  const handleViewportMouseMove = useCallback((e: React.MouseEvent) => {
    canvas.handlers.onMouseMove(e);
    selection.handleCanvasMouseMove(e.nativeEvent);
  }, [canvas.handlers, selection]);

  const handleViewportMouseUp = useCallback((e: React.MouseEvent) => {
    canvas.handlers.onMouseUp();
    selection.handleCanvasMouseUp(e.nativeEvent);
  }, [canvas.handlers, selection]);

  // Double-click empty canvas → fit all cards
  const handleViewportDoubleClick = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (isCardTarget(e.target, e.currentTarget)) return;
    report('dashboard', 'canvas_double_clicked');
    canvas.actions.fitToView();
  }, [canvas.actions]);

  // Double-click a card → always expand + center + zoom (cancels pending collapse from single-click)
  const handleCardDoubleClick = useCallback((id: string, type: CardType) => {
    report('dashboard', 'card_double_clicked', { card_type: type });
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    if (type === 'agent') {
      dispatch(expandSession(id));
    }
    dispatch(bringToFront({ id, type }));
    setFocusedCardId(id);
    setTimeout(() => {
      const rect = getCardRect(id, type);
      if (rect) canvas.actions.fitToCards([rect], 1.15, true);
      setTimeout(() => (document.activeElement as HTMLElement)?.blur?.(), 150);
    }, 100);
  }, [getCardRect, canvas.actions, dispatch]);

  // Track dashboard engagement time
  useEffect(() => {
    if (!dashboardId) return;
    const startTime = Date.now();
    report('dashboard', 'opened', { dashboard_id: dashboardId });
    return () => {
      report('dashboard', 'closed', {
        dashboard_id: dashboardId,
        time_spent_seconds: Math.round((Date.now() - startTime) / 1000),
      });
    };
  }, [dashboardId]);

  useEffect(() => {
    if (!dashboardId) return;
    hasFittedRef.current = false;
    restoredExpandedRef.current = false;
    dispatch(resetLayout());
    // CRITICAL path: these populate the cards the user expects to see
    // on first paint. Don't defer.
    dispatch(fetchSessions({ dashboardId }));
    dispatch(fetchLayout(dashboardId));
    const cleanupBrowserHandler = initBrowserCommandHandler();
    // DEFERRABLE: history list (for the search palette) and outputs
    // (for the apps panel) aren't on the first-paint path. Same for the
    // dashboard WS connection (it carries cross-session events; opens
    // ~100ms later costs nothing). Pushing these into the post-paint
    // window measurably improves LCP because the initial render
    // pipeline isn't competing with their thunks/network setup.
    const idleHandle = (typeof window !== 'undefined' && (window as any).requestIdleCallback)
      ? (window as any).requestIdleCallback(() => {
          dispatch(fetchHistory({ dashboardId }));
          dispatch(fetchOutputs());
          dashboardWs.connect();
        }, { timeout: 2000 })
      : window.setTimeout(() => {
          dispatch(fetchHistory({ dashboardId }));
          dispatch(fetchOutputs());
          dashboardWs.connect();
        }, 200);

    // Pre-warm Anthropic's prompt cache for sessions on this dashboard
    // ~250ms after mount (debounced; AbortController cancels on
    // dashboard switch). Fires a max_tokens=1 ping per session so the
    // user's first real message hits a warm cache instead of paying
    // cold-start TTFT. Cheap (~$0.0001/session) and non-blocking. Skips
    // for non-Anthropic sessions server-side.
    const warmAbort = new AbortController();
    const warmTimer = setTimeout(async () => {
      try {
        const sessionsState = store.getState().agents.sessions;
        const dashSessions = Object.values(sessionsState).filter(
          (s) => s.dashboard_id === dashboardId &&
                 s.status !== 'draft' &&
                 s.mode !== 'browser-agent' &&
                 s.mode !== 'sub-agent' &&
                 s.mode !== 'invoked-agent',
        );
        for (const s of dashSessions) {
          if (warmAbort.signal.aborted) break;
          // Fire-and-forget , the endpoint always 200s and the side
          // effect is invisible cache population.
          fetch(`${API_BASE}/agents/sessions/${s.id}/warm-cache`, {
            method: 'POST',
            signal: warmAbort.signal,
          }).catch(() => {});
        }
      } catch {
        /* best-effort */
      }
    }, 250);

    return () => {
      clearTimeout(warmTimer);
      warmAbort.abort();
      cleanupBrowserHandler();
      dashboardWs.disconnect();
      // Cancel any not-yet-fired idle work; the cleanup handler can't
      // run partially if the dashboard switches before idle fired.
      if (typeof window !== 'undefined') {
        const cancelIdle = (window as any).cancelIdleCallback;
        if (cancelIdle && typeof idleHandle === 'number') cancelIdle(idleHandle);
        else if (typeof idleHandle === 'number') clearTimeout(idleHandle);
      }
    };
  }, [dispatch, dashboardId]);

  const pendingBrowserUrl = useAppSelector((state) => state.tempState.pendingBrowserUrl);
  const pendingFocusAgentId = useAppSelector((state) => state.tempState.pendingFocusAgentId);
  const pendingFocusBrowserId = useAppSelector((state) => state.dashboardLayout.pendingFocusBrowserId);

  useEffect(() => {
    if (!dashboardId) return;
    (window as any).__openswarm_last_dashboard_id = dashboardId;
  }, [dashboardId]);

  useEffect(() => {
    if (!pendingBrowserUrl || !layoutInitialized) return;
    dispatch(addBrowserCard({ url: pendingBrowserUrl, expandedSessionIds }));
    dispatch(clearPendingBrowserUrl());
  }, [pendingBrowserUrl, layoutInitialized, dispatch, expandedSessionIds]);

  // Capture a thumbnail screenshot of the dashboard.
  // Uses Electron's native capturePage for pixel-perfect results.
  // Captures current viewport as-is (no DOM mutation) to avoid visual flashes.
  // Re-captures when layout is saved (piggybacking on the save debounce).
  const pendingThumbnailRef = useRef<string | null>(null);
  const captureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captureNow = useCallback(() => {
    const viewportEl = canvas.viewportRef.current;
    const contentEl = canvas.contentRef.current;
    if (!viewportEl || !contentEl) return;
    const layoutState = store.getState().dashboardLayout;
    const allCards = {
      cards: layoutState.cards,
      viewCards: layoutState.viewCards,
      browserCards: layoutState.browserCards,
    };
    const hasCards = Object.keys(allCards.cards).length > 0
      || Object.keys(allCards.viewCards).length > 0
      || Object.keys(allCards.browserCards).length > 0;
    if (!hasCards) {
      // Empty dashboard , queue a thumbnail clear (sent on exit alongside
      // the existing capture-update path). Backend treats '' as "set to
      // empty"; null in PUT body means "don't update".
      pendingThumbnailRef.current = '';
      return;
    }
    captureDashboardThumbnail(viewportEl, contentEl, allCards)
      .then((thumbnail) => { if (thumbnail) pendingThumbnailRef.current = thumbnail; })
      .catch(() => {});
  }, [canvas.viewportRef, canvas.contentRef]);

  useEffect(() => {
    if (!isActive) return;  // Skip thumbnail capture when dashboard is hidden
    if (!dashboardId || !layoutInitialized) return;
    if (captureTimerRef.current) clearTimeout(captureTimerRef.current);
    captureTimerRef.current = setTimeout(captureNow, 2000);
    return () => { if (captureTimerRef.current) clearTimeout(captureTimerRef.current); };
  }, [isActive, dashboardId, layoutInitialized, captureNow]);

  // On exit, save the captured thumbnail to the backend
  useEffect(() => {
    if (!dashboardId) return;
    const exitingId = dashboardId;
    return () => {
      const thumbnail = pendingThumbnailRef.current;
      // null = no pending change; '' = pending clear; other = pending update.
      if (thumbnail !== null) {
        store.dispatch(updateDashboardThumbnail({ id: exitingId, thumbnail }));
        pendingThumbnailRef.current = null;
      }
    };
  }, [dashboardId]);

  useEffect(() => {
    if (!isActive) return;  // Don't auto-fit while dashboard is hidden
    if (!layoutInitialized || hasFittedRef.current) return;
    if (pendingFocusAgentId) return;
    hasFittedRef.current = true;
    const timer = setTimeout(() => canvas.actions.fitToView(), 150);
    return () => clearTimeout(timer);
  }, [isActive, layoutInitialized, canvas.actions, pendingFocusAgentId]);

  useEffect(() => {
    if (!isActive) return;  // Defer focus animation until dashboard is visible
    if (!pendingFocusAgentId || !layoutInitialized) return;
    const agentId = pendingFocusAgentId;
    dispatch(clearPendingFocusAgentId());
    hasFittedRef.current = true;
    setTimeout(() => {
      const card = store.getState().dashboardLayout.cards[agentId];
      if (card) {
        canvas.actions.fitToCards([{ x: card.x, y: card.y, width: card.width, height: card.height }], 1.15, true);
        handleHighlightCard(agentId);
      }
    }, 350);
  }, [isActive, pendingFocusAgentId, layoutInitialized, dispatch, canvas.actions, handleHighlightCard]);

  // Auto-focus a newly created browser card. The reducer that handles
  // addBrowserCard sets pendingFocusBrowserId to the new card's id; this
  // effect picks it up, pans/zooms the canvas to center on it, briefly
  // highlights it, then clears the signal. Mirrors the pendingFocusAgentId
  // pattern above so link clicks (intercepted in AppShell) get the same
  // auto-focus behavior as the "+ Browser" toolbar button.
  //
  // Uses zoom=0.8 (the same value handleCardClick uses for browser cards
  // at line ~344) instead of letting fitToCards auto-derive a zoom from
  // padding. Browser cards are large (1280x800), so the auto-derived zoom
  // would land around ~58% which feels too far back; 0.8 matches the
  // "click on a browser to focus" experience the user expects.
  useEffect(() => {
    if (!isActive) return;
    if (!pendingFocusBrowserId || !layoutInitialized) return;
    const browserId = pendingFocusBrowserId;
    dispatch(clearPendingFocusBrowserId());
    hasFittedRef.current = true;
    setTimeout(() => {
      const card = store.getState().dashboardLayout.browserCards[browserId];
      if (card) {
        canvas.actions.fitToCards(
          [{ x: card.x, y: card.y, width: card.width, height: card.height }],
          1.15,
          true,
          0.8,
        );
        handleHighlightCard(browserId);
      }
    }, 200);
  }, [isActive, pendingFocusBrowserId, layoutInitialized, dispatch, canvas.actions, handleHighlightCard]);

  useEffect(() => {
    if (!layoutInitialized || restoredExpandedRef.current) return;
    restoredExpandedRef.current = true;
    dispatch(setExpandedSessionIds(persistedExpandedSessionIds));
  }, [layoutInitialized, persistedExpandedSessionIds, dispatch]);

  const prevSessionIdsRef = useRef<string>('');

  useEffect(() => {
    if (!layoutInitialized) return;
    const dashboardSessionIds = Object.values(sessions)
      .filter((s) => s.dashboard_id === dashboardId && s.mode !== 'browser-agent' && s.mode !== 'invoked-agent' && s.mode !== 'sub-agent')
      .map((s) => s.id);
    const liveIds = dashboardSessionIds.sort().join(',');
    if (liveIds === prevSessionIdsRef.current) return;
    prevSessionIdsRef.current = liveIds;
    dispatch(reconcileSessions({ sessionIds: dashboardSessionIds, expandedSessionIds }));
  }, [sessions, layoutInitialized, dispatch, dashboardId, expandedSessionIds]);

  // Prune orphan view cards whose underlying output was deleted (e.g. via
  // the Views page). Without this, the layout entry persists in the
  // minimap and contentBounds even though DashboardViewCard renders
  // nothing. Gated on outputsLoaded so we don't wipe valid cards during
  // the brief window between fetchLayout returning and outputs finishing.
  useEffect(() => {
    if (!layoutInitialized || !outputsLoaded) return;
    for (const outputId of Object.keys(viewCards)) {
      if (!outputs[outputId]) dispatch(removeViewCard(outputId));
    }
  }, [layoutInitialized, outputsLoaded, viewCards, outputs, dispatch]);

  // ---- Auto-reveal / collapse / unreveal sub-agent cards ----
  useSubAgentLifecycle({
    isActive,
    sessions,
    cards,
    layoutInitialized,
    autoRevealSubAgents,
    expandedSessionIds,
  });

  const skipInitialSave = useRef(true);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<Parameters<typeof saveLayout>[0] | null>(null);

  useEffect(() => {
    if (!isActive) return;  // Don't persist layout while dashboard is hidden , save buffers in pendingSaveRef and flushes on resume
    if (!layoutInitialized || !dashboardId) return;
    if (skipInitialSave.current) {
      skipInitialSave.current = false;
      return;
    }
    const payload = { dashboardId, cards, viewCards, browserCards, notes, expandedSessionIds };
    pendingSaveRef.current = payload;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      dispatch(saveLayout(payload));
      pendingSaveRef.current = null;
      saveTimerRef.current = null;
      captureNow();
    }, 500);
  }, [isActive, cards, viewCards, browserCards, notes, expandedSessionIds, layoutInitialized, dashboardId, dispatch, captureNow]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (pendingSaveRef.current) {
        dispatch(saveLayout(pendingSaveRef.current));
        pendingSaveRef.current = null;
      }
    };
  }, [dispatch]);

  useDashboardShortcuts({
    isActive,
    newAgentShortcut,
    selection,
    setToolbarOpen,
    setSearchPaletteOpen,
  });

  useDashboardClipboard({
    isActive,
    dashboardId,
    selection,
    sessions,
    cards,
    viewCards,
    browserCards,
    outputs,
    expandedSessionIds,
  });

  // ---- Arrow key card navigation (when zoomed in on a card) ----
  const { neighborDirections, shakeDirection } = useArrowNav({
    cards,
    viewCards,
    browserCards,
    zoom: canvas.zoom,
    isActive,
    focusedCardId,
    setFocusedCardId,
    canvasActions: canvas.actions,
    getCardRect,
  });

  const handleBranchFromCard = useCallback(
    (sourceSessionId: string, newSessionId: string) => {
      const sourceCard = cards[sourceSessionId];
      if (!sourceCard) return;

      const targetX = sourceCard.x + sourceCard.width + GRID_GAP * 12;
      let targetY = sourceCard.y;

      const columnCards = Object.values(cards).filter(
        (c) => Math.abs(c.x - targetX) < 50 && c.session_id !== newSessionId,
      );
      if (columnCards.length > 0) {
        const lowestBottom = Math.max(
          ...columnCards.map((c) => c.y + Math.max(EXPANDED_CARD_MIN_H, c.height)),
        );
        targetY = lowestBottom + GRID_GAP;
      }

      spawnOriginsRef.current[newSessionId] = {
        x: sourceCard.x,
        y: sourceCard.y,
        type: 'branch' as const,
      };

      dispatch(placeCard({
        sessionId: newSessionId,
        x: targetX,
        y: targetY,
        width: DEFAULT_CARD_W,
        height: DEFAULT_CARD_H,
        expandedSessionIds,
      }));

      if (expandedSessionIds.includes(sourceSessionId)) {
        dispatch(expandSession(newSessionId));
      }

      dispatch(setGlowingAgentCard({ sessionId: newSessionId, sourceId: sourceSessionId, label: 'Branch' }));
    },
    [cards, dispatch, expandedSessionIds],
  );

  const handleNewAgent = useCallback(() => {
    setToolbarOpen(true);
  }, []);

  const handleToolbarCancel = useCallback(() => {
    setToolbarOpen(false);
  }, []);

  const handleToolbarSend = useCallback(
    (
      prompt: string,
      mode: string,
      model: string,
      images?: Array<{ data: string; media_type: string }>,
      contextPaths?: ContextPath[],
      forcedTools?: string[],
      attachedSkills?: Array<{ id: string; name: string; content: string }>,
      selectedBrowserIds?: string[],
    ) => {
      setToolbarOpen(false);
      report('dashboard', 'agent_created', { mode, model, has_images: !!images?.length, has_context: !!contextPaths?.length, has_browser: !!selectedBrowserIds?.length });

      const draftId = `draft-${Date.now().toString(36)}`;

      const toolbarEl = toolbarRef.current;
      const vpEl = canvas.viewportRef.current;
      if (toolbarEl && vpEl) {
        const tr = toolbarEl.getBoundingClientRect();
        const vr = vpEl.getBoundingClientRect();
        const toolbarCenterX = tr.left + tr.width / 2;
        const toolbarTopY = tr.top;
        const { panX, panY, zoom } = canvasStateRef.current;
        spawnOriginsRef.current[draftId] = {
          x: (toolbarCenterX - vr.left - panX) / zoom,
          y: (toolbarTopY - vr.top - panY) / zoom,
        };
      }

      const config: AgentConfig = { name: 'New chat', model, mode, dashboard_id: dashboardId };

      dispatch(
        launchAndSendFirstMessage({
          draftId,
          config,
          prompt,
          mode,
          model,
          images,
          contextPaths: contextPaths?.map((cp) => ({ path: cp.path, type: cp.type })),
          forcedTools,
          attachedSkills,
          expand: expandNewChats,
        }),
      ).then((action) => {
        if (launchAndSendFirstMessage.fulfilled.match(action)) {
          const realId = action.payload.session.id;
          dispatch(generateTitle({ sessionId: realId, prompt }));
          if (selectedBrowserIds?.length) {
            dispatch(setGlowingBrowserCards({ browserIds: selectedBrowserIds, sessionId: realId, label: 'Use Browser' }));

            if (selectedBrowserIds.length === 1) {
              const bc = store.getState().dashboardLayout.browserCards[selectedBrowserIds[0]];
              if (bc) {
                // Use placeCard (collision-aware) instead of
                // setCardPosition (blind setter). The "left of the
                // browser" anchor is the IDEAL spot , but if it's
                // already taken by an existing chat (e.g. step 3's
                // YouTube agent that's still on canvas when step 5
                // creates a new chat for the same browser), placeCard
                // cascades to the nearest free cell instead of
                // stacking on top.
                dispatch(placeCard({
                  sessionId: realId,
                  x: bc.x - DEFAULT_CARD_W - GRID_GAP * 12,
                  y: bc.y,
                  width: DEFAULT_CARD_W,
                  height: DEFAULT_CARD_H,
                  expandedSessionIds,
                }));
              }
            }
          }
          spawnOriginsRef.current[realId] = spawnOriginsRef.current[draftId];
          delete spawnOriginsRef.current[draftId];

          if (expandNewChats) {
            setAutoFocusSessionId(realId);
            dispatch(expandSession(realId));
          } else {
            setPendingSelectSessionId(realId);
          }

          setTimeout(() => {
            const card = store.getState().dashboardLayout.cards[realId];
            if (card) {
              canvas.actions.fitToCards([{ x: card.x, y: card.y, width: card.width, height: card.height }], 1.15, true);
              handleHighlightCard(realId);
            }
          }, 200);

          if (dashboardId) {
            const currentSessions = store.getState().agents.sessions;
            const agentCount = Object.values(currentSessions).filter(
              (s) => s.status !== 'draft' && s.dashboard_id === dashboardId,
            ).length;
            const NAME_GEN_TRIGGERS = [1, 3, 6];
            const currentDash = store.getState().dashboards.items[dashboardId];
            const canAutoName =
              currentDash &&
              (currentDash.auto_named || currentDash.name === 'Untitled Dashboard');

            if (NAME_GEN_TRIGGERS.includes(agentCount) && canAutoName) {
              dispatch(generateDashboardName(dashboardId));
            }
          }
        } else {
          delete spawnOriginsRef.current[draftId];
        }
      });
    },
    [canvas.viewportRef, canvas.actions, dispatch, dashboardId, expandNewChats, handleHighlightCard],
  );

  const handleAddView = useCallback((outputId: string) => {
    dispatch(addViewCard({ outputId, expandedSessionIds }));
    setTimeout(() => {
      const card = store.getState().dashboardLayout.viewCards[outputId];
      if (card) {
        canvas.actions.fitToCards([{ x: card.x, y: card.y, width: card.width, height: card.height }], 1.15, true);
        handleHighlightCard(outputId);
      }
    }, 200);
  }, [dispatch, expandedSessionIds, canvas.actions, handleHighlightCard]);

  const handleAddBrowser = useCallback(() => {
    report('dashboard', 'browser_added');
    const prevIds = new Set(Object.keys(store.getState().dashboardLayout.browserCards));
    dispatch(addBrowserCard({ url: browserHomepage, expandedSessionIds }));
    setTimeout(() => {
      const allBrowserCards = store.getState().dashboardLayout.browserCards;
      const newId = Object.keys(allBrowserCards).find((id) => !prevIds.has(id));
      if (newId) {
        const card = allBrowserCards[newId];
        canvas.actions.fitToCards([{ x: card.x, y: card.y, width: card.width, height: card.height }], 1.15, true);
        handleHighlightCard(newId);
      }
    }, 200);
  }, [dispatch, browserHomepage, expandedSessionIds, canvas.actions, handleHighlightCard]);

  const handleAddNote = useCallback(() => {
    report('dashboard', 'note_added');
    const prevIds = new Set(Object.keys(store.getState().dashboardLayout.notes));
    dispatch(addNote({ expandedSessionIds }));
    setTimeout(() => {
      const allNotes = store.getState().dashboardLayout.notes;
      const newId = Object.keys(allNotes).find((id) => !prevIds.has(id));
      if (newId) {
        const note = allNotes[newId];
        canvas.actions.fitToCards([{ x: note.x, y: note.y, width: note.width, height: note.height }], 1.15, true);
        handleHighlightCard(newId);
      }
    }, 200);
  }, [dispatch, expandedSessionIds, canvas.actions, handleHighlightCard]);

  // Auto-clear pendingFocusNoteId after the note has had a chance to mount + autofocus.
  useEffect(() => {
    if (!pendingFocusNoteId) return;
    const t = setTimeout(() => dispatch(clearPendingFocusNoteId()), 800);
    return () => clearTimeout(t);
  }, [pendingFocusNoteId, dispatch]);

  const handleHistoryResume = useCallback((sessionId: string) => {
    dispatch(resumeSession({ sessionId })).then((action) => {
      if (resumeSession.fulfilled.match(action)) {
        dispatch(expandSession(sessionId));
        setAutoFocusSessionId(sessionId);
        setTimeout(() => {
          const card = store.getState().dashboardLayout.cards[sessionId];
          if (card) {
            canvas.actions.fitToCards([{ x: card.x, y: card.y, width: card.width, height: card.height }], 1.15, true);
            handleHighlightCard(sessionId);
          }
        }, 200);
      }
    });
  }, [dispatch, canvas.actions, handleHighlightCard, setAutoFocusSessionId]);

  // Context-aware fit: if a card is selected, zoom to it; otherwise fit all
  const handleFitToView = useCallback(() => {
    report('dashboard', 'fit_to_view', { has_selection: selection.selectedIds.size > 0 });
    if (selection.selectedIds.size === 1) {
      const [[id, type]] = selection.selectedIds;
      const rect = getCardRect(id, type);
      if (rect) {
        canvas.actions.fitToCards([rect], 1.15, true);
        return;
      }
    }
    canvas.actions.fitToView();
  }, [selection.selectedIds, getCardRect, canvas.actions]);

  const handleTidy = useCallback(() => {
    report('dashboard', 'tidy_layout');
    const currentExpanded = store.getState().agents.expandedSessionIds;
    dispatch(tidyLayout({ expandedSessionIds: currentExpanded }));

    const expandedSet = new Set(currentExpanded);
    const { cards: tidied, viewCards: tidiedViews, browserCards: tidiedBrowsers } = store.getState().dashboardLayout;
    const allRects = [
      ...Object.values(tidied).map((c) => ({
        x: c.x, y: c.y, width: c.width,
        height: expandedSet.has(c.session_id) ? Math.max(EXPANDED_CARD_MIN_H, c.height) : c.height,
      })),
      ...Object.values(tidiedViews).map((c) => ({ x: c.x, y: c.y, width: c.width, height: c.height })),
      ...Object.values(tidiedBrowsers).map((c) => ({ x: c.x, y: c.y, width: c.width, height: c.height })),
    ];
    canvas.actions.fitToCards(allRects);
  }, [dispatch, canvas.actions]);

  useEffect(() => {
    if (!isActive) return;  // Heavy geometry recalculation , pause when dashboard is hidden
    const DRIFT_THRESHOLD = 60;

    // Group tethered sub-agent cards by source, only including those still in the spawn column
    const sourceToSiblings = new Map<string, string[]>();
    for (const [id, glow] of Object.entries(glowingAgentCards)) {
      const card = cards[id];
      if (!card) continue;
      const sourceCard = cards[glow.sourceId];
      if (!sourceCard) continue;
      const expectedX = sourceCard.x + sourceCard.width + GRID_GAP * 12;
      if (Math.abs(card.x - expectedX) > DRIFT_THRESHOLD) continue;
      const list = sourceToSiblings.get(glow.sourceId) ?? [];
      list.push(id);
      sourceToSiblings.set(glow.sourceId, list);
    }

    for (const siblings of sourceToSiblings.values()) {
      if (siblings.length < 2) continue;
      siblings.sort((a, b) => cards[a].y - cards[b].y);

      let cursor = cards[siblings[0]].y;
      for (const id of siblings) {
        const card = cards[id];
        const dy = cursor - card.y;
        if (Math.abs(dy) > 1) {
          dispatch(moveCards({ items: [{ id, type: 'agent' as const }], dx: 0, dy }));
        }
        const isExpanded = expandedSessionIds.includes(id);
        const h = isExpanded
          ? Math.max(EXPANDED_CARD_MIN_H, card.height)
          : (measuredHeightsRef.current[id] ?? card.height);
        cursor += h + GRID_GAP * 2;
      }
    }
  // measuredHeightsTick in deps ensures we re-run once ResizeObserver reports
  // the new height after a collapse (avoids stale-height no-ops)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, expandedSessionIds, glowingAgentCards, cards, dispatch, measuredHeightsTick]);

  useEffect(() => {
    if (!isActive) return;  // Heavy geometry recalculation , pause when dashboard is hidden
    const DRIFT_THRESHOLD = 60;

    const sourceToSiblings = new Map<string, string[]>();
    for (const [browserId, glow] of Object.entries(glowingBrowserCards)) {
      const bc = browserCards[browserId];
      if (!bc) continue;
      const sourceCard = cards[glow.sourceId];
      if (!sourceCard) continue;
      const expectedX = sourceCard.x + sourceCard.width + GRID_GAP * 12;
      if (Math.abs(bc.x - expectedX) > DRIFT_THRESHOLD) continue;
      const list = sourceToSiblings.get(glow.sourceId) ?? [];
      list.push(browserId);
      sourceToSiblings.set(glow.sourceId, list);
    }

    for (const siblings of sourceToSiblings.values()) {
      if (siblings.length < 2) continue;
      siblings.sort((a, b) => browserCards[a].y - browserCards[b].y);

      let cursor = browserCards[siblings[0]].y;
      for (const id of siblings) {
        const bc = browserCards[id];
        const dy = cursor - bc.y;
        if (Math.abs(dy) > 1) {
          dispatch(moveCards({ items: [{ id, type: 'browser' as const }], dx: 0, dy }));
        }
        cursor += bc.height + GRID_GAP * 2;
      }
    }
  }, [isActive, glowingBrowserCards, browserCards, cards, dispatch]);

  const tethers = useTethers({
    glowingAgentCards,
    glowingBrowserCards,
    cards,
    browserCards,
    expandedSessionIds,
    liveDragInfo,
    measuredHeightsRef,
    measuredHeightsTick,
    sessionList,
  });

  const dotSize = Math.max(1, 1.5 * canvas.zoom);
  const dotSpacing = 24 * canvas.zoom;

  return (
    <>
    <DashboardSelectionOverlay />
    <Box sx={{ position: 'relative', height: '100%', overflow: 'hidden' }}>
      {/* Floating header overlay */}
      <Box
        sx={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 10,
          pointerEvents: 'none',
          // p: 3 (24px) was leaving a chunky air gap between the sidebar
          // edge and the dashboard header that read as "two disconnected
          // panels" rather than one continuous surface. 0.75 (6px)
          // tightens the inset so the header floats just inside the
          // content area without losing its breathing room from the
          // top-most pixel.
          p: 0.75,
          pb: 0,
          background: `linear-gradient(to bottom, ${c.bg.page} 60%, transparent)`,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', pointerEvents: 'auto' }}>
          <DashboardHeader
            dashboardName={dashboardName}
            sessions={sessions}
            cards={cards}
            viewCards={viewCards}
            browserCards={browserCards}
            outputs={outputs}
            dashboardId={dashboardId}
            canvasActions={canvas.actions}
            onHighlightCard={handleHighlightCard}
          />
        </Box>
      </Box>

      {/* Canvas viewport */}
      <Box
        ref={canvas.viewportRef}
        onMouseDown={handleViewportMouseDown}
        onMouseMove={handleViewportMouseMove}
        onMouseUp={handleViewportMouseUp}
        onDoubleClick={handleViewportDoubleClick}
        sx={{
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          cursor: canvas.isPanning
            ? 'grabbing'
            : (canvas.spaceHeld || canvas.cmdHeld)
              ? 'grab'
              : selection.marquee
                ? 'crosshair'
                : 'default',
        }}
      >
        {/* Dot grid background */}
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            backgroundImage: `radial-gradient(circle, ${c.border.medium} ${dotSize}px, transparent ${dotSize}px)`,
            backgroundSize: `${dotSpacing}px ${dotSpacing}px`,
            backgroundPosition: `${canvas.panX % dotSpacing}px ${canvas.panY % dotSpacing}px`,
          }}
        />

        {sessionList.length === 0 && Object.keys(viewCards).length === 0 && Object.keys(browserCards).length === 0 ? (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
            }}
          >
            <style>{`@keyframes empty-state-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
            <Typography sx={{ color: c.text.tertiary, fontSize: '1.1rem', mb: 1 }}>
              No agents running
            </Typography>
            <Typography
              sx={{
                fontSize: '0.9rem',
                background: `linear-gradient(90deg, ${c.text.ghost} 0%, ${c.text.ghost} 40%, ${c.text.primary} 50%, ${c.text.ghost} 60%, ${c.text.ghost} 100%)`,
                backgroundSize: '200% 100%',
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                color: 'transparent',
                animation: 'empty-state-shimmer 6s linear infinite',
              }}
            >
              Click the &quot;+&quot; button below to launch your first agent
            </Typography>
          </Box>
        ) : (
          <div
            ref={canvas.contentRef}
            style={{
              transform: `translate(${canvas.panX}px, ${canvas.panY}px) scale(${canvas.zoom})`,
              transformOrigin: '0 0',
              willChange: 'transform',
              position: 'relative',
            }}
          >
            {/* Tether lines between branched cards */}
            <TetherLayer tethers={tethers} c={c} />
            <AnimatePresence>
            {Object.values(cards).map((card) => {
              const sid = card.session_id;

              let origin = spawnOriginsRef.current[sid];
              if (origin) {
                delete spawnOriginsRef.current[sid];
              } else {
                const glow = glowingAgentCards[sid];
                if (glow && !revealSpawnedRef.current.has(sid)) {
                  revealSpawnedRef.current.add(sid);
                  const srcCard = cards[glow.sourceId];
                  if (srcCard) {
                    const srcH = measuredHeightsRef.current[glow.sourceId]
                      ?? (expandedSessionIds.includes(glow.sourceId)
                        ? Math.max(EXPANDED_CARD_MIN_H, srcCard.height)
                        : srcCard.height);
                    origin = {
                      x: srcCard.x + srcCard.width,
                      y: srcCard.y + srcH / 2,
                      type: 'branch' as const,
                    };
                  }
                }
              }

              let exitTarget: { x: number; y: number } | undefined;
              const glow = glowingAgentCards[sid];
              if (glow) {
                const srcCard = cards[glow.sourceId];
                if (srcCard) {
                  const srcH = measuredHeightsRef.current[glow.sourceId]
                    ?? (expandedSessionIds.includes(glow.sourceId)
                      ? Math.max(EXPANDED_CARD_MIN_H, srcCard.height)
                      : srcCard.height);
                  exitTarget = {
                    x: srcCard.x + srcCard.width,
                    y: srcCard.y + srcH / 2,
                  };
                }
              }

              let snapColumn: { x: number; width: number } | undefined;
              if (glow) {
                const srcCard = cards[glow.sourceId];
                if (srcCard) {
                  snapColumn = {
                    x: srcCard.x + srcCard.width + GRID_GAP * 12,
                    width: DEFAULT_CARD_W,
                  };
                }
              }

              const isSel = selection.isSelected(sid);
              return (
                <AgentCard
                  key={sid}
                  sessionId={sid}
                  expanded={expandedSessionIds.includes(sid)}
                  getCanvasState={getCanvasState}
                  spawnFrom={origin}
                  exitTarget={exitTarget}
                  isSelected={isSel}
                  isHighlighted={highlightedCardId === sid}
                  // Only selected cards need the live drag delta; passing
                  // it to everyone broke memo equality for unselected
                  // cards on every mouse-move during multi-drag.
                  multiDragDelta={isSel ? multiDragDelta : null}
                  onCardSelect={handleCardSelect}
                  onDragStart={handleCardDragStart}
                  onDragMove={handleCardDragMove}
                  onDragEnd={handleCardDragEnd}
                  onBranch={handleBranchFromCard}
                  onMeasuredHeight={handleMeasuredHeight}
                  snapColumn={snapColumn}
                  autoFocusInput={autoFocusSessionId === sid}
                  onDoubleClick={handleCardDoubleClick}
                  onBringToFront={handleBringToFront}
                  shakeDirection={focusedCardId === sid ? shakeDirection : null}
                />
              );
            })}
            </AnimatePresence>
            {Object.values(viewCards).map((vc) => {
              const output = outputs[vc.output_id];
              if (!output) return null;
              return (
                <DashboardViewCard
                  key={`view-${vc.output_id}`}
                  output={output}
                  cardX={vc.x}
                  cardY={vc.y}
                  cardWidth={vc.width}
                  cardHeight={vc.height}
                  cardZOrder={vc.zOrder ?? 0}
                  zoom={canvas.zoom}
                  panX={canvas.panX}
                  panY={canvas.panY}
                  cmdHeld={canvas.cmdHeld}
                  isSelected={selection.isSelected(vc.output_id)}
                  isHighlighted={highlightedCardId === vc.output_id}
                  multiDragDelta={multiDragDelta}
                  onCardSelect={handleCardSelect}
                  onDragStart={handleCardDragStart}
                  onDragMove={handleCardDragMove}
                  onDragEnd={handleCardDragEnd}
                  onDoubleClick={handleCardDoubleClick}
                  onBringToFront={handleBringToFront}
                />
              );
            })}
            {Object.values(browserCards).map((bc) => (
              <BrowserCard
                key={`browser-${bc.browser_id}`}
                browserId={bc.browser_id}
                tabs={bc.tabs}
                activeTabId={bc.activeTabId}
                cardX={bc.x}
                cardY={bc.y}
                cardWidth={bc.width}
                cardHeight={bc.height}
                cardZOrder={bc.zOrder ?? 0}
                zoom={canvas.zoom}
                panX={canvas.panX}
                panY={canvas.panY}
                cmdHeld={canvas.cmdHeld}
                isSelected={selection.isSelected(bc.browser_id)}
                isHighlighted={highlightedCardId === bc.browser_id}
                multiDragDelta={multiDragDelta}
                onCardSelect={handleCardSelect}
                onDragStart={handleCardDragStart}
                onDragMove={handleCardDragMove}
                onDragEnd={handleCardDragEnd}
                onDoubleClick={handleCardDoubleClick}
                onBringToFront={handleBringToFront}
              />
            ))}
            {Object.values(notes).map((n) => (
              <NoteCard
                key={`note-${n.note_id}`}
                noteId={n.note_id}
                cardX={n.x}
                cardY={n.y}
                cardWidth={n.width}
                cardHeight={n.height}
                cardZOrder={n.zOrder ?? 0}
                zoom={canvas.zoom}
                panX={canvas.panX}
                panY={canvas.panY}
                cmdHeld={canvas.cmdHeld}
                content={n.content}
                color={n.color}
                isSelected={selection.isSelected(n.note_id)}
                isHighlighted={highlightedCardId === n.note_id}
                multiDragDelta={multiDragDelta}
                autoFocus={pendingFocusNoteId === n.note_id}
                onCardSelect={handleCardSelect}
                onDragStart={handleCardDragStart}
                onDragMove={handleCardDragMove}
                onDragEnd={handleCardDragEnd}
                onBringToFront={handleBringToFront}
              />
            ))}
            {/* Marquee selection rectangle */}
            {selection.marquee && (
              <div
                style={{
                  position: 'absolute',
                  left: selection.marquee.x,
                  top: selection.marquee.y,
                  width: selection.marquee.width,
                  height: selection.marquee.height,
                  border: '1.5px dashed rgba(59, 130, 246, 0.6)',
                  background: 'rgba(59, 130, 246, 0.08)',
                  borderRadius: 2,
                  pointerEvents: 'none',
                  zIndex: 9999,
                }}
              />
            )}
          </div>
        )}
      </Box>

      {/* Floating bottom toolbar */}
      <Box sx={{ position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 10 }}>
        <DashboardToolbar
          ref={toolbarRef}
          inputOpen={toolbarOpen}
          onNewAgent={handleNewAgent}
          onCancel={handleToolbarCancel}
          onSend={handleToolbarSend}
          onAddView={handleAddView}
          onHistoryResume={handleHistoryResume}
          onAddBrowser={handleAddBrowser}
          onAddNote={handleAddNote}
          dashboardId={dashboardId}
          newAgentBounce={newAgentBounce}
          onNewAgentBounceEnd={() => setNewAgentBounce(false)}
        />
      </Box>

      {/* Arrow navigation hints when zoomed in on a card */}
      {focusedCardId && canvas.zoom >= 0.4 && (
        <DirectionHints
          hasLeft={neighborDirections.left}
          hasRight={neighborDirections.right}
          hasUp={neighborDirections.up}
          hasDown={neighborDirections.down}
          shakeDirection={shakeDirection}
        />
      )}

      {/* Floating zoom controls + minimap */}
      <Box sx={{ position: 'absolute', bottom: 16, right: 16, zIndex: 10 }}>
        <CanvasControls
          zoom={canvas.zoom}
          actions={canvas.actions}
          onFitToView={handleFitToView}
          onTidy={handleTidy}
          minimapProps={{
            panX: canvas.panX,
            panY: canvas.panY,
            zoom: canvas.zoom,
            viewportRef: canvas.viewportRef,
            cards,
            viewCards,
            browserCards,
          }}
          onMinimapPan={(px, py) => canvas.actions.setState({ panX: px, panY: py, zoom: canvas.zoom })}
        />
      </Box>
    </Box>

    {/* Card search palette (Cmd+F) */}
    <CardSearchPalette
      open={searchPaletteOpen}
      onClose={() => setSearchPaletteOpen(false)}
      onNavigate={(rect) => canvas.actions.fitToCards([rect], 1.15, true)}
      cards={cards}
      viewCards={viewCards}
      browserCards={browserCards}
      sessions={sessions}
    />

    </>
  );
};

const Dashboard: React.FC<DashboardProps> = ({ dashboardId, isActive = true }) => (
  <ElementSelectionProvider>
    <DashboardInner dashboardId={dashboardId} isActive={isActive} />
  </ElementSelectionProvider>
);

export default Dashboard;
