CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    email TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'player',
    disabled BOOLEAN NOT NULL DEFAULT FALSE,
    totp_secret_enc BYTEA,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mfa_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    ip TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS players (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    version BIGINT NOT NULL DEFAULT 1,
    inv_rev BIGINT NOT NULL DEFAULT 1,
    coins BIGINT NOT NULL DEFAULT 0,
    black_coins BIGINT NOT NULL DEFAULT 0,
    state JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_fishing_settle_at TIMESTAMPTZ,
    house_last_claim_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_items (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    tier TEXT NOT NULL DEFAULT 'normal',
    traits TEXT[] NOT NULL DEFAULT '{}',
    weight_g INT NOT NULL DEFAULT 0,
    quantity BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inventory_items_user_kind_id
    ON inventory_items (user_id, item_kind, item_id);

CREATE TABLE IF NOT EXISTS equipment_instances (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    template_id TEXT NOT NULL,
    slot_type TEXT NOT NULL,
    equipped BOOLEAN NOT NULL DEFAULT FALSE,
    durability INT NOT NULL,
    max_durability INT NOT NULL,
    enhance_level INT NOT NULL DEFAULT 0,
    affixes JSONB NOT NULL DEFAULT '[]'::jsonb,
    locked BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_equipment_instances_user_equipped
    ON equipment_instances (user_id, equipped);

CREATE TABLE IF NOT EXISTS fx_days (
    symbol TEXT NOT NULL,
    day_index INT NOT NULL,
    open NUMERIC(18,6) NOT NULL,
    high NUMERIC(18,6) NOT NULL,
    low NUMERIC(18,6) NOT NULL,
    close NUMERIC(18,6) NOT NULL,
    net DOUBLE PRECISION NOT NULL DEFAULT 0,
    volume DOUBLE PRECISION NOT NULL DEFAULT 0,
    settled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (symbol, day_index)
);

CREATE TABLE IF NOT EXISTS fx_bucket (
    symbol TEXT PRIMARY KEY,
    day_index INT NOT NULL,
    net DOUBLE PRECISION NOT NULL DEFAULT 0,
    volume DOUBLE PRECISION NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fx_bucket_bins (
    symbol TEXT NOT NULL,
    day_index INT NOT NULL,
    bin_slot INT NOT NULL,
    net DOUBLE PRECISION NOT NULL DEFAULT 0,
    volume DOUBLE PRECISION NOT NULL DEFAULT 0,
    PRIMARY KEY (symbol, day_index, bin_slot)
);

CREATE TABLE IF NOT EXISTS fx_positions (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    quantity BIGINT NOT NULL DEFAULT 0,
    avg_cost NUMERIC(18,6) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, symbol)
);

CREATE TABLE IF NOT EXISTS market_orders (
    id BIGSERIAL PRIMARY KEY,
    seller_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    order_kind TEXT NOT NULL,
    item_ref_id BIGINT,
    item_id TEXT,
    quantity BIGINT NOT NULL,
    unit_price BIGINT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'coin',
    status TEXT NOT NULL DEFAULT 'open',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_market_orders_open
    ON market_orders (status, order_kind, created_at DESC);

CREATE TABLE IF NOT EXISTS lottery_batches (
    batch_id TEXT PRIMARY KEY,
    start_at TIMESTAMPTZ NOT NULL,
    end_at TIMESTAMPTZ NOT NULL,
    drawn BOOLEAN NOT NULL DEFAULT FALSE,
    rules JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS lottery_draws (
    batch_id TEXT NOT NULL REFERENCES lottery_batches(batch_id) ON DELETE CASCADE,
    pool_id TEXT NOT NULL,
    winning_numbers INT[] NOT NULL,
    draw_seed_hash TEXT NOT NULL,
    drawn_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (batch_id, pool_id)
);

CREATE TABLE IF NOT EXISTS scratch_cards (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    card_type TEXT NOT NULL,
    slots INT NOT NULL,
    server_face JSONB NOT NULL,
    server_payout JSONB NOT NULL,
    revealed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revealed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_scratch_cards_user_revealed
    ON scratch_cards (user_id, revealed);

CREATE TABLE IF NOT EXISTS action_log (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_key TEXT NOT NULL,
    action TEXT NOT NULL,
    status_code INT NOT NULL,
    response JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, request_key)
);

CREATE TABLE IF NOT EXISTS asset_ledger (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    inv_rev BIGINT NOT NULL,
    event_type TEXT NOT NULL,
    delta JSONB NOT NULL,
    request_key TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_asset_ledger_user_rev ON asset_ledger (user_id, inv_rev);
