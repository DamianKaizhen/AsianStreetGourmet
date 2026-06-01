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
  code          TEXT UNIQUE NOT NULL,                -- 'S1', 'A4', etc.
  name_en       TEXT NOT NULL,
  name_zh       TEXT NOT NULL,
  category      TEXT NOT NULL,                       -- 'rice'|'home'|'soup'|'snack'
  price_cents   INTEGER NOT NULL,
  rotation_mode TEXT NOT NULL DEFAULT 'always',      -- 'always'|'rotation' (dormant — kept for future use)
  is_available  BOOLEAN NOT NULL DEFAULT TRUE,       -- direct per-item availability (admin toggle)
  display_order INTEGER NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent migration for DBs that already have menu_items without is_available:
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS is_available BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS menu_item_ingredients (
  menu_item_id  INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
  PRIMARY KEY (menu_item_id, ingredient_id)
);

CREATE TABLE IF NOT EXISTS rotation_settings (
  category   TEXT PRIMARY KEY,
  pool_size  INTEGER NOT NULL DEFAULT 0
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
-- 3. MENU ITEMS (seed)
-- ============================================================

-- 蒸餸飯 Steamed Rice Plates ($7) — S1–S4
INSERT INTO menu_items (code, name_en, name_zh, category, price_cents, display_order) VALUES
  ('S1', 'Preserved Mustard & Pork Ribs over Rice',           '榨菜排骨蒸飯', 'rice', 700, 1),
  ('S2', 'Black Mushroom & Silky Chicken over Rice',          '冬菇滑雞蒸飯', 'rice', 700, 2),
  ('S3', 'Preserved Mustard Greens & Pork Patty over Rice',   '梅菜肉餅蒸飯', 'rice', 700, 3),
  ('S4', 'Daikon & Beef Brisket over Rice',                   '蘿蔔牛腩蒸飯', 'rice', 700, 4)
ON CONFLICT (code) DO NOTHING;

-- 家庭菜 Home-Style Dishes ($8) — A1–A6
INSERT INTO menu_items (code, name_en, name_zh, category, price_cents, display_order) VALUES
  ('A1', 'Preserved Mustard Pork Ribs',         '榨菜排骨', 'home', 800, 6),
  ('A2', 'Steamed Chicken with Mushrooms',      '冬菇蒸雞', 'home', 800, 7),
  ('A3', 'Preserved Mustard Pork Patty',        '梅菜肉餅', 'home', 800, 8),
  ('A4', 'Daikon Beef Brisket',                 '蘿蔔牛腩', 'home', 800, 9),
  ('A5', 'Bean Curd Stick Lamb Brisket',        '支竹羊腩', 'home', 800, 10),
  ('A6', 'Taro & Roast Duck',                   '香芋燒鴨', 'home', 800, 11)
ON CONFLICT (code) DO NOTHING;

-- 家庭菜 Home-Style Dishes ($8) — B1–B6
INSERT INTO menu_items (code, name_en, name_zh, category, price_cents, display_order) VALUES
  ('B1', 'Shrimp with Silky Egg',               '蝦仁滑蛋', 'home', 800, 12),
  ('B2', 'Pomfret in Black Bean Sauce',         '豉汁倉魚', 'home', 800, 13),
  ('B3', 'Squid with Black Bean & Pepper',      '豉椒鮮魷', 'home', 800, 14),
  ('B4', 'Steamed Yellow Croaker',              '蒸黃花魚', 'home', 800, 15),
  ('B5', 'Spicy Fish Paste',                    '辣椒魚滑', 'home', 800, 16),
  ('B6', 'Pork Skin & Fish Balls',              '豬皮魚旦', 'home', 800, 17)
ON CONFLICT (code) DO NOTHING;

-- 靚湯 Slow-Simmered Soups ($3) — C1–C6
INSERT INTO menu_items (code, name_en, name_zh, category, price_cents, display_order) VALUES
  ('C1', 'Lotus Root Soup',              '蓮藕湯',   'soup', 300, 18),
  ('C2', 'Watercress Soup',              '西洋菜湯', 'soup', 300, 19),
  ('C3', 'Night-Blooming Cereus Soup',   '霸王花湯', 'soup', 300, 20),
  ('C4', 'Dried Vegetable Soup',         '菜乾湯',   'soup', 300, 21),
  ('C5', 'Tomato Soup',                  '番茄湯',   'soup', 300, 22),
  ('C6', 'Hairy Gourd Soup',             '節瓜湯',   'soup', 300, 23)
ON CONFLICT (code) DO NOTHING;

-- 小食 Snacks & Sides ($3) — D1–D6
INSERT INTO menu_items (code, name_en, name_zh, category, price_cents, display_order) VALUES
  ('D1', 'Fried Spring Rolls',           '炸春卷',   'snack', 300, 24),
  ('D2', 'Fried Mantou (Sweet Buns)',    '炸饅頭',   'snack', 300, 25),
  ('D3', 'Fish Balls & Siu Mai',         '魚旦燒賣', 'snack', 300, 26),
  ('D4', 'Rice Noodle Soup',             '湯粉',     'snack', 300, 27),
  ('D5', 'Egg Noodle Soup',              '湯麵',     'snack', 300, 28),
  ('D6', 'Boiled Dumplings',             '水餃',     'snack', 300, 29)
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- 4. MENU ITEM → INGREDIENT RELATIONSHIPS
-- ============================================================
-- Authored in (code, slug) pairs and joined to look up the FK ids.
-- Reads like a recipe list, no manual id juggling.

INSERT INTO menu_item_ingredients (menu_item_id, ingredient_id)
SELECT m.id, i.id
FROM (VALUES
  -- Rice plates (蒸餸飯)
  ('S1','pork-ribs'),    ('S1','preserved-mustard'),
  ('S2','chicken'),      ('S2','black-mushroom'),
  ('S3','pork-ground'),  ('S3','preserved-mustard-greens'),
  ('S4','beef-brisket'), ('S4','daikon'),
  -- Home-style A (家庭菜)
  ('A1','pork-ribs'),    ('A1','preserved-mustard'),
  ('A2','chicken'),      ('A2','black-mushroom'),
  ('A3','pork-ground'),  ('A3','preserved-mustard-greens'),
  ('A4','beef-brisket'), ('A4','daikon'),
  ('A5','lamb-brisket'), ('A5','bean-curd-stick'),
  ('A6','roast-duck'),   ('A6','taro'),
  -- Home-style B
  ('B1','shrimp'),       ('B1','eggs'),
  ('B2','pomfret'),      ('B2','fermented-black-bean'),
  ('B3','squid-fresh'),  ('B3','fermented-black-bean'), ('B3','chili-pepper'),
  ('B4','yellow-croaker'),
  ('B5','fish-paste'),   ('B5','chili-pepper'),
  ('B6','pork-skin'),    ('B6','fish-balls'),
  -- Soups (靚湯, all share pork bones except C5)
  ('C1','lotus-root'),            ('C1','pork-bones'),
  ('C2','watercress'),            ('C2','pork-bones'),
  ('C3','night-blooming-cereus'), ('C3','pork-bones'),
  ('C4','dried-mustard-greens'),  ('C4','pork-bones'),
  ('C5','tomato'),                ('C5','eggs'),
  ('C6','hairy-gourd'),           ('C6','pork-bones'),
  -- Snacks (小食; pantry=true ingredients won't block availability)
  ('D1','spring-rolls'),
  ('D2','mantou'),
  ('D3','fish-balls'),   ('D3','siu-mai'),
  ('D4','rice-noodles'), ('D4','pork-bones'),
  ('D5','egg-noodles'),  ('D5','pork-bones'),
  ('D6','dumplings')
) AS pairs(code, slug)
JOIN menu_items  m ON m.code = pairs.code
JOIN ingredients i ON i.slug = pairs.slug
ON CONFLICT (menu_item_id, ingredient_id) DO NOTHING;

-- ============================================================
-- 5. ROTATION SETTINGS (seed at 0 = no rotation enforced initially)
-- ============================================================

INSERT INTO rotation_settings (category, pool_size) VALUES
  ('rice',  0),
  ('home',  0),
  ('soup',  0),
  ('snack', 0)
ON CONFLICT (category) DO NOTHING;

-- ============================================================
-- DONE. Verify with:
--   SELECT COUNT(*) FROM ingredients;         -- 35
--   SELECT COUNT(*) FROM menu_items;          -- 28
--   SELECT COUNT(*) FROM menu_item_ingredients; -- 53
--   SELECT COUNT(*) FROM rotation_settings;   -- 4
-- ============================================================
