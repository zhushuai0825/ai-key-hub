CREATE TABLE IF NOT EXISTS providers (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  balance NUMERIC(12, 2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CNY',
  status TEXT NOT NULL DEFAULT 'active',
  low_balance_threshold NUMERIC(12, 2) NOT NULL DEFAULT 50,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id SERIAL PRIMARY KEY,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  api_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  daily_quota NUMERIC(12, 2) DEFAULT 0,
  monthly_quota NUMERIC(12, 2) DEFAULT 0,
  used_amount NUMERIC(12, 2) DEFAULT 0,
  budget_action TEXT NOT NULL DEFAULT 'alert',
  remark TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS models (
  id SERIAL PRIMARY KEY,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  context_length INTEGER,
  input_price NUMERIC(12, 6) DEFAULT 0,
  output_price NUMERIC(12, 6) DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT true,
  UNIQUE(provider_id, name)
);

CREATE TABLE IF NOT EXISTS usage_logs (
  id SERIAL PRIMARY KEY,
  provider_id INTEGER REFERENCES providers(id) ON DELETE SET NULL,
  api_key_id INTEGER REFERENCES api_keys(id) ON DELETE SET NULL,
  model_name TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost NUMERIC(12, 6) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'success',
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fitness_entries (
  id SERIAL PRIMARY KEY,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('weight', 'meal', 'workout', 'sleep')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  weight_kg NUMERIC(6, 2),
  meal_type TEXT,
  food_text TEXT,
  calories NUMERIC(10, 2),
  protein_g NUMERIC(10, 2),
  carbs_g NUMERIC(10, 2),
  fat_g NUMERIC(10, 2),
  workout_type TEXT,
  workout_text TEXT,
  duration_min INTEGER,
  intensity TEXT,
  burned_calories NUMERIC(10, 2),
  sleep_hours NUMERIC(5, 2),
  sleep_quality TEXT,
  note TEXT NOT NULL DEFAULT '',
  source_user TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fitness_ai_reports (
  id SERIAL PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES fitness_entries(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  advice TEXT NOT NULL,
  risk_level TEXT NOT NULL DEFAULT 'normal',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_bases (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'general',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_categories (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id SERIAL PRIMARY KEY,
  kb_id INTEGER NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'text',
  filename TEXT,
  file_path TEXT,
  raw_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id SERIAL PRIMARY KEY,
  kb_id INTEGER NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  doc_id INTEGER NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  char_count INTEGER NOT NULL DEFAULT 0,
  embedding_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(doc_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS knowledge_queries (
  id SERIAL PRIMARY KEY,
  kb_id INTEGER REFERENCES knowledge_bases(id) ON DELETE SET NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance_entries (
  id SERIAL PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('expense', 'income')),
  amount NUMERIC(12, 2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  category TEXT NOT NULL DEFAULT '未分类',
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'wechat_message',
  source_user TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_message TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wechat_messages (
  id SERIAL PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'wechat',
  from_user TEXT,
  to_user TEXT,
  msg_type TEXT NOT NULL DEFAULT 'text',
  content TEXT NOT NULL DEFAULT '',
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  finance_entry_id INTEGER REFERENCES finance_entries(id) ON DELETE SET NULL,
  fitness_entry_id INTEGER REFERENCES fitness_entries(id) ON DELETE SET NULL,
  intent TEXT NOT NULL DEFAULT 'unknown',
  parse_status TEXT NOT NULL DEFAULT 'ignored',
  reply_text TEXT NOT NULL DEFAULT '',
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assistant_answer_cache (
  id SERIAL PRIMARY KEY,
  cache_key TEXT UNIQUE NOT NULL,
  channel TEXT NOT NULL DEFAULT 'wechat',
  kb_id INTEGER REFERENCES knowledge_bases(id) ON DELETE SET NULL,
  from_user TEXT,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  context_snapshot TEXT NOT NULL DEFAULT '',
  hit_count INTEGER NOT NULL DEFAULT 0,
  pinned BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_hit_at TIMESTAMPTZ,
  topic TEXT
);

CREATE TABLE IF NOT EXISTS assistant_memories (
  id SERIAL PRIMARY KEY,
  from_user TEXT,
  category TEXT NOT NULL DEFAULT 'general',
  content TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 3,
  source TEXT NOT NULL DEFAULT 'wechat',
  source_message_id INTEGER REFERENCES wechat_messages(id) ON DELETE SET NULL,
  pinned BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS assistant_tasks (
  id SERIAL PRIMARY KEY,
  from_user TEXT,
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  remind_at TIMESTAMPTZ,
  recurrence TEXT NOT NULL DEFAULT 'none',
  status TEXT NOT NULL DEFAULT 'pending',
  source_message_id INTEGER REFERENCES wechat_messages(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  last_notified_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS assistant_reports (
  id SERIAL PRIMARY KEY,
  from_user TEXT,
  report_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
