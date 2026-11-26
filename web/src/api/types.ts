export interface Success {
  ok: true;
}

export interface PublicUser {
  id: number;
  username: string;
  role: string;
  email: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublicPlayer {
  user_id: number;
  version: number;
  inv_rev: number;
  coins: number;
  black_coins: number;
  state: Record<string, unknown>;
  last_fishing_settle_at: string | null;
  house_last_claim_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MeResponse extends Success {
  user: PublicUser;
  player: PublicPlayer;
}

export interface AuthResponse extends MeResponse {
  token: string;
}

export type AffixType = 'speed' | 'technique' | 'rarity' | 'material' | 'size' | 'doubleCatch';

export interface Affix {
  type: AffixType | (string & {});
  value: number;
}

export interface EquipmentInstance {
  id: number;
  user_id: number;
  template_id: string;
  slot_type: string;
  equipped: boolean;
  durability: number;
  max_durability: number;
  enhance_level: number;
  affixes: Affix[] | null;
  locked: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface FishRoll {
  species_id: string;
  name: string;
  tier: string;
  traits: string[] | null;
  weight_g: number;
}

export interface FishingBite {
  started_at_ms: number;
  fish: FishRoll;
  charge_at_bite: number;
  charge_required: number;
  charge_rate: number;
  tension_rate: number;
  max_tension: number;
  tension_delay_ms: number;
  loss_base: number;
}

export interface FishingState {
  running: boolean;
  selected_depth_id: string;
  phase: 'charging' | 'reeling';
  progress: number;
  tension: number;
  recover_until_ms: number;
  recover_from: number;
  auto_repair_level: number;
  auto_repair_at_ms: number;
  low_durability: boolean;
  auto_stopped: boolean;
  manual_resume: boolean;
  last_tick_at_ms: number;
  bite: FishingBite | null;
  allow_coin_fallback?: boolean;
}

export interface FishingStopResponse extends Success {
  running: boolean;
  player_version: number;
  inv_rev: number;
  rod: EquipmentInstance | null;
}

export interface FishingStartResponse extends FishingStopResponse {
  depth_id: string;
  rod: EquipmentInstance;
}

export interface FishingStateResponse extends FishingStopResponse {
  depth_id: string;
  coins: number;
  fishing: FishingState;
}

export interface PlayerResponse extends Success {
  player: PublicPlayer;
}

export interface RepairResponse extends PlayerResponse {
  rod: EquipmentInstance;
}

export interface UpgradeResponse extends PlayerResponse {
  auto_repair_level: number;
}

export interface GuildQuoteItem {
  id: number;
  item_id: string;
  tier: string;
  traits: string[] | null;
  weight_g: number;
  quantity: number;
  unit_price: number;
  total_price: number;
}

export interface InventoryItem extends Omit<GuildQuoteItem, 'unit_price' | 'total_price'> {
  user_id: number;
  item_kind: string;
  created_at: string;
}

export interface FXPosition {
  symbol: string;
  quantity: number;
  avg_cost: number;
}

export interface GuildInventoryResponse extends PlayerResponse {
  fish: InventoryItem[] | null;
  guild_quotes: GuildQuoteItem[];
  materials: Record<string, number>;
  blank_tickets: number;
  rods: EquipmentInstance[] | null;
  positions: Record<string, FXPosition>;
}

export interface GuildSellRequest {
  fish_ids?: number[];
  sell_all?: boolean;
}

export interface FXFlow {
  symbol: string;
  net: number;
  volume: number;
}

export interface GuildSellResponse extends PlayerResponse {
  sold_count: number;
  coins_earned: number;
  tickets_earned: number;
  fx_flows: FXFlow[] | null;
}

export interface FXQuote {
  symbol: string;
  label: string;
  base_price: number;
  mid: number;
  buy: number;
  sell: number;
  change: number;
  today_net: number;
  today_volume: number;
  imbalance: number;
  position: number;
  avg_cost: number;
}

export interface FXQuotesResponse extends Success {
  quotes: FXQuote[];
}

interface OHLC {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FXCandle extends OHLC {
  ts_ms: number;
  settled: boolean;
  running: boolean;
}

interface FXDayCandle extends OHLC {
  symbol: string;
  day_index: number;
  net: number;
  move: number;
  imbalance: number;
  settled_at: string;
}

export type FXGrain = 15 | 30 | 60 | 120;
export type FXSide = 'buy' | 'sell';

export interface FXCandlesResponse extends Success {
  symbol: string;
  grain: FXGrain;
  candles: FXCandle[];
}

export interface FXTradeResponse extends PlayerResponse {
  symbol: string;
  side: FXSide;
  quantity: number;
  unit_price: number;
  fee: number;
  new_position_qty: number;
  new_avg_cost: number;
}

export type LotteryTier = 'normal' | 'advanced' | 'master';

export interface PrizeItem {
  type: string;
  name?: string;
  qty: number;
  rod_id?: string;
}

export interface LotteryPool {
  id: LotteryTier;
  name: string;
  min: number;
  max: number;
  pick: number;
  ticket_cost: number;
  prizes: PrizeItem[][];
}

export interface LotteryTicket {
  id: string;
  tier: LotteryTier;
  batch_id: string;
  numbers: number[];
  status: string;
  assigned_at: string;
}

export interface LotteryDraw {
  batch_id: string;
  pool_id: LotteryTier;
  winning_numbers: number[];
  draw_seed_hash: string;
  drawn_at: string;
}

export interface LotteryStatusResponse extends Success {
  current_batch: { batch_id: string; start_at: string; end_at: string; drawn: boolean };
  recent_draws: LotteryDraw[] | null;
  blank_tickets: number;
  tickets: LotteryTicket[] | null;
  pools: LotteryPool[];
}

export interface LotteryCraftResponse extends PlayerResponse {
  tickets: LotteryTicket[];
  blank_tickets: number;
  replayed: boolean;
}

interface LotteryDrawPayload {
  batch_id: string;
  draws: Record<string, number[]>;
}

export interface LotteryDrawResponse extends Success, LotteryDrawPayload {
  newly_drawn: boolean;
}

export interface LotteryClaimResponse extends PlayerResponse {
  claimed: number;
  tickets: (LotteryTicket & { hits: number; prizes: PrizeItem[] | null })[] | null;
  replayed: boolean;
}

export type ScratchCardType = 'scratch-tide' | 'scratch-super';

export interface ScratchSlot {
  id: string;
  kind: string;
  name: string;
  qty: number;
  need: number;
}

export interface ScratchPayout extends Omit<ScratchSlot, 'id'> {
  count: number;
  combos: number;
}

export interface PublicScratchCard {
  id: number;
  card_type: ScratchCardType;
  slots: number;
  revealed: boolean;
  created_at: string;
  revealed_at: string | null;
  face?: ScratchSlot[];
  payouts?: ScratchPayout[];
}

export interface ScratchCardsResponse extends Success {
  cards: PublicScratchCard[] | null;
}

export interface ScratchMutationResponse extends PlayerResponse {
  card: PublicScratchCard;
  replayed: boolean;
}

interface FishingEvent {
  inv_rev: number;
}

type FishOutcome = FishRoll & FishingEvent & {
  durability: number;
  previous_durability: number;
  durability_loss: number;
};

export interface SSEPayloads {
  fishing_started: FishingEvent & { running: boolean; depth_id: string; durability: number };
  fishing_stopped: FishingEvent & { running: boolean; depth_id?: string; auto_stopped?: boolean; durability?: number };
  catch: FishOutcome & { quantity: number; materials?: Record<string, number> };
  escape: FishOutcome;
  auto_repair: FishingEvent & {
    durability: number;
    previous_durability: number;
    restored: number;
    material_used: number;
    coins_used: number;
    cleared_broken: boolean;
  };
  fx_tick: { candles: FXDayCandle[] };
  lottery_drawn: LotteryDrawPayload;
  scratch_revealed: { card: PublicScratchCard };
}

export interface SSEMetadata {
  id: string;
  channel: 'user' | 'global';
  user_id: number;
  seq: number;
  inv_rev: number;
  version: number;
  ts_ms: number;
  sig: string;
}

export type SSEEvent = keyof SSEPayloads;
export type SSEEnvelope<E extends SSEEvent = SSEEvent> = {
  [K in E]: SSEMetadata & { event: K; payload: SSEPayloads[K] };
}[E];

export type MarketResource = 'fishing' | 'inventory' | 'quotes' | 'lottery' | 'scratch';

export interface MarketWallet {
  coins: number;
  blackCoins: number;
  blankTickets: number;
  invRev: number;
  version: number;
}
