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
  monthly_quota NUMERIC(12, 2) DEFAULT 0,
  used_amount NUMERIC(12, 2) DEFAULT 0,
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

INSERT INTO providers (code, name, base_url, balance, currency, status, low_balance_threshold)
VALUES
  ('deepseek', 'DeepSeek', 'https://api.deepseek.com', 126.80, 'CNY', 'active', 50),
  ('qwen', '通义千问', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 302.45, 'CNY', 'active', 80),
  ('doubao', '豆包', 'https://ark.cn-beijing.volces.com/api/v3', 74.20, 'CNY', 'warning', 100),
  ('zhipu', '智谱', 'https://open.bigmodel.cn/api/paas/v4', 218.60, 'CNY', 'active', 60)
ON CONFLICT (code) DO NOTHING;

INSERT INTO models (provider_id, name, context_length, input_price, output_price, enabled)
SELECT p.id, m.name, m.context_length, m.input_price, m.output_price, true
FROM providers p
JOIN (VALUES
  ('deepseek', 'deepseek-chat', 64000, 0.001000, 0.002000),
  ('deepseek', 'deepseek-reasoner', 64000, 0.004000, 0.016000),
  ('qwen', 'qwen-turbo', 1000000, 0.000300, 0.000600),
  ('qwen', 'qwen-plus', 131072, 0.000800, 0.002000),
  ('qwen', 'qwen-max', 32768, 0.020000, 0.060000),
  ('doubao', 'doubao-seed-1.6', 256000, 0.000800, 0.002000),
  ('doubao', 'doubao-pro-32k', 32768, 0.000800, 0.002000),
  ('zhipu', 'glm-4-flash', 128000, 0.000000, 0.000000),
  ('zhipu', 'glm-4-plus', 128000, 0.050000, 0.050000)
) AS m(code, name, context_length, input_price, output_price)
ON p.code = m.code
ON CONFLICT (provider_id, name) DO NOTHING;

INSERT INTO api_keys (provider_id, name, api_key, status, monthly_quota, used_amount, remark)
SELECT p.id, p.name || ' 主 Key', 'sk-demo-' || p.code || '-replace-me', p.status, 500, CASE p.code WHEN 'doubao' THEN 425 ELSE 120 END, '演示数据，请替换为真实 Key'
FROM providers p
WHERE NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.provider_id = p.id);
