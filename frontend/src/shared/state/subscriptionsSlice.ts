import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/config';

export interface SubscriptionConnection {
  provider: string;
  isActive?: boolean;
  testStatus?: string;
  [key: string]: any;
}

export interface SubscriptionStatus {
  running: boolean;
  providers?:
    | { connections?: SubscriptionConnection[] }
    | SubscriptionConnection[];
  models?: any[];
  [key: string]: any;
}

export interface SubscriptionsState {
  status: SubscriptionStatus | null;
}

// Minimal slice-shape — used by selectors so the slice doesn't import
// from store.ts (would create a circular dependency with the configured
// store, even type-only).
type WithSubscriptions = { subscriptions: SubscriptionsState };

const initialState: SubscriptionsState = {
  status: null,
};

// Mirrors `GET /agents/subscriptions/status` into Redux so the onboarding
// gate (and any other consumer) can react to OAuth-driven subscription
// connections — the actual tokens live in 9Router-managed storage, not in
// settings.data, so this slice is the only frontend signal that an
// "external subscription" has been hooked up.
//
// `preserveTransient` keeps a previously-seen `running: true` state when a
// refresh comes back with `running: false`. The backend's `is_running()`
// probe has a short sync timeout that can be exceeded while 9Router is
// streaming inference, producing false negatives that would otherwise
// flip the Settings cards into a "Starting subscription service..."
// spinner mid-session.
export const fetchSubscriptionStatus = createAsyncThunk(
  'subscriptions/fetchStatus',
  async (opts: { preserveTransient?: boolean } | undefined, { getState }) => {
    const prev = (getState() as WithSubscriptions).subscriptions.status;
    try {
      const r = await fetch(`${API_BASE}/agents/subscriptions/status`);
      const data = (await r.json()) as SubscriptionStatus;
      if (opts?.preserveTransient && prev?.running && !data?.running) return prev;
      return data;
    } catch {
      return prev ?? ({ running: false, providers: [], models: [] } as SubscriptionStatus);
    }
  },
);

const subscriptionsSlice = createSlice({
  name: 'subscriptions',
  initialState,
  reducers: {
    setSubscriptionStatus(state, action: PayloadAction<SubscriptionStatus | null>) {
      state.status = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder.addCase(fetchSubscriptionStatus.fulfilled, (state, action) => {
      state.status = action.payload;
    });
  },
});

export const { setSubscriptionStatus } = subscriptionsSlice.actions;

// Pulls the connections array out of the polymorphic `providers` shape
// (`{ connections: [...] }` for the modern response, bare array for the
// legacy one). Returns [] for the loading state.
export function selectSubscriptionConnections(
  state: WithSubscriptions,
): SubscriptionConnection[] {
  const providers = state.subscriptions.status?.providers;
  if (!providers) return [];
  if (Array.isArray(providers)) return providers;
  return providers.connections ?? [];
}

export function isProviderConnected(
  state: WithSubscriptions,
  providerId: string,
): boolean {
  return selectSubscriptionConnections(state).some(
    (p) => p.provider === providerId && (p.isActive || p.testStatus === 'active'),
  );
}

export function hasAnyActiveSubscription(state: WithSubscriptions): boolean {
  return selectSubscriptionConnections(state).some(
    (p) => p.isActive || p.testStatus === 'active',
  );
}

export default subscriptionsSlice.reducer;
