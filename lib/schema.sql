-- Asian Street Gourmet — dynamic-menu schema + seed
-- Idempotent: safe to re-run. Existing rows are preserved (ON CONFLICT DO NOTHING).
-- To modify existing rows, write explicit UPDATE statements.

-- ============================================================
-- 1. TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS ingredients (
  id           SERIAL PRIMARY KEY,
  slug         TEXT UNIQUE NOT NULL,
  name_en      TEXT NOT NULL,
  name_zh      TEXT NOT NULL,
  category     TEXT NOT NULL,                       -- 'meat'|'seafood'|'vegetable'|'preserved'|'pantry'
  is_pantry    BOOLEAN NOT NULL DEFAULT FALSE,      -- if true, collapsed under "rarely changes"
  is_available BOOLEAN NOT NULL DEFAULT TRUE,       -- the toggle the admin flips
  notes        TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS menu_items (
  id            SERIAL PRIMARY KEY,
  code          TEXT UNIQUE NOT NULL,                -- 'A4', 'C2', 'D3', etc.
  name_en       TEXT NOT NULL,
  name_zh       TEXT NOT NULL,
  category      TEXT NOT NULL,                       -- 'steam'|'soup'|'snack'
  price_cents   INTEGER NOT NULL,
  rotation_mode TEXT NOT NULL DEFAULT 'always',      -- 'always'|'rotation' (dormant — kept for future use)
  is_available  BOOLEAN NOT NULL DEFAULT TRUE,       -- direct per-item availability (admin toggle)
  is_archived   BOOLEAN NOT NULL DEFAULT FALSE,      -- soft-delete; archived rows hide from public + admin
  display_order INTEGER NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent migrations for DBs that pre-date the columns:
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS is_available BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS is_archived  BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS menu_item_ingredients (
  menu_item_id  INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
  PRIMARY KEY (menu_item_id, ingredient_id)
);

CREATE TABLE IF NOT EXISTS rotation_settings (
  category   TEXT PRIMARY KEY,
  pool_size  INTEGER NOT NULL DEFAULT 0
);

-- Opening hours, one row per day-of-week (0=Sun, 6=Sat to match JS Date.getDay()).
-- opens/closes are 24-hour "HH:MM" strings, NULL when is_open=false.
CREATE TABLE IF NOT EXISTS hours (
  day_of_week  INTEGER PRIMARY KEY,
  is_open      BOOLEAN NOT NULL DEFAULT TRUE,
  opens        TEXT,
  closes       TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (day_of_week >= 0 AND day_of_week <= 6)
);

-- Daily soup schedule. The new menu rotates soups by day-of-week —
-- e.g. Monday is Lotus Root, Friday is Winter Melon, Saturday + Sunday
-- both get Tomato. One row per day, with a FK to whichever soup is
-- served that day. Nullable soup_code means "no soup that day".
CREATE TABLE IF NOT EXISTS soup_schedule (
  day_of_week  INTEGER PRIMARY KEY,
  soup_code    TEXT REFERENCES menu_items(code),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (day_of_week >= 0 AND day_of_week <= 6)
);

-- ============================================================
-- 2. INGREDIENTS (seed)
-- ============================================================

-- Meat & poultry
INSERT INTO ingredients (slug, name_en, name_zh, category, is_pantry) VALUES
  ('pork-ribs',      'Pork ribs',       '排骨',   'meat', FALSE),
  ('pork-ground',    'Ground pork',     '豬肉碎', 'meat', FALSE),
  ('chicken',        'Chicken',         '光雞',   'meat', FALSE),
  ('beef-brisket',   'Beef brisket',    '牛腩',   'meat', FALSE),
  ('lamb-brisket',   'Lamb brisket',    '羊腩',   'meat', FALSE),
  ('roast-duck',     'Roast duck',      '燒鴨',   'meat', FALSE),
  ('pork-bones',     'Pork bones',      '豬骨',   'meat', FALSE),
  ('pork-skin',      'Pork skin',       '豬皮',   'meat', FALSE)
ON CONFLICT (slug) DO NOTHING;

-- Seafood
INSERT INTO ingredients (slug, name_en, name_zh, category, is_pantry) VALUES
  ('shrimp',         'Shrimp',          '蝦',     'seafood', FALSE),
  ('squid-fresh',    'Fresh squid',     '鮮魷',   'seafood', FALSE),
  ('pomfret',        'Pomfret (whole)', '倉魚',   'seafood', FALSE),
  ('yellow-croaker', 'Yellow croaker (whole)', '黃花魚', 'seafood', FALSE),
  ('fish-paste',     'Fish paste',      '魚滑',   'seafood', FALSE),
  ('fish-balls',     'Fish balls',      '魚旦',   'seafood', TRUE)
ON CONFLICT (slug) DO NOTHING;

-- Fresh vegetables
INSERT INTO ingredients (slug, name_en, name_zh, category, is_pantry) VALUES
  ('daikon',         'Daikon radish',   '蘿蔔',   'vegetable', FALSE),
  ('lotus-root',     'Lotus root',      '蓮藕',   'vegetable', FALSE),
  ('watercress',     'Watercress',      '西洋菜', 'vegetable', FALSE),
  ('hairy-gourd',    'Hairy gourd',     '節瓜',   'vegetable', FALSE),
  ('tomato',         'Tomato',          '番茄',   'vegetable', FALSE),
  ('taro',           'Taro',            '香芋',   'vegetable', FALSE),
  ('chili-pepper',   'Chili pepper',    '辣椒',   'vegetable', FALSE)
ON CONFLICT (slug) DO NOTHING;

-- Preserved / dried (mostly pantry-stable but worth tracking)
INSERT INTO ingredients (slug, name_en, name_zh, category, is_pantry) VALUES
  ('preserved-mustard',        'Preserved mustard tuber',    '榨菜',   'preserved', TRUE),
  ('preserved-mustard-greens', 'Preserved mustard greens',   '梅菜',   'preserved', TRUE),
  ('black-mushroom',           'Dried Chinese black mushroom','冬菇',  'preserved', TRUE),
  ('bean-curd-stick',          'Dried bean curd stick',      '支竹',   'preserved', TRUE),
  ('dried-mustard-greens',     'Dried Chinese mustard greens','菜乾',  'preserved', TRUE),
  ('night-blooming-cereus',    'Night-blooming cereus (dried)','霸王花','preserved', TRUE),
  ('fermented-black-bean',     'Fermented black beans',      '豆豉',   'preserved', TRUE)
ON CONFLICT (slug) DO NOTHING;

-- Pantry & frozen
INSERT INTO ingredients (slug, name_en, name_zh, category, is_pantry) VALUES
  ('eggs',           'Eggs',                  '雞蛋', 'pantry', TRUE),
  ('spring-rolls',   'Pre-made spring rolls', '春卷', 'pantry', TRUE),
  ('mantou',         'Frozen mantou',         '饅頭', 'pantry', TRUE),
  ('siu-mai',        'Siu mai (frozen)',      '燒賣', 'pantry', TRUE),
  ('rice-noodles',   'Rice noodles (dried)',  '米粉', 'pantry', TRUE),
  ('egg-noodles',    'Egg noodles (dried)',   '蛋麵', 'pantry', TRUE),
  ('dumplings',      'Boiled dumplings (frozen)','水餃','pantry', TRUE)
ON CONFLICT (slug) DO NOTHING;

-- ============================================================
-- 3. MENU ITEMS (seed) — matches the JULY 2026 printed menu
-- ============================================================

-- 蒸餸飯 Steamed Rice Dishes ($7–$9) — A column (A1–A7).
-- English wording mirrors the printed menu's "X Steam Rice" pattern.
INSERT INTO menu_items (code, name_en, name_zh, category, price_cents, display_order) VALUES
  ('A1', 'Pork Rib Steam Rice',         '榨菜排骨蒸飯', 'steam', 700, 1),
  ('A2', 'Chicken Steam Rice',          '冬菇滑雞蒸飯', 'steam', 700, 2),
  ('A3', 'Meat Patties Steam Rice',     '梅菜肉餅蒸飯', 'steam', 700, 3),
  ('A4', 'Beef Brisket Steam Rice',     '蘿蔔牛腩蒸飯', 'steam', 900, 4),
  ('A5', 'Tomato Beef Steam Rice',      '番茄牛肉蒸飯', 'steam', 900, 5),
  ('A6', 'Sheep Brisket Steam Rice',    '支竹羊腩蒸飯', 'steam', 900, 6),
  ('A7', 'Duck Steam Rice',             '香芋鴨蒸飯',   'steam', 900, 7)
ON CONFLICT (code) DO NOTHING;

-- 蒸餸飯 Steamed Rice Dishes ($8–$9) — B column (B1–B7).
-- Two menu typos corrected: "Bamfish"→"Pomfret", "Slaem"→"Steam".
INSERT INTO menu_items (code, name_en, name_zh, category, price_cents, display_order) VALUES
  ('B1', 'Shrimp Egg Steam Rice',                  '滑蛋蝦仁蒸飯', 'steam', 800, 8),
  ('B2', 'Steamed Pomfret Steam Rice',             '蒸倉魚蒸飯',   'steam', 800, 9),
  ('B3', 'Steamed Yellow Croaker Steam Rice',      '蒸黃花魚蒸飯', 'steam', 800, 10),
  ('B4', 'Fresh Squid Steam Rice',                 '豉椒鮮魷蒸飯', 'steam', 800, 11),
  ('B5', 'Fish Paste Steam Rice',                  '辣椒魚滑蒸飯', 'steam', 800, 12),
  ('B6', 'Fish Fillets Steam Rice',                '酸菜魚片蒸飯', 'steam', 900, 13),
  ('B7', 'Vegetarian Steam Rice',                  '羅漢素菜',     'steam', 900, 14)
ON CONFLICT (code) DO NOTHING;

-- 每日靚湯 Daily Soup ($3) — C1–C6. English wording matches the printed
-- menu (no trailing "Soup" since the section heading already says it).
-- C3 in the printed menu had "Lotus root" as the English caption — that
-- was clearly a duplicate-paste typo of C1; the Chinese 白菜菜乾 means
-- "dried cabbage", which is what we use here.
INSERT INTO menu_items (code, name_en, name_zh, category, price_cents, display_order) VALUES
  ('C1', 'Lotus Root',           '蓮藕湯',     'soup', 300, 18),
  ('C2', 'Watercress',           '西洋菜湯',   'soup', 300, 19),
  ('C3', 'Dried Cabbage',        '白菜菜乾',   'soup', 300, 20),
  ('C4', 'Blooming Cereus',      '霸王花湯',   'soup', 300, 21),
  ('C5', 'Winter Melon',         '冬瓜湯',     'soup', 300, 22),
  ('C6', 'Tomato Borscht',       '番茄湯',     'soup', 300, 23)
ON CONFLICT (code) DO NOTHING;

-- 小食 Snacks & Sides ($3) — D1–D6. Singular form per the printed menu.
INSERT INTO menu_items (code, name_en, name_zh, category, price_cents, display_order) VALUES
  ('D1', 'Steam Rice',           '白飯',     'snack', 300, 24),
  ('D2', 'Spring Rolls',         '炸春卷',   'snack', 300, 25),
  ('D3', 'Fish Ball',            '魚旦燒賣', 'snack', 300, 26),
  ('D4', 'Dumpling',             '水餃',     'snack', 300, 27),
  ('D5', 'Fried Rice Noodle',    '炒粉',     'snack', 300, 28),
  ('D6', 'Fried Noodle',         '炒麵',     'snack', 300, 29)
ON CONFLICT (code) DO NOTHING;

-- Default daily-soup assignments (matches the printed menu).
-- Mon=C1, Tue=C2, Wed=C3, Thu=C4, Fri=C5, Sat+Sun=C6 (one soup covers
-- both weekend days; FK reuse, no duplicate row needed).
INSERT INTO soup_schedule (day_of_week, soup_code) VALUES
  (0, 'C6'),  -- Sun → Tomato (shared with Sat)
  (1, 'C1'),  -- Mon → Lotus Root
  (2, 'C2'),  -- Tue → Watercress
  (3, 'C3'),  -- Wed → Dried Cabbage
  (4, 'C4'),  -- Thu → Night-Blooming Cereus
  (5, 'C5'),  -- Fri → Winter Melon
  (6, 'C6')   -- Sat → Tomato
ON CONFLICT (day_of_week) DO NOTHING;

-- ============================================================
-- 4. MENU ITEM → INGREDIENT RELATIONSHIPS
-- ============================================================
-- Authored in (code, slug) pairs and joined to look up the FK ids.
-- Reads like a recipe list, no manual id juggling.

INSERT INTO menu_item_ingredients (menu_item_id, ingredient_id)
SELECT m.id, i.id
FROM (VALUES
  -- Steam dishes A column (蒸餸飯)
  ('A1','pork-ribs'),    ('A1','preserved-mustard'),
  ('A2','chicken'),      ('A2','black-mushroom'),
  ('A3','pork-ground'),  ('A3','preserved-mustard-greens'),
  ('A4','beef-brisket'), ('A4','daikon'),
  ('A5','beef-brisket'), ('A5','tomato'),
  ('A6','lamb-brisket'), ('A6','bean-curd-stick'),
  ('A7','roast-duck'),   ('A7','taro'),
  -- Steam dishes B column
  ('B1','shrimp'),         ('B1','eggs'),
  ('B2','pomfret'),
  ('B3','yellow-croaker'),
  ('B4','squid-fresh'),    ('B4','fermented-black-bean'),
  ('B5','fish-paste'),     ('B5','chili-pepper'),
  ('B6','fish-paste'),     ('B6','dried-mustard-greens'),
  -- B7 vegetarian uses pantry items only
  -- Soups (靚湯, most share pork bones)
  ('C1','lotus-root'),            ('C1','pork-bones'),
  ('C2','watercress'),            ('C2','pork-bones'),
  ('C3','dried-mustard-greens'),  ('C3','pork-bones'),
  ('C4','night-blooming-cereus'), ('C4','pork-bones'),
  -- C5 winter melon: ingredient slug not yet seeded; skip linkage
  ('C6','tomato'),                ('C6','eggs'),
  -- Snacks (小食; pantry=true ingredients won't block availability)
  -- D1 plain steamed rice uses pantry only
  ('D2','spring-rolls'),
  ('D3','fish-balls'),   ('D3','siu-mai'),
  ('D4','dumplings'),
  ('D5','rice-noodles'),
  ('D6','egg-noodles')
) AS pairs(code, slug)
JOIN menu_items  m ON m.code = pairs.code
JOIN ingredients i ON i.slug = pairs.slug
ON CONFLICT (menu_item_id, ingredient_id) DO NOTHING;

-- ============================================================
-- 5. ROTATION SETTINGS (seed at 0 = no rotation enforced initially)
-- ============================================================

INSERT INTO rotation_settings (category, pool_size) VALUES
  ('steam', 0),
  ('soup',  0),
  ('snack', 0)
ON CONFLICT (category) DO NOTHING;

-- Seed weekly opening hours (matches existing visible HTML)
INSERT INTO hours (day_of_week, is_open, opens, closes) VALUES
  (0, TRUE,  '11:00', '21:00'),  -- Sun
  (1, FALSE, NULL,    NULL),     -- Mon (closed)
  (2, TRUE,  '11:00', '21:00'),  -- Tue
  (3, TRUE,  '11:00', '21:00'),  -- Wed
  (4, TRUE,  '11:00', '21:00'),  -- Thu
  (5, TRUE,  '11:00', '22:00'),  -- Fri
  (6, TRUE,  '11:00', '22:00')   -- Sat
ON CONFLICT (day_of_week) DO NOTHING;

-- ============================================================
-- ORDERS (online ordering, Tier 1 — pay at pickup)
-- ============================================================
-- One row per online order. Items live in order_items below.
-- Snapshot pattern: name_en/name_zh/price_cents are copied to order_items
-- at order time, so the order stays correct even if the menu changes.

CREATE TABLE IF NOT EXISTS orders (
  id                  SERIAL PRIMARY KEY,
  pickup_code         TEXT UNIQUE NOT NULL,  -- 4 alphanumeric, [A-Z0-9], e.g. 'A7K2'
  customer_name       TEXT NOT NULL,
  customer_phone      TEXT,                  -- OPTIONAL
  customer_email      TEXT,                  -- OPTIONAL
  notes               TEXT,
  subtotal_cents      INTEGER NOT NULL,
  tax_cents           INTEGER NOT NULL,      -- 8.875% NYC sales tax, server-computed
  total_cents         INTEGER NOT NULL,
  estimated_wait_min  INTEGER NOT NULL,      -- shown to customer at submission
  status              TEXT NOT NULL DEFAULT 'received',
                      -- received → preparing → ready → picked_up → cancelled
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_items (
  id               SERIAL PRIMARY KEY,
  order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_code        TEXT NOT NULL,        -- 'S1', 'A4', etc.
  name_en          TEXT NOT NULL,        -- snapshot
  name_zh          TEXT NOT NULL,        -- snapshot
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  price_cents      INTEGER NOT NULL,     -- snapshot of menu price at order time
  line_total_cents INTEGER NOT NULL
);

-- Hot path for the admin list view: filter by status, newest first
CREATE INDEX IF NOT EXISTS idx_orders_status_created
  ON orders(status, created_at DESC);

-- ----- POS-system columns -----
-- Added when the register-side POS was introduced. All additive: existing
-- online orders keep working (order_channel defaults to 'online'; every
-- other new column is nullable). Run this block on prod BEFORE the new
-- POS code deploys so the admin GET /orders SELECT doesn't 500 on the
-- missing columns.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS order_channel       TEXT    NOT NULL DEFAULT 'online'
    CHECK (order_channel IN ('online','pos')),
  ADD COLUMN IF NOT EXISTS dining_option       TEXT
    CHECK (dining_option IS NULL OR dining_option IN ('dine_in','takeout')),
  ADD COLUMN IF NOT EXISTS discount_cents      INTEGER NOT NULL DEFAULT 0
    CHECK (discount_cents >= 0),
  ADD COLUMN IF NOT EXISTS discount_pct        INTEGER
    CHECK (discount_pct IS NULL OR (discount_pct BETWEEN 0 AND 100)),
  ADD COLUMN IF NOT EXISTS discount_reason     TEXT,
  ADD COLUMN IF NOT EXISTS cash_tendered_cents INTEGER
    CHECK (cash_tendered_cents IS NULL OR cash_tendered_cents >= 0),
  ADD COLUMN IF NOT EXISTS cashier_name        TEXT;

-- Hot path for the admin inbox's channel filter (All / Online / POS).
CREATE INDEX IF NOT EXISTS idx_orders_channel_created
  ON orders(order_channel, created_at DESC);

-- ============================================================
-- SETTINGS (generic key-value feature flags)
-- ============================================================
-- Used now only for the cart on/off switch. Future flags (e.g.
-- "holiday banner active") would slot in here without schema change.

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,            -- store as text, parse as needed
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cart starts DISABLED. Family enables it from /admin/ when they're
-- ready to take online orders.
INSERT INTO settings (key, value) VALUES ('cart_enabled', 'false')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- admin_users — secondary admin accounts.
-- ============================================================
-- The PRIMARY admin lives in env vars (ADMIN_USERNAME +
-- ADMIN_PASSWORD_HASH) — that account is the bootstrap / recovery
-- account and doesn't appear in this table. Additional accounts go
-- here, each with their own scrypt salt:hash. The check order in
-- lib/auth.js is: env-var user first, then this table.

CREATE TABLE IF NOT EXISTS admin_users (
  id             SERIAL PRIMARY KEY,
  username       TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,            -- scrypt salt_b64:hash_b64
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- DONE. Verify with:
--   SELECT COUNT(*) FROM ingredients;            -- 35
--   SELECT COUNT(*) FROM menu_items WHERE NOT is_archived;  -- 26 (14 steam + 6 soup + 6 snack)
--   SELECT COUNT(*) FROM menu_item_ingredients;  -- ~33 (new pairings)
--   SELECT COUNT(*) FROM rotation_settings;      -- 3 (steam, soup, snack)
--   SELECT COUNT(*) FROM hours;                  -- 7
--   SELECT COUNT(*) FROM soup_schedule;          -- 7 (Sat+Sun both C6)
--   SELECT COUNT(*) FROM orders;                 -- 0 initially
--   SELECT COUNT(*) FROM order_items;            -- 0 initially
--   SELECT COUNT(*) FROM settings;               -- 1 (cart_enabled)
-- ============================================================
