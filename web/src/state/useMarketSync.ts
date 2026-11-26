import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api/client';
import { DeepMarketSSE, sseSemanticKey } from '../api/sse';
import type { SSEConnection } from '../api/sse';
import type {
  EquipmentInstance,
  FishingStartResponse,
  FishingStateResponse,
  FishingStopResponse,
  FXQuote,
  GuildInventoryResponse,
  LotteryClaimResponse,
  LotteryCraftResponse,
  LotteryStatusResponse,
  LotteryTicket,
  MarketResource,
  MarketWallet,
  PublicPlayer,
  PublicScratchCard,
  PublicUser,
  SSEEnvelope,
} from '../api/types';

export interface MarketSyncSession {
  token: string;
  user: PublicUser;
  player?: PublicPlayer;
}

export interface MarketSyncResult {
  wallet: MarketWallet;
  fishing: FishingStateResponse | null;
  inventory: GuildInventoryResponse | null;
  quotes: FXQuote[];
  candleRevision: number;
  lottery: LotteryStatusResponse | null;
  cards: PublicScratchCard[];
  events: SSEEnvelope[];
  globalLegendary: SSEEnvelope<'catch'> | null;
  lastCatchEvent: SSEEnvelope<'catch' | 'escape'> | null;
  connection: SSEConnection;
  lastEnvelope: SSEEnvelope | null;
  syncError: string | null;
  refresh: (targets?: MarketResource[]) => Promise<void>;
  acceptFishingCommand: (res: FishingStartResponse | FishingStopResponse) => void;
  acceptPlayer: (
    player: PublicPlayer,
    extra?: { rod?: EquipmentInstance; autoRepairLevel?: number },
  ) => void;
  acceptLotteryClaim: (res: LotteryClaimResponse) => void;
  acceptLotteryCraft: (res: LotteryCraftResponse) => void;
  acceptScratchCard: (card: PublicScratchCard, player?: PublicPlayer) => void;
}

const ALL_RESOURCES: readonly MarketResource[] = [
  'fishing',
  'inventory',
  'quotes',
  'lottery',
  'scratch',
];

function initialWallet(player?: PublicPlayer): MarketWallet {
  return {
    coins: player?.coins ?? 0,
    blackCoins: player?.black_coins ?? 0,
    blankTickets: 0,
    invRev: player?.inv_rev ?? 0,
    version: player?.version ?? 0,
  };
}

function mergeCards(current: PublicScratchCard[], updates: PublicScratchCard[]): PublicScratchCard[] {
  const cards = new Map(current.map((card) => [card.id, card]));
  for (const card of updates) {
    const existing = cards.get(card.id);
    if (card.revealed || !existing?.revealed) {
      cards.set(card.id, card);
    }
  }
  return [...cards.values()].sort((a, b) => b.id - a.id);
}

function isNewerEnvelope(candidate: SSEEnvelope, current: SSEEnvelope | null): boolean {
  if (!current) return true;
  if (candidate.ts_ms !== current.ts_ms) return candidate.ts_ms > current.ts_ms;
  return candidate.seq > current.seq;
}

function recordBounded(set: Set<string>, key: string, limit = 512) {
  set.add(key);
  if (set.size > limit) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
}

export function useMarketSync(session: MarketSyncSession | null): MarketSyncResult {
  const token = session?.token ?? null;
  const userId = session?.user.id ?? null;
  const sessionPlayer = session?.player;

  const [wallet, setWallet] = useState<MarketWallet>(() => initialWallet(sessionPlayer));
  const [fishing, setFishing] = useState<FishingStateResponse | null>(null);
  const [inventory, setInventory] = useState<GuildInventoryResponse | null>(null);
  const [quotes, setQuotes] = useState<FXQuote[]>([]);
  const [candleRevision, setCandleRevision] = useState(0);
  const [lottery, setLottery] = useState<LotteryStatusResponse | null>(null);
  const [cards, setCards] = useState<PublicScratchCard[]>([]);
  const [events, setEvents] = useState<SSEEnvelope[]>([]);
  const [globalLegendary, setGlobalLegendary] = useState<SSEEnvelope<'catch'> | null>(null);
  const [lastCatchEvent, setLastCatchEvent] = useState<SSEEnvelope<'catch' | 'escape'> | null>(null);
  const [connection, setConnection] = useState<SSEConnection>(token ? 'connecting' : 'closed');
  const [lastEnvelope, setLastEnvelope] = useState<SSEEnvelope | null>(null);
  const [failed, setFailed] = useState<Partial<Record<MarketResource, string>>>({});

  const refreshRef = useRef<(targets?: MarketResource[]) => Promise<void>>(() => Promise.resolve());
  const runningRef = useRef(false);

  const acceptWallet = useCallback(
    (partial: {
      coins?: number;
      blackCoins?: number;
      blankTickets?: number;
      invRev?: number;
      version: number;
    }) => {
      setWallet((current) => {
        if (partial.version < current.version) return current;
        return {
          coins: partial.coins ?? current.coins,
          blackCoins: partial.blackCoins ?? current.blackCoins,
          blankTickets: partial.blankTickets ?? current.blankTickets,
          invRev:
            partial.invRev !== undefined
              ? Math.max(current.invRev, partial.invRev)
              : current.invRev,
          version: partial.version,
        };
      });
    },
    [],
  );

  useEffect(() => {
    runningRef.current = fishing?.running ?? false;
  }, [fishing?.running]);

  useEffect(() => {
    if (!token || userId === null) {
      setWallet(initialWallet(undefined));
      setFishing(null);
      setInventory(null);
      setQuotes([]);
      setCandleRevision(0);
      setLottery(null);
      setCards([]);
      setEvents([]);
      setGlobalLegendary(null);
      setLastCatchEvent(null);
      setConnection('closed');
      setLastEnvelope(null);
      setFailed({});
      refreshRef.current = () => Promise.resolve();
      return;
    }

    setWallet(initialWallet(sessionPlayer));
    setFishing(null);
    setInventory(null);
    setQuotes([]);
    setCandleRevision(0);
    setLottery(null);
    setCards([]);
    setEvents([]);
    setGlobalLegendary(null);
    setLastCatchEvent(null);
    setConnection('connecting');
    setLastEnvelope(null);
    setFailed({});

    const controller = new AbortController();
    const { signal } = controller;
    const stream = new DeepMarketSSE(token, userId);
    const pending = new Set<MarketResource>();
    const inFlight = new Set<MarketResource>();
    const completedGen: Record<MarketResource, number> = {
      fishing: 0,
      inventory: 0,
      quotes: 0,
      lottery: 0,
      scratch: 0,
    };
    const waiters = new Set<{ targets: Map<MarketResource, number>; resolve: () => void }>();
    const seenEventIds = new Set<string>();
    const seenCatchKeys = new Set<string>();
    let timer: number | undefined;

    function resolveSettledWaiters() {
      for (const waiter of waiters) {
        let settled = true;
        for (const [target, neededGen] of waiter.targets) {
          if (completedGen[target] < neededGen) {
            settled = false;
            break;
          }
        }
        if (settled) {
          waiters.delete(waiter);
          waiter.resolve();
        }
      }
    }

    const load: Record<MarketResource, () => Promise<void>> = {
      fishing: async () => {
        const data = await api.fishingState(token, signal);
        if (signal.aborted) return;
        setFishing((previous) =>
          previous && data.player_version < previous.player_version ? previous : data,
        );
        acceptWallet({
          coins: data.coins,
          invRev: data.inv_rev,
          version: data.player_version,
        });
      },
      inventory: async () => {
        const data = await api.inventory(token, signal);
        if (signal.aborted) return;
        setInventory((previous) =>
          previous && data.player.version < previous.player.version ? previous : data,
        );
        acceptWallet({
          coins: data.player.coins,
          blackCoins: data.player.black_coins,
          blankTickets: data.blank_tickets,
          invRev: data.player.inv_rev,
          version: data.player.version,
        });
      },
      quotes: async () => {
        const data = await api.fxQuotes(token, signal);
        if (signal.aborted) return;
        setQuotes(data.quotes);
        setCandleRevision((revision) => revision + 1);
      },
      lottery: async () => {
        const data = await api.lotteryStatus(token, signal);
        if (signal.aborted) return;
        setLottery(data);
        setWallet((current) => ({ ...current, blankTickets: data.blank_tickets }));
      },
      scratch: async () => {
        const data = await api.scratchCards(token, signal);
        if (signal.aborted) return;
        setCards((current) => mergeCards(current, data.cards ?? []));
      },
    };

    function flush() {
      timer = undefined;
      for (const resource of Array.from(pending)) {
        if (inFlight.has(resource)) continue;
        pending.delete(resource);
        inFlight.add(resource);
        void load[resource]()
          .then(() => {
            if (signal.aborted) return;
            setFailed((errors) => {
              if (!errors[resource]) return errors;
              const next = { ...errors };
              delete next[resource];
              return next;
            });
          })
          .catch((error: unknown) => {
            if (!signal.aborted) {
              setFailed((errors) => ({ ...errors, [resource]: errorMessage(error) }));
            }
          })
          .finally(() => {
            inFlight.delete(resource);
            completedGen[resource] += 1;
            if (pending.has(resource) && !signal.aborted) {
              if (timer === undefined) timer = window.setTimeout(flush, 90);
            }
            resolveSettledWaiters();
          });
      }
      resolveSettledWaiters();
    }

    function schedule(targets?: MarketResource[]): Promise<void> {
      if (signal.aborted) return Promise.resolve();
      const list = targets && targets.length > 0 ? targets : ALL_RESOURCES;
      const needed = new Map<MarketResource, number>();
      for (const target of list) {
        pending.add(target);
        needed.set(target, completedGen[target] + (inFlight.has(target) ? 2 : 1));
      }
      const promise = new Promise<void>((resolve) => {
        waiters.add({ targets: needed, resolve });
      });
      if (timer === undefined) timer = window.setTimeout(flush, 90);
      return promise;
    }

    refreshRef.current = schedule;

    const unsubscribeEvent = stream.subscribe((envelope) => {
      setLastEnvelope(stream.lastEnvelope ?? envelope);
      const { event, channel } = envelope;

      switch (event) {
        case 'fishing_started':
        case 'fishing_stopped':
        case 'auto_repair':
          if (channel === 'user') void schedule(['fishing', 'inventory']);
          break;

        case 'escape':
          if (channel === 'user') {
            const semKey = sseSemanticKey(envelope);
            if (!seenEventIds.has(envelope.id) && !seenCatchKeys.has(semKey)) {
              recordBounded(seenEventIds, envelope.id);
              recordBounded(seenCatchKeys, semKey);
              setEvents((current) => [envelope, ...current].slice(0, 100));
              setLastCatchEvent((current) =>
                isNewerEnvelope(envelope, current) ? envelope : current,
              );
            }
            void schedule(['fishing', 'inventory']);
          }
          break;

        case 'catch':
          if (channel === 'user') {
            const semKey = sseSemanticKey(envelope);
            if (!seenEventIds.has(envelope.id) && !seenCatchKeys.has(semKey)) {
              recordBounded(seenEventIds, envelope.id);
              recordBounded(seenCatchKeys, semKey);
              setEvents((current) => [envelope, ...current].slice(0, 100));
              setLastCatchEvent((current) =>
                isNewerEnvelope(envelope, current) ? envelope : current,
              );
            }
            void schedule(['fishing', 'inventory', 'quotes']);
          } else if (channel === 'global') {
            if (envelope.payload.tier === 'legendary') {
              setGlobalLegendary((current) =>
                isNewerEnvelope(envelope, current) ? envelope : current,
              );
            }
            if (envelope.user_id !== userId) {
              void schedule(['quotes']);
            }
          }
          break;

        case 'fx_tick':
          void schedule(['quotes']);
          break;

        case 'lottery_drawn':
          void schedule(['lottery']);
          break;

        case 'scratch_revealed':
          if (channel === 'user') {
            setCards((current) => mergeCards(current, [envelope.payload.card]));
            void schedule(['scratch', 'inventory', 'fishing']);
          }
          break;
      }
    });

    const unsubscribeConnection = stream.subscribeConnection((state) => {
      setConnection(state);
      if (state === 'connected') void schedule();
    });

    const refreshVisible = () => {
      if (!document.hidden) void schedule();
    };

    const fishingTimer = window.setInterval(() => {
      if (!document.hidden && runningRef.current) void schedule(['fishing']);
    }, 1400);

    const snapshotTimer = window.setInterval(refreshVisible, 30_000);
    document.addEventListener('visibilitychange', refreshVisible);
    void schedule();

    if (typeof EventSource !== 'undefined') stream.connect();
    else setConnection('closed');

    return () => {
      refreshRef.current = () => Promise.resolve();
      controller.abort();
      unsubscribeEvent();
      unsubscribeConnection();
      stream.close();
      window.clearTimeout(timer);
      window.clearInterval(fishingTimer);
      window.clearInterval(snapshotTimer);
      document.removeEventListener('visibilitychange', refreshVisible);
      for (const waiter of waiters) waiter.resolve();
      waiters.clear();
    };
  }, [acceptWallet, sessionPlayer, token, userId]);

  const refresh = useCallback((targets?: MarketResource[]) => {
    return refreshRef.current(targets);
  }, []);

  const acceptFishingCommand = useCallback(
    (res: FishingStartResponse | FishingStopResponse) => {
      acceptWallet({
        invRev: res.inv_rev,
        version: res.player_version,
      });
      setFishing((current) => {
        if (!current || res.player_version < current.player_version) return current;
        const depthId = 'depth_id' in res ? res.depth_id : current.depth_id;
        return {
          ...current,
          ...res,
          depth_id: depthId,
          rod: res.rod ?? current.rod,
          fishing: {
            ...current.fishing,
            running: res.running,
            selected_depth_id: depthId,
            phase: 'charging',
            progress: 0,
            tension: 0,
            bite: null,
          },
        };
      });
      void refreshRef.current(['fishing', 'inventory']);
    },
    [acceptWallet],
  );

  const acceptPlayer = useCallback(
    (
      player: PublicPlayer,
      extra?: { rod?: EquipmentInstance; autoRepairLevel?: number },
    ) => {
      acceptWallet({
        coins: player.coins,
        blackCoins: player.black_coins,
        invRev: player.inv_rev,
        version: player.version,
      });
      if (extra?.rod !== undefined || extra?.autoRepairLevel !== undefined) {
        setFishing((current) => {
          if (!current || player.version < current.player_version) return current;
          return {
            ...current,
            coins: player.coins,
            player_version: Math.max(current.player_version, player.version),
            inv_rev: Math.max(current.inv_rev, player.inv_rev),
            rod: extra.rod ?? current.rod,
            fishing:
              extra.autoRepairLevel !== undefined
                ? { ...current.fishing, auto_repair_level: extra.autoRepairLevel }
                : current.fishing,
          };
        });
        setInventory((current) => {
          if (!current || player.version < current.player.version) return current;
          const updatedRods =
            extra.rod && current.rods
              ? current.rods.map((r) => (r.id === extra.rod!.id ? extra.rod! : r))
              : current.rods;
          return {
            ...current,
            player,
            rods: updatedRods,
          };
        });
        void refreshRef.current(['fishing', 'inventory']);
      }
    },
    [acceptWallet],
  );

  const acceptLotteryClaim = useCallback(
    (res: LotteryClaimResponse) => {
      acceptPlayer(res.player);
      const claimedIds = new Set((res.tickets ?? []).map((ticket) => ticket.id));
      if (claimedIds.size > 0) {
        setLottery((current) => {
          if (!current || !current.tickets) return current;
          return {
            ...current,
            tickets: current.tickets.filter((ticket) => !claimedIds.has(ticket.id)),
          };
        });
      }
      void refreshRef.current(['lottery', 'inventory', 'fishing']);
    },
    [acceptPlayer],
  );

  const acceptLotteryCraft = useCallback(
    (res: LotteryCraftResponse) => {
      acceptWallet({
        coins: res.player.coins,
        blackCoins: res.player.black_coins,
        blankTickets: res.blank_tickets,
        invRev: res.player.inv_rev,
        version: res.player.version,
      });
      setInventory((current) => {
        if (!current || res.player.version < current.player.version) return current;
        return {
          ...current,
          player: res.player,
          blank_tickets: res.blank_tickets,
        };
      });
      setLottery((current) => {
        if (!current) return current;
        const byId = new Map<string, LotteryTicket>();
        for (const ticket of current.tickets ?? []) {
          byId.set(ticket.id, ticket);
        }
        for (const ticket of res.tickets ?? []) {
          byId.set(ticket.id, ticket);
        }
        return {
          ...current,
          blank_tickets: res.blank_tickets,
          tickets: Array.from(byId.values()),
        };
      });
      void refreshRef.current(['lottery', 'inventory', 'fishing']);
    },
    [acceptWallet],
  );

  const acceptScratchCard = useCallback(
    (card: PublicScratchCard, player?: PublicPlayer) => {
      if (player) acceptPlayer(player);
      setCards((current) => mergeCards(current, [card]));
      void refreshRef.current(['scratch', 'inventory', 'fishing']);
    },
    [acceptPlayer],
  );

  const syncError = Object.values(failed)[0] ?? null;

  return {
    wallet,
    fishing,
    inventory,
    quotes,
    candleRevision,
    lottery,
    cards,
    events,
    globalLegendary,
    lastCatchEvent,
    connection,
    lastEnvelope,
    syncError,
    refresh,
    acceptFishingCommand,
    acceptPlayer,
    acceptLotteryClaim,
    acceptLotteryCraft,
    acceptScratchCard,
  };
}
