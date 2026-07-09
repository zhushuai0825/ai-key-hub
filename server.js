import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, writeFile, readFile as readLocalFile, readdir, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import Busboy from 'busboy';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import { parse as csvParseSync } from 'csv-parse/sync';
import { ChromaClient } from 'chromadb';
import {
  EMBEDDING_MODEL,
  USE_HASH_EMBEDDING,
  embedQuery,
  embedTexts,
  getEmbeddingStatus,
  warmupEmbeddings,
} from './lib/embeddings.js';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8899);
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://ai_admin:ai_admin_123@127.0.0.1:5432/ai_key_hub';
const AUTH_USER = process.env.APP_AUTH_USER || '';
const AUTH_PASSWORD = process.env.APP_AUTH_PASSWORD || '';
const PROFILE_HEIGHT_CM = 177;
const CHROMA_URL = process.env.CHROMA_URL || 'http://127.0.0.1:8000';
const KNOWLEDGE_COLLECTION = process.env.KNOWLEDGE_COLLECTION || (USE_HASH_EMBEDDING ? 'ai_key_hub_knowledge' : 'ai_key_hub_knowledge_bge');
const UPLOAD_DIR = path.join(__dirname, 'uploads', 'knowledge');
const WECHAT_WORK_TOKEN = process.env.WECHAT_WORK_TOKEN || '';
const WECHAT_WORK_ENCODING_AES_KEY = process.env.WECHAT_WORK_ENCODING_AES_KEY || '';
const WECHAT_WORK_CORP_ID = process.env.WECHAT_WORK_CORP_ID || '';
const WECHAT_WORK_SECRET = process.env.WECHAT_WORK_SECRET || '';
const WECHAT_WORK_AGENT_ID = process.env.WECHAT_WORK_AGENT_ID ? Number(process.env.WECHAT_WORK_AGENT_ID) : null;
const WECHAT_DEFAULT_KB_ID = process.env.WECHAT_DEFAULT_KB_ID ? Number(process.env.WECHAT_DEFAULT_KB_ID) : null;
const ASSISTANT_TASK_POLL_MS = Number(process.env.ASSISTANT_TASK_POLL_MS || 60000);
const ASSISTANT_CACHE_TTL_WECHAT = Number(process.env.ASSISTANT_CACHE_TTL_WECHAT || 1800);
const ASSISTANT_CACHE_TTL_WEB = Number(process.env.ASSISTANT_CACHE_TTL_WEB || 86400);
const ASSISTANT_CACHE_TTL_PINNED = Number(process.env.ASSISTANT_CACHE_TTL_PINNED || 60 * 60 * 24 * 30);
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || '';
const OCR_API_KEY = process.env.OCR_API_KEY || '';
const OCR_BASE_URL = process.env.OCR_BASE_URL || '';
const OCR_MODEL = process.env.OCR_MODEL || '';
const KEY_ENCRYPTION_SECRET = process.env.KEY_ENCRYPTION_SECRET || '';
const GATEWAY_TIMEOUT_MS = Number(process.env.GATEWAY_TIMEOUT_MS || 30000);
const GATEWAY_RETRY_COUNT = Number(process.env.GATEWAY_RETRY_COUNT || 1);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backups');
const AUTO_BACKUP_ENABLED = process.env.AUTO_BACKUP_ENABLED !== 'false';
const AUTO_BACKUP_INTERVAL_MS = Number(process.env.AUTO_BACKUP_INTERVAL_MS || 6 * 60 * 60 * 1000);
const AUTO_BACKUP_KEEP = Number(process.env.AUTO_BACKUP_KEEP || 20);
const WECHAT_FAILED_RETRY_ENABLED = process.env.WECHAT_FAILED_RETRY_ENABLED !== 'false';
const WECHAT_FAILED_RETRY_MS = Number(process.env.WECHAT_FAILED_RETRY_MS || 5 * 60 * 1000);
const WECHAT_FAILED_RETRY_NOTIFY = process.env.WECHAT_FAILED_RETRY_NOTIFY === 'true';
const WECHAT_ADMIN_USER = process.env.WECHAT_ADMIN_USER || '';
const pool = new Pool({ connectionString: DATABASE_URL });
const chroma = new ChromaClient({ path: CHROMA_URL });

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function maskKey(key = '') {
  if (key.length <= 10) return `${key.slice(0, 3)}***`;
  return `${key.slice(0, 6)}${'*'.repeat(Math.max(6, key.length - 10))}${key.slice(-4)}`;
}

function encryptionKey() {
  if (!KEY_ENCRYPTION_SECRET) return null;
  return crypto.createHash('sha256').update(KEY_ENCRYPTION_SECRET).digest();
}

function encryptSecret(value = '') {
  const key = encryptionKey();
  const plain = String(value || '');
  if (!key || !plain) return { api_key: plain, api_key_encrypted: null, api_key_iv: null, api_key_tag: null, key_encryption_version: 0 };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return {
    api_key: maskKey(plain),
    api_key_encrypted: encrypted.toString('base64'),
    api_key_iv: iv.toString('base64'),
    api_key_tag: cipher.getAuthTag().toString('base64'),
    key_encryption_version: 1,
  };
}

function decryptSecret(row = {}) {
  if (!row.api_key_encrypted) return row.api_key || '';
  const key = encryptionKey();
  if (!key) return row.api_key || '';
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(row.api_key_iv || '', 'base64'));
  decipher.setAuthTag(Buffer.from(row.api_key_tag || '', 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(row.api_key_encrypted, 'base64')), decipher.final()]).toString('utf8');
}

async function migratePlainApiKeysToEncrypted() {
  if (!encryptionKey()) return;
  const result = await pool.query(`
    SELECT id, api_key
    FROM api_keys
    WHERE COALESCE(api_key_encrypted,'') = ''
      AND COALESCE(api_key,'') <> ''
      AND api_key NOT LIKE '%***%'`);
  for (const row of result.rows) {
    const secret = encryptSecret(row.api_key);
    await pool.query(
      `UPDATE api_keys
       SET api_key=$1, api_key_encrypted=$2, api_key_iv=$3, api_key_tag=$4, key_encryption_version=$5, updated_at=now()
       WHERE id=$6`,
      [secret.api_key, secret.api_key_encrypted, secret.api_key_iv, secret.api_key_tag, secret.key_encryption_version, row.id]
    );
  }
}

const DEFAULT_NOTIFICATION_SUBSCRIPTIONS = [
  { notification_type: 'daily_report', title: '每日总结', description: '每天发送健康、账本、任务摘要', send_time: '21:30', enabled: true },
  { notification_type: 'weekly_report', title: '每周总结', description: '每周发送阶段性总结', send_time: '09:00', enabled: true },
  { notification_type: 'task_reminder', title: '任务提醒', description: '到期提醒任务主动推送', send_time: '', enabled: true },
  { notification_type: 'backup_success', title: '备份成功', description: '自动备份成功后通知管理员', send_time: '', enabled: false },
  { notification_type: 'backup_failed', title: '备份失败', description: '自动备份失败后通知管理员', send_time: '', enabled: true },
  { notification_type: 'wechat_retry_failed', title: '企微失败消息', description: '消息多次重试失败后通知管理员', send_time: '', enabled: true },
  { notification_type: 'system_error', title: '系统异常', description: '推送失败、服务异常等系统事件', send_time: '', enabled: true },
];

async function ensureDefaultNotificationSubscriptions() {
  for (const item of DEFAULT_NOTIFICATION_SUBSCRIPTIONS) {
    await pool.query(
      `INSERT INTO notification_subscriptions (notification_type,title,description,to_user,send_time,enabled)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (notification_type) DO NOTHING`,
      [item.notification_type, item.title, item.description, WECHAT_ADMIN_USER, item.send_time, item.enabled]
    );
  }
}

async function listNotificationSubscriptions() {
  await ensureDefaultNotificationSubscriptions();
  const [notifications, reports] = await Promise.all([
    pool.query('SELECT * FROM notification_subscriptions ORDER BY enabled DESC, notification_type ASC'),
    pool.query('SELECT * FROM assistant_report_subscriptions ORDER BY enabled DESC, report_type ASC, from_user ASC'),
  ]);
  return { notifications: notifications.rows, report_subscriptions: reports.rows };
}

async function updateNotificationSubscription(type, data = {}) {
  await ensureDefaultNotificationSubscriptions();
  const result = await pool.query(
    `UPDATE notification_subscriptions
     SET to_user=COALESCE($1,to_user), send_time=COALESCE($2,send_time), enabled=COALESCE($3,enabled), quiet_hours=COALESCE($4,quiet_hours), updated_at=now()
     WHERE notification_type=$5 RETURNING *`,
    [data.to_user === undefined ? null : String(data.to_user || ''), data.send_time === undefined ? null : String(data.send_time || ''), data.enabled === undefined ? null : Boolean(data.enabled), data.quiet_hours === undefined ? null : String(data.quiet_hours || ''), type]
  );
  return result.rows[0] || null;
}

async function notificationEnabled(type) {
  await ensureDefaultNotificationSubscriptions();
  const result = await pool.query('SELECT * FROM notification_subscriptions WHERE notification_type=$1 AND enabled=true LIMIT 1', [type]);
  return result.rows[0] || null;
}

async function notifyBySubscription(type, content, { fallbackUser = WECHAT_ADMIN_USER } = {}) {
  const sub = await notificationEnabled(type);
  if (!sub) return { skipped: true, reason: 'notification disabled', type };
  const toUser = sub.to_user || fallbackUser;
  if (!toUser) return { skipped: true, reason: 'missing to_user', type };
  const sent = await sendWechatWorkTextMessage(toUser, content);
  await pool.query('UPDATE notification_subscriptions SET last_sent_at=now(), updated_at=now() WHERE notification_type=$1', [type]);
  return { ok: true, type, to_user: toUser, sent };
}

function actorFromReq(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return 'system';
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    return decoded.split(':')[0] || 'user';
  } catch (_) {
    return 'user';
  }
}

function cleanAuditDetail(detail = {}) {
  return JSON.parse(JSON.stringify(detail, (key, value) => {
    if (/api[_-]?key|secret|token|password/i.test(key)) return '[hidden]';
    return value;
  }));
}

async function auditLog(req, { action, entityType = '', entityId = '', detail = {}, actor = '' } = {}) {
  if (!action) return;
  await pool.query(
    `INSERT INTO audit_logs (actor, action, entity_type, entity_id, detail, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [actor || actorFromReq(req || { headers: {} }), action, entityType, String(entityId || ''), cleanAuditDetail(detail), req?.socket?.remoteAddress || '', req?.headers?.['user-agent'] || '']
  ).catch((error) => console.error('[audit]', error.message));
}

async function systemEvent(action, { entityType = 'system_event', entityId = '', level = 'info', detail = {} } = {}) {
  await auditLog(null, { action, entityType, entityId, actor: 'system', detail: { level, ...detail } });
}

async function initDb() {
  const sql = await readFile(path.join(__dirname, 'db/schema.sql'), 'utf8');
  await pool.query(sql);
  await pool.query('ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS daily_quota NUMERIC(12, 2) DEFAULT 0');
  await pool.query('ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS api_key_encrypted TEXT');
  await pool.query('ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS api_key_iv TEXT');
  await pool.query('ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS api_key_tag TEXT');
  await pool.query('ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_encryption_version INTEGER NOT NULL DEFAULT 0');
  await pool.query("ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS budget_action TEXT NOT NULL DEFAULT 'alert'");
  await pool.query('ALTER TABLE fitness_entries DROP CONSTRAINT IF EXISTS fitness_entries_entry_type_check');
  await pool.query("ALTER TABLE fitness_entries ADD CONSTRAINT fitness_entries_entry_type_check CHECK (entry_type IN ('weight', 'meal', 'workout', 'sleep'))");
  await pool.query('ALTER TABLE fitness_entries ADD COLUMN IF NOT EXISTS sleep_hours NUMERIC(5, 2)');
  await pool.query('ALTER TABLE fitness_entries ADD COLUMN IF NOT EXISTS sleep_quality TEXT');
  await pool.query('ALTER TABLE wechat_messages ADD COLUMN IF NOT EXISTS fitness_entry_id INTEGER REFERENCES fitness_entries(id) ON DELETE SET NULL');
  await pool.query('ALTER TABLE wechat_messages ADD COLUMN IF NOT EXISTS knowledge_document_id INTEGER REFERENCES knowledge_documents(id) ON DELETE SET NULL');
  await pool.query("ALTER TABLE wechat_messages ADD COLUMN IF NOT EXISTS intent TEXT NOT NULL DEFAULT 'unknown'");
  await pool.query('ALTER TABLE wechat_messages ADD COLUMN IF NOT EXISTS source_msg_type TEXT');
  await pool.query('ALTER TABLE wechat_messages ADD COLUMN IF NOT EXISTS media_id TEXT');
  await pool.query('ALTER TABLE wechat_messages ADD COLUMN IF NOT EXISTS media_status TEXT');
  await pool.query('ALTER TABLE wechat_messages ADD COLUMN IF NOT EXISTS media_error TEXT');
  await pool.query("ALTER TABLE wechat_messages ADD COLUMN IF NOT EXISTS correction_status TEXT NOT NULL DEFAULT 'none'");
  await pool.query('ALTER TABLE wechat_messages ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE wechat_messages ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ');
  await pool.query('ALTER TABLE wechat_messages ADD COLUMN IF NOT EXISTS last_error TEXT');
  await pool.query("DELETE FROM api_keys WHERE api_key LIKE 'sk-demo-%' OR remark ILIKE '%演示%'");
  await pool.query(`
    INSERT INTO knowledge_categories (code, name) VALUES
      ('general', '通用'), ('fitness', '健身'), ('novel', '小说'), ('tech', '技术')
    ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name`);
  await pool.query('ALTER TABLE assistant_answer_cache ADD COLUMN IF NOT EXISTS topic TEXT');
  await pool.query('ALTER TABLE assistant_memories ADD COLUMN IF NOT EXISTS source_message_id INTEGER REFERENCES wechat_messages(id) ON DELETE SET NULL');
  await pool.query('ALTER TABLE assistant_memories ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false');
  await pool.query('ALTER TABLE assistant_memories ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ');
  await pool.query("ALTER TABLE assistant_tasks ADD COLUMN IF NOT EXISTS recurrence TEXT NOT NULL DEFAULT 'none'");
  await pool.query("ALTER TABLE assistant_tasks ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'");
  await pool.query('ALTER TABLE assistant_tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ');
  await pool.query("ALTER TABLE assistant_report_subscriptions ADD COLUMN IF NOT EXISTS report_type TEXT NOT NULL DEFAULT 'daily'");
  await pool.query("ALTER TABLE assistant_report_subscriptions ADD COLUMN IF NOT EXISTS send_time TEXT NOT NULL DEFAULT '21:30'");
  await pool.query('ALTER TABLE assistant_report_subscriptions ADD COLUMN IF NOT EXISTS weekday INTEGER');
  await pool.query('ALTER TABLE assistant_report_subscriptions ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true');
  await pool.query('ALTER TABLE assistant_report_subscriptions ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMPTZ');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notification_subscriptions (
      id SERIAL PRIMARY KEY,
      notification_type TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      channel TEXT NOT NULL DEFAULT 'wechat_work',
      to_user TEXT NOT NULL DEFAULT '',
      send_time TEXT NOT NULL DEFAULT '',
      enabled BOOLEAN NOT NULL DEFAULT true,
      quiet_hours TEXT NOT NULL DEFAULT '',
      last_sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query("ALTER TABLE assistant_goals ADD COLUMN IF NOT EXISTS goal_type TEXT NOT NULL DEFAULT 'weight'");
  await pool.query('ALTER TABLE assistant_goals ADD COLUMN IF NOT EXISTS target_value NUMERIC(12, 2) NOT NULL DEFAULT 0');
  await pool.query("ALTER TABLE assistant_goals ADD COLUMN IF NOT EXISTS unit TEXT NOT NULL DEFAULT ''");
  await pool.query("ALTER TABLE assistant_goals ADD COLUMN IF NOT EXISTS period TEXT NOT NULL DEFAULT 'ongoing'");
  await pool.query('ALTER TABLE assistant_goals ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true');
  await pool.query("ALTER TABLE assistant_rules ADD COLUMN IF NOT EXISTS rule_type TEXT NOT NULL DEFAULT 'finance_category'");
  await pool.query('ALTER TABLE assistant_rules ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 100');
  await pool.query('ALTER TABLE assistant_rules ADD COLUMN IF NOT EXISTS hit_count INTEGER NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE assistant_rules ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true');
  await pool.query("ALTER TABLE pending_media_messages ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'");
  await pool.query("ALTER TABLE pending_media_messages ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '10 minutes'");
  await pool.query('ALTER TABLE pending_media_messages ADD COLUMN IF NOT EXISTS resolved_message_id INTEGER REFERENCES wechat_messages(id) ON DELETE SET NULL');
  await pool.query("ALTER TABLE wechat_user_profiles ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT ''");
  await pool.query('ALTER TABLE wechat_user_profiles ADD COLUMN IF NOT EXISTS default_kb_id INTEGER REFERENCES knowledge_bases(id) ON DELETE SET NULL');
  await pool.query("ALTER TABLE wechat_user_profiles ADD COLUMN IF NOT EXISTS daily_report_time TEXT NOT NULL DEFAULT '21:30'");
  await pool.query("ALTER TABLE wechat_user_profiles ADD COLUMN IF NOT EXISTS weekly_report_time TEXT NOT NULL DEFAULT '09:00'");
  await pool.query('ALTER TABLE wechat_user_profiles ADD COLUMN IF NOT EXISTS weekly_report_weekday INTEGER NOT NULL DEFAULT 1');
  await pool.query("ALTER TABLE wechat_user_profiles ADD COLUMN IF NOT EXISTS media_fail_preference TEXT NOT NULL DEFAULT 'ask'");
  await pool.query('ALTER TABLE wechat_user_profiles ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true');
  await pool.query(`
    DELETE FROM assistant_answer_cache
    WHERE topic IS NULL
      OR topic = 'general'
      OR question ~* '^(你好|您好|哈喽|在吗|在不在|谢谢|感谢|拜拜|再见|hi|hello|ok)[!?？。…~\\s]*$'`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_assistant_cache_topic ON assistant_answer_cache(topic)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_assistant_cache_expires ON assistant_answer_cache(expires_at) WHERE pinned=false');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_assistant_memories_user ON assistant_memories(from_user, updated_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_assistant_memories_category ON assistant_memories(category)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_finance_entries_user_time ON finance_entries(source_user, occurred_at DESC)');
  await pool.query('ALTER TABLE fitness_entries ADD COLUMN IF NOT EXISTS source_user TEXT');
  await pool.query('ALTER TABLE assistant_tasks ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMPTZ');
  await pool.query('ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS source_user TEXT');
  await pool.query("ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS source_channel TEXT NOT NULL DEFAULT 'web'");
  await pool.query("ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS source_note TEXT NOT NULL DEFAULT ''");
  await pool.query('CREATE INDEX IF NOT EXISTS idx_fitness_entries_user_time ON fitness_entries(source_user, recorded_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_assistant_tasks_user_status ON assistant_tasks(from_user, status, remind_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_assistant_reports_user_type ON assistant_reports(from_user, report_type, created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_wechat_messages_status_time ON wechat_messages(parse_status, received_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_wechat_messages_intent_time ON wechat_messages(intent, received_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_wechat_messages_retry ON wechat_messages(parse_status, next_retry_at) WHERE parse_status=$$failed$$');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_assistant_report_subscriptions_due ON assistant_report_subscriptions(enabled, report_type, send_time)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_notification_subscriptions_enabled ON notification_subscriptions(enabled, notification_type)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_assistant_goals_user_type ON assistant_goals(from_user, goal_type, enabled)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_assistant_rules_lookup ON assistant_rules(rule_type, enabled, priority)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_pending_media_user_status ON pending_media_messages(from_user, status, expires_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_wechat_user_profiles_enabled ON wechat_user_profiles(enabled, from_user)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_audit_logs_action_time ON audit_logs(action, created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_time ON audit_logs(entity_type, entity_id, created_at DESC)');
  await migratePlainApiKeysToEncrypted();
}

function categoryCode(name = '') {
  const base = String(name || '').trim().toLowerCase();
  const code = base.replace(/[^a-z0-9\u4e00-\u9fa5]+/gu, '-').replace(/^-+|-+$/g, '');
  return code || `cat-${Date.now()}`;
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function localFitnessAdvice(entry) {
  const parts = [];
  if (entry.entry_type === 'weight') {
    parts.push(`本次记录体重 ${entry.weight_kg || '--'}kg。`);
    parts.push('建议结合 7 天趋势看变化，不要只看单次波动。');
  }
  if (entry.entry_type === 'meal') {
    parts.push(`本次饮食：${entry.food_text || '未填写具体食物'}。`);
    parts.push('建议优先保证蛋白质和蔬菜，控制高油高糖食物频率。');
  }
  if (entry.entry_type === 'workout') {
    parts.push(`本次运动：${entry.workout_text || entry.workout_type || '未填写具体运动'}。`);
    parts.push('建议运动后补水，力量训练后注意恢复和睡眠。');
  }
  if (entry.entry_type === 'sleep') {
    parts.push(`本次睡眠：${entry.sleep_hours || '--'} 小时，质量 ${entry.sleep_quality || '未填写'}。`);
    parts.push('建议保持固定入睡时间，训练日尤其要保证恢复。');
  }
  return {
    summary: parts[0] || '已记录。',
    advice: parts.slice(1).join(' ') || '保持稳定记录，后续根据趋势调整。',
    risk_level: 'normal',
  };
}

async function deepseekApiKey() {
  const result = await pool.query(`
    SELECT k.*
    FROM api_keys k JOIN providers p ON p.id=k.provider_id
    WHERE p.code='deepseek' AND k.status='active'
    ORDER BY k.updated_at DESC, k.id DESC
    LIMIT 1`);
  return result.rows[0] ? decryptSecret(result.rows[0]) : '';
}

function fitnessPrompt(entry) {
  return `你是健身和饮食记录助手。请基于用户本次记录给出简洁建议，不做医疗诊断。输出 JSON，字段为 summary, advice, risk_level(normal|warn|bad)。记录如下：${JSON.stringify(entry)}`;
}

async function deepseekFitnessAdvice(entry) {
  const apiKey = await deepseekApiKey();
  if (!apiKey) throw new Error('DeepSeek Key not configured');
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: '你只返回严格 JSON，不要 Markdown。' },
        { role: 'user', content: fitnessPrompt(entry) },
      ],
      temperature: 0.3,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || `DeepSeek analyze failed: ${response.status}`);
  const content = body?.choices?.[0]?.message?.content || '';
  const parsed = JSON.parse(content.replace(/^```json\s*|\s*```$/g, '').trim());
  return {
    summary: String(parsed.summary || '').slice(0, 500) || '已完成分析。',
    advice: String(parsed.advice || '').slice(0, 1500) || '保持记录，观察趋势。',
    risk_level: ['normal', 'warn', 'bad'].includes(parsed.risk_level) ? parsed.risk_level : 'normal',
  };
}

function looksLikeQuery(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/[?？]$/.test(t)) return true;
  if (/^(你|请问|帮我|能不能|可以|麻烦)/.test(t)) return true;
  if (/多少|怎么|为什么|为何|咋|啥|哪|统计|汇总|查询|查一下|看看|分析|建议|趋势|对比|最近|上次|本月|这个月|上周|买了什么|花了多少|收入多少|体重多少|跑了多久|睡了多久/.test(t)) return true;
  if (/吗$|呢$/.test(t) && !/(?:\d{2,3}(?:\.\d{1,2})?)\s*(?:kg|公斤|斤)|\d+(?:\.\d{1,2})?\s*(?:元|块)|\d{1,3}\s*(?:分钟|min)|睡了?\D*\d/.test(t)) return true;
  return false;
}

function truncateWechatReply(text, maxLen = 600) {
  const s = String(text || '').trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 3)}...`;
}

function formatFitnessContextRow(row) {
  const day = row.recorded_at ? new Date(row.recorded_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';
  if (row.entry_type === 'weight') return `${day} 体重 ${row.weight_kg}kg`;
  if (row.entry_type === 'sleep') return `${day} 睡眠 ${row.sleep_hours}小时 (${row.sleep_quality || '一般'})`;
  if (row.entry_type === 'workout') return `${day} ${row.workout_type || '运动'} ${row.duration_min || 0}分钟，约消耗${row.burned_calories || 0}千卡`;
  if (row.entry_type === 'meal') return `${day} ${row.meal_type || '饮食'}：${row.food_text || row.note || ''}，约${row.calories || 0}千卡`;
  return `${day} ${row.note || row.entry_type}`;
}

function formatFinanceContextRow(row) {
  const day = row.occurred_at ? new Date(row.occurred_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';
  const label = row.direction === 'income' ? '收入' : '支出';
  return `${day} ${label} ¥${Number(row.amount).toFixed(2)} ${row.title}（${row.category}）`;
}

async function buildWechatUserContext(fromUser, { light = false } = {}) {
  const monthQuery = pool.query(`
    SELECT
      COALESCE(SUM(amount) FILTER (WHERE direction='expense'), 0)::float expense,
      COALESCE(SUM(amount) FILTER (WHERE direction='income'), 0)::float income
    FROM finance_entries
    WHERE occurred_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
      AND ($1::text IS NULL OR source_user=$1 OR source_user IS NULL)`, [fromUser || null]);
  const weightQuery = pool.query(`
    SELECT weight_kg, recorded_at
    FROM fitness_entries
    WHERE entry_type='weight' AND weight_kg IS NOT NULL
      AND ($1::text IS NULL OR source_user=$1 OR source_user IS NULL)
    ORDER BY recorded_at DESC
    LIMIT 1`, [fromUser || null]);
  if (light) {
    const [monthStats, latestWeight] = await Promise.all([monthQuery, weightQuery]);
    const expense = Number(monthStats.rows[0]?.expense || 0);
    const income = Number(monthStats.rows[0]?.income || 0);
    const lines = [`本月收支：收入 ¥${income.toFixed(2)}，支出 ¥${expense.toFixed(2)}，结余 ¥${(income - expense).toFixed(2)}`];
    if (latestWeight.rows[0]) {
      const w = latestWeight.rows[0];
      lines.unshift(`最新体重：${w.weight_kg}kg（${new Date(w.recorded_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）`);
    }
    return lines.join('\n');
  }
  const [fitness, finance, monthStats, latestWeight] = await Promise.all([
    pool.query(`
      SELECT entry_type, recorded_at, weight_kg, meal_type, food_text, calories, workout_type,
             duration_min, burned_calories, sleep_hours, sleep_quality, note
      FROM fitness_entries
      WHERE ($1::text IS NULL OR source_user=$1 OR source_user IS NULL)
      ORDER BY recorded_at DESC, id DESC
      LIMIT 25`, [fromUser || null]),
    pool.query(`
      SELECT direction, amount, category, title, occurred_at
      FROM finance_entries
      WHERE ($1::text IS NULL OR source_user=$1 OR source_user IS NULL)
      ORDER BY occurred_at DESC, id DESC
      LIMIT 25`, [fromUser || null]),
    monthQuery,
    weightQuery,
  ]);
  const lines = [];
  if (latestWeight.rows[0]) {
    const w = latestWeight.rows[0];
    lines.push(`最新体重：${w.weight_kg}kg（${new Date(w.recorded_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）`);
  }
  if (fitness.rows.length) {
    lines.push('近期健康记录：');
    fitness.rows.slice().reverse().forEach((row) => lines.push(`- ${formatFitnessContextRow(row)}`));
  } else {
    lines.push('近期健康记录：暂无');
  }
  const expense = Number(monthStats.rows[0]?.expense || 0);
  const income = Number(monthStats.rows[0]?.income || 0);
  lines.push(`本月收支：收入 ¥${income.toFixed(2)}，支出 ¥${expense.toFixed(2)}，结余 ¥${(income - expense).toFixed(2)}`);
  if (finance.rows.length) {
    lines.push('近期账本：');
    finance.rows.slice().reverse().forEach((row) => lines.push(`- ${formatFinanceContextRow(row)}`));
  } else {
    lines.push('近期账本：暂无');
  }
  return lines.join('\n');
}

async function buildAssistantMemoryContext(fromUser, limit = 30) {
  const result = await pool.query(`
    SELECT id, category, content, importance, pinned, updated_at
    FROM assistant_memories
    WHERE ($1::text IS NULL OR from_user=$1 OR from_user IS NULL)
      AND category <> 'knowledge_upload_target'
    ORDER BY pinned DESC, importance DESC, updated_at DESC
    LIMIT $2`, [fromUser || null, limit]);
  if (!result.rows.length) return '暂无长期记忆';
  return result.rows.map((row) => `- [${row.category}/重要度${row.importance}] ${row.content}`).join('\n');
}

async function buildRecentWechatContext(fromUser, limit = 8) {
  const result = await pool.query(`
    SELECT id, content, intent, parse_status, reply_text, finance_entry_id, fitness_entry_id, received_at
    FROM wechat_messages
    WHERE ($1::text IS NULL OR from_user=$1)
    ORDER BY received_at DESC, id DESC
    LIMIT $2`, [fromUser || null, limit]);
  if (!result.rows.length) return '暂无最近对话';
  return result.rows.reverse().map((row) => `- #${row.id} 用户：${row.content || '[非文本]'}；处理：${row.intent}/${row.parse_status}；回复：${String(row.reply_text || '').slice(0, 80)}`).join('\n');
}

function likeQuery(text) {
  return `%${String(text || '').trim().replace(/[%_]/g, '')}%`;
}

async function globalSearch(query, { fromUser = null, kbId = null, limit = 6 } = {}) {
  const clean = String(query || '').trim();
  const like = likeQuery(clean);
  const safeLimit = Math.min(20, Math.max(3, Number(limit || 6)));
  const broad = !clean || /这个月|本月|最近|趋势|总结|分析|花.*多|消费|体重|睡眠|运动|任务|提醒/.test(clean);
  const [knowledge, finance, fitness, memories, tasks, wechat, reports] = await Promise.all([
    clean ? searchKnowledge(kbId, clean, safeLimit).catch(() => []) : Promise.resolve([]),
    pool.query(`
      SELECT id, direction, amount, category, title, note, occurred_at
      FROM finance_entries
      WHERE ($2::text IS NULL OR source_user=$2 OR source_user IS NULL)
        AND ($4::boolean OR title ILIKE $1 OR note ILIKE $1 OR category ILIKE $1 OR raw_message ILIKE $1)
        AND ($4::boolean=false OR occurred_at >= now() - interval '90 days')
      ORDER BY occurred_at DESC LIMIT $3`, [like, fromUser || null, safeLimit, broad]),
    pool.query(`
      SELECT id, entry_type, recorded_at, weight_kg, meal_type, food_text, workout_type, duration_min, sleep_hours, note
      FROM fitness_entries
      WHERE ($2::text IS NULL OR source_user=$2 OR source_user IS NULL)
        AND ($4::boolean OR entry_type ILIKE $1 OR meal_type ILIKE $1 OR food_text ILIKE $1 OR workout_type ILIKE $1 OR note ILIKE $1)
        AND ($4::boolean=false OR recorded_at >= now() - interval '90 days')
      ORDER BY recorded_at DESC LIMIT $3`, [like, fromUser || null, safeLimit, broad]),
    pool.query(`
      SELECT id, category, content, importance, pinned, updated_at
      FROM assistant_memories
      WHERE ($2::text IS NULL OR from_user=$2 OR from_user IS NULL)
        AND category <> 'knowledge_upload_target'
        AND ($4::boolean OR content ILIKE $1 OR category ILIKE $1)
      ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT $3`, [like, fromUser || null, safeLimit, broad]),
    pool.query(`
      SELECT id, title, note, status, remind_at, recurrence, created_at
      FROM assistant_tasks
      WHERE ($2::text IS NULL OR from_user=$2 OR from_user IS NULL)
        AND ($4::boolean OR title ILIKE $1 OR note ILIKE $1 OR status ILIKE $1)
      ORDER BY COALESCE(remind_at, created_at) DESC LIMIT $3`, [like, fromUser || null, safeLimit, broad]),
    pool.query(`
      SELECT id, content, intent, parse_status, reply_text, received_at
      FROM wechat_messages
      WHERE ($2::text IS NULL OR from_user=$2)
        AND ($4::boolean OR content ILIKE $1 OR intent ILIKE $1 OR reply_text ILIKE $1)
      ORDER BY received_at DESC LIMIT $3`, [like, fromUser || null, safeLimit, broad]),
    pool.query(`
      SELECT id, report_type, title, content, created_at
      FROM assistant_reports
      WHERE ($2::text IS NULL OR from_user=$2 OR from_user IS NULL)
        AND ($4::boolean OR title ILIKE $1 OR content ILIKE $1 OR report_type ILIKE $1)
      ORDER BY created_at DESC LIMIT $3`, [like, fromUser || null, safeLimit, broad]),
  ]);
  const groups = {
    knowledge: knowledge.map((row) => ({ type: 'knowledge', id: row.chunk_id || row.id, title: row.document_title || row.filename || '知识片段', preview: row.content, time: row.created_at, meta: `chunk ${row.chunk_index}` })),
    finance: finance.rows.map((row) => ({ type: 'finance', id: row.id, title: `${row.direction === 'income' ? '收入' : '支出'} ¥${Number(row.amount).toFixed(2)} ${row.title}`, preview: `${row.category} ${row.note || ''}`.trim(), time: row.occurred_at, meta: row.category })),
    fitness: fitness.rows.map((row) => ({ type: 'fitness', id: row.id, title: formatFitnessContextRow(row), preview: row.note || row.food_text || '', time: row.recorded_at, meta: row.entry_type })),
    memories: memories.rows.map((row) => ({ type: 'memory', id: row.id, title: row.content, preview: `重要度 ${row.importance}`, time: row.updated_at, meta: row.category })),
    tasks: tasks.rows.map((row) => ({ type: 'task', id: row.id, title: row.title, preview: row.note || '', time: row.remind_at || row.created_at, meta: `${row.status}/${row.recurrence}` })),
    wechat: wechat.rows.map((row) => ({ type: 'wechat', id: row.id, title: row.content || row.intent, preview: row.reply_text || '', time: row.received_at, meta: `${row.intent}/${row.parse_status}` })),
    reports: reports.rows.map((row) => ({ type: 'report', id: row.id, title: row.title, preview: String(row.content || '').slice(0, 240), time: row.created_at, meta: row.report_type })),
  };
  return { query: clean, groups, items: Object.values(groups).flat().sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0)) };
}

function formatGlobalSearchContext(bundle, maxItems = 14) {
  const items = (bundle?.items || []).slice(0, maxItems);
  if (!items.length) return '暂无全局搜索结果';
  return items.map((item, index) => `【全局${index + 1}/${item.type}】${item.title}\n${String(item.preview || '').slice(0, 260)}\n${item.meta || ''}`).join('\n\n');
}

async function buildPersonalProfile(fromUser = null) {
  const [memories, finance, fitness, tasks, reports] = await Promise.all([
    pool.query(`SELECT category, content, importance, pinned, updated_at FROM assistant_memories WHERE ($1::text IS NULL OR from_user=$1 OR from_user IS NULL) AND category <> 'knowledge_upload_target' ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT 60`, [fromUser || null]),
    pool.query(`SELECT category, direction, COUNT(*)::int count, COALESCE(SUM(amount),0)::float amount FROM finance_entries WHERE ($1::text IS NULL OR source_user=$1 OR source_user IS NULL) GROUP BY category,direction ORDER BY amount DESC LIMIT 20`, [fromUser || null]),
    pool.query(`SELECT entry_type, COUNT(*)::int count, MAX(recorded_at) latest FROM fitness_entries WHERE ($1::text IS NULL OR source_user=$1 OR source_user IS NULL) GROUP BY entry_type`, [fromUser || null]),
    pool.query(`SELECT status, COUNT(*)::int count FROM assistant_tasks WHERE ($1::text IS NULL OR from_user=$1 OR from_user IS NULL) GROUP BY status`, [fromUser || null]),
    pool.query(`SELECT report_type, title, created_at FROM assistant_reports WHERE ($1::text IS NULL OR from_user=$1 OR from_user IS NULL) ORDER BY created_at DESC LIMIT 5`, [fromUser || null]),
  ]);
  const lines = [];
  if (memories.rows.length) lines.push('长期记忆：', ...memories.rows.slice(0, 12).map((m) => `- [${m.category}/重要度${m.importance}] ${m.content}`));
  if (finance.rows.length) lines.push('消费/收入画像：', ...finance.rows.slice(0, 10).map((f) => `- ${f.direction === 'income' ? '收入' : '支出'} ${f.category}: ${f.count} 笔，¥${Number(f.amount).toFixed(2)}`));
  if (fitness.rows.length) lines.push('健康记录画像：', ...fitness.rows.map((f) => `- ${f.entry_type}: ${f.count} 条，最近 ${formatShanghaiDateTime(f.latest)}`));
  if (tasks.rows.length) lines.push('任务状态：', ...tasks.rows.map((t) => `- ${t.status}: ${t.count} 条`));
  return { from_user: fromUser, summary: lines.join('\n') || '暂无足够数据生成画像', memories: memories.rows, finance: finance.rows, fitness: fitness.rows, tasks: tasks.rows, reports: reports.rows };
}

async function deepseekGlobalAnswer(question, bundle, profile) {
  const apiKey = await deepseekApiKey();
  const context = formatGlobalSearchContext(bundle, 18);
  if (!apiKey) return `暂未配置 AI。已找到 ${bundle.items.length} 条相关数据。\n\n${context}`;
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: '你是个人数据中枢助手。根据全局搜索结果和个人画像回答问题。优先跨账本、健康、知识库、任务、企业微信消息、报告做综合分析；能计算趋势就给结论和依据；必须说明引用了哪些类型的数据，不要编造未提供的事实。回答适合手机阅读，先给结论，再给依据和建议。' },
        { role: 'user', content: `问题：${question}\n\n【个人画像】\n${profile?.summary || '暂无'}\n\n【全局搜索结果】\n${context}` },
      ],
      temperature: 0.35,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || `DeepSeek global answer failed: ${response.status}`);
  return body?.choices?.[0]?.message?.content || '没有生成回答。';
}

const BACKUP_TABLES = ['providers','api_keys','models','usage_logs','fitness_entries','fitness_ai_reports','knowledge_bases','knowledge_categories','knowledge_documents','knowledge_chunks','knowledge_queries','finance_entries','wechat_messages','assistant_answer_cache','assistant_memories','assistant_tasks','assistant_reports','assistant_report_subscriptions','assistant_goals','assistant_rules','pending_media_messages','wechat_user_profiles','audit_logs'];

async function exportBackup() {
  const data = {};
  for (const table of BACKUP_TABLES) data[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY id ASC`)).rows;
  return { exported_at: new Date().toISOString(), version: 1, tables: data };
}

async function previewBackupImport(bundle = {}) {
  const tables = bundle.tables || {};
  const result = { exported_at: bundle.exported_at || null, version: bundle.version || null, tables: {}, warnings: [] };
  for (const table of BACKUP_TABLES) {
    const rows = Array.isArray(tables[table]) ? tables[table] : [];
    let existing = 0;
    let conflicts = 0;
    if (rows.length) {
      existing = Number((await pool.query(`SELECT COUNT(*)::int count FROM ${table}`)).rows[0].count || 0);
      const ids = rows.map((row) => Number(row.id)).filter(Boolean);
      if (ids.length) conflicts = Number((await pool.query(`SELECT COUNT(*)::int count FROM ${table} WHERE id=ANY($1::int[])`, [ids])).rows[0].count || 0);
    }
    result.tables[table] = { incoming: rows.length, existing, conflicts, insertable: Math.max(0, rows.length - conflicts) };
  }
  if (!bundle.tables || typeof bundle.tables !== 'object') result.warnings.push('备份文件缺少 tables 字段');
  return result;
}

async function importBackup(bundle = {}, { mode = 'skip' } = {}) {
  const tables = bundle.tables || {};
  if (!tables || typeof tables !== 'object') throw new Error('无效备份文件：缺少 tables');
  const client = await pool.connect();
  const summary = {};
  try {
    await client.query('BEGIN');
    for (const table of BACKUP_TABLES) {
      const rows = Array.isArray(tables[table]) ? tables[table] : [];
      let inserted = 0;
      let skipped = 0;
      let replaced = 0;
      for (const row of rows) {
        const columns = Object.keys(row).filter((key) => row[key] !== undefined);
        if (!columns.length) continue;
        const placeholders = columns.map((_, index) => `$${index + 1}`).join(',');
        const values = columns.map((key) => row[key]);
        const updateColumns = columns.filter((key) => key !== 'id');
        const conflictSql = mode === 'replace' && updateColumns.length
          ? `DO UPDATE SET ${updateColumns.map((key) => `"${key}"=EXCLUDED."${key}"`).join(',')}`
          : 'DO NOTHING';
        const sql = `INSERT INTO ${table} (${columns.map((key) => `"${key}"`).join(',')}) VALUES (${placeholders}) ON CONFLICT (id) ${conflictSql}`;
        const saved = await client.query(sql, values);
        if (saved.rowCount) inserted += 1;
        else skipped += 1;
        if (mode === 'replace' && saved.rowCount && row.id) replaced += 1;
      }
      const maxId = await client.query(`SELECT COALESCE(MAX(id),0)::int max_id FROM ${table}`);
      await client.query(`SELECT setval(pg_get_serial_sequence('${table}','id'), GREATEST($1, 1), true)`, [maxId.rows[0].max_id]);
      summary[table] = { incoming: rows.length, inserted, skipped, replaced };
    }
    await client.query('COMMIT');
    return { ok: true, mode, summary };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function listLocalBackups() {
  await mkdir(BACKUP_DIR, { recursive: true });
  const files = await readdir(BACKUP_DIR).catch(() => []);
  const rows = [];
  for (const file of files.filter((name) => name.endsWith('.json'))) {
    const filePath = path.join(BACKUP_DIR, file);
    const info = await stat(filePath).catch(() => null);
    if (info) rows.push({ file, path: filePath, size: info.size, created_at: info.birthtime, updated_at: info.mtime });
  }
  return rows.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
}

async function pruneLocalBackups() {
  const backups = await listLocalBackups();
  const keep = Math.max(1, AUTO_BACKUP_KEEP || 20);
  const removed = [];
  for (const backup of backups.slice(keep)) {
    await unlink(backup.path).catch(() => null);
    removed.push(backup.file);
  }
  return removed;
}

async function createLocalBackup({ reason = 'manual', notify = false } = {}) {
  const backup = await exportBackup();
  await mkdir(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `ai-key-hub-${reason}-${stamp}.json`;
  const filePath = path.join(BACKUP_DIR, file);
  await writeFile(filePath, JSON.stringify(backup, null, 2));
  const info = await stat(filePath);
  const removed = await pruneLocalBackups();
  const summary = { ok: true, file, path: filePath, size: info.size, tables: summarizeBackupTables(backup), removed };
  if (notify) {
    await notifyBySubscription('backup_success', `自动备份完成：${file}\n大小：${Math.round(info.size / 1024)}KB\n保留：${AUTO_BACKUP_KEEP} 份`).catch((error) => console.error('[backup] notify failed:', error.message));
  }
  return summary;
}

function summarizeBackupTables(backup) {
  return Object.fromEntries(Object.entries(backup.tables || {}).map(([table, rows]) => [table, Array.isArray(rows) ? rows.length : 0]));
}

let lastAutoBackup = null;
let lastFailedRetry = null;

async function runAutoBackup(reason = 'auto') {
  if (!AUTO_BACKUP_ENABLED) return { skipped: true, reason: 'auto backup disabled' };
  try {
    lastAutoBackup = await createLocalBackup({ reason, notify: reason === 'auto' });
    await systemEvent('backup.auto_success', { entityType: 'backup', entityId: lastAutoBackup.file, level: 'info', detail: { reason, size: lastAutoBackup.size, removed: lastAutoBackup.removed?.length || 0 } });
    console.log(`[backup] ${lastAutoBackup.file}`);
    return lastAutoBackup;
  } catch (error) {
    lastAutoBackup = { ok: false, error: error.message, checked_at: new Date().toISOString() };
    console.error('[backup] auto failed:', error.message);
    await systemEvent('backup.auto_failed', { entityType: 'backup', level: 'error', detail: { reason, error: error.message } });
    await notifyBySubscription('backup_failed', `自动备份失败：${error.message}`).catch(() => {});
    return lastAutoBackup;
  }
}

async function runFailedWechatRetry(reason = 'auto') {
  if (!WECHAT_FAILED_RETRY_ENABLED) return { skipped: true, reason: 'failed retry disabled' };
  try {
    lastFailedRetry = await retryFailedWechatMessages({ limit: 10, notify: WECHAT_FAILED_RETRY_NOTIFY });
    lastFailedRetry.checked_at = new Date().toISOString();
    await systemEvent('wechat.retry_checked', { entityType: 'wechat_retry', level: lastFailedRetry.rows?.some((row) => !row.ok) ? 'warn' : 'info', detail: { reason, processed: lastFailedRetry.processed, failed: lastFailedRetry.rows?.filter((row) => !row.ok).length || 0 } });
    if (lastFailedRetry.processed) console.log(`[wechat] retry ${lastFailedRetry.processed} failed messages`);
    return lastFailedRetry;
  } catch (error) {
    lastFailedRetry = { ok: false, error: error.message, checked_at: new Date().toISOString(), reason };
    console.error('[wechat] retry failed:', error.message);
    await systemEvent('wechat.retry_failed', { entityType: 'wechat_retry', level: 'error', detail: { reason, error: error.message } });
    await notifyBySubscription('system_error', `企业微信失败消息重试异常：${error.message}`).catch(() => {});
    return lastFailedRetry;
  }
}

function compactAssistantContext({ userContext = '', memoryContext = '', knowledgeSources = [], recentContext = '', understood = null, error = null } = {}) {
  const knowledge = knowledgeSources.map((item, index) => ({
    index: index + 1,
    title: item.title || item.document_title || item.metadata?.title || '',
    score: item.score ?? item.distance ?? null,
    preview: String(item.content || '').slice(0, 180),
  }));
  return {
    recent_context: String(recentContext || '').slice(0, 1200),
    user_context: String(userContext || '').slice(0, 1200),
    memory_context: String(memoryContext || '').slice(0, 1200),
    knowledge_sources: knowledge,
    ai_actions: Array.isArray(understood?.actions) ? understood.actions.map((action) => action.type).filter(Boolean) : [],
    ai_reply_preview: understood?.reply ? String(understood.reply).slice(0, 300) : '',
    error: error ? String(error.message || error).slice(0, 300) : '',
  };
}

function safeJsonFromAi(content) {
  const text = String(content || '').replace(/^```json\s*|\s*```$/g, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('AI did not return JSON');
  return JSON.parse(text.slice(start, end + 1));
}

async function deepseekUnderstandWechatMessage(message, userContext, memoryContext, knowledgeSources, recentContext = '') {
  const apiKey = await deepseekApiKey();
  if (!apiKey) return null;
  const kbContext = knowledgeSources.length
    ? knowledgeSources.map((item, index) => `【资料${index + 1}】${item.content}`).join('\n\n')
    : '暂无相关资料';
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: `你是一个企业微信里的个人 AI 助手，不是单一记账机器人。你要听懂用户任何自然语言，并决定是否要记录到系统。

能力：
1. 用户表达体重、饮食、训练、睡眠时，记录到 fitness。
2. 用户表达消费、收入、报销、转账、付款时，记录到 finance。
3. 用户表达偏好、身份信息、长期目标、重要事实、承诺、计划、习惯、项目背景等短句时，写入 memory。不要把“存入知识库/上传到知识库”当成 memory。
4. 用户要把一段资料正文写入知识库时，使用 knowledge 动作（会切分并向量入库）。用户只发文件时由系统处理，你无需输出 knowledge。
5. 用户只是提问、闲聊、要求总结时，直接回答；必要时结合个人记录、长期记忆和知识库。
6. 你可以同时执行多个动作，例如“我今天72kg，记住我想减到68kg”要同时记录 fitness 和 memory。
7. 用户要求“提醒我/明天/每周/每月/到点叫我”时，创建 task。
8. 用户说“刚才那条错了/删除上一条/不是18是28/分类改成项目成本”时，根据最近对话输出 correction 或 delete。
9. 用户要日报/周报/月报/总结时，输出 report。

必须只返回 JSON，不要返回 Markdown。格式：
{
  "reply": "给用户的简短回复，适合微信阅读，300字以内",
  "actions": [
    {"type":"fitness","entry_type":"weight|meal|workout|sleep","weight_kg":72.5,"food_text":"...","meal_type":"早餐|午餐|晚餐|加餐","workout_type":"跑步|力量|骑行|HIIT|其他","workout_text":"...","duration_min":30,"intensity":"低|中|高","sleep_hours":7,"sleep_quality":"良好|一般|较差","note":"原话或摘要"},
    {"type":"finance","direction":"expense|income","amount":18,"category":"餐饮|交通|项目/工具|健身|收入|未分类","title":"咖啡","note":"原话或摘要"},
    {"type":"memory","category":"preference|profile|goal|project|health|finance|general","content":"值得长期记住的一句话","importance":1-5},
    {"type":"knowledge","title":"文档标题","text":"要写入知识库的完整正文"},
    {"type":"task","title":"提醒事项","note":"补充说明","remind_at":"2026-07-07 09:00","recurrence":"none|daily|weekly|monthly"},
    {"type":"correction","target":"last|fitness|finance|memory|task","field":"amount|category|title|note|weight_kg|content|status","value":"新值"},
    {"type":"delete","target":"last|fitness|finance|memory|task"},
    {"type":"report","report_type":"daily|weekly|monthly","title":"报告标题"},
    {"type":"answer","topic":"general|fitness|finance|knowledge|memory"}
  ]
}
如果没有需要记录的内容，actions 可以只包含 answer。纠错/删除必须优先参考最近对话。不要编造金额、体重、时间等数字；资料不足就说明。所有 remind_at 使用东八区时间，格式 YYYY-MM-DD HH:mm。相对时间（如「1分钟后」「半小时后」）必须按【当前时间】推算，不要猜成次日。`,
        },
        {
          role: 'user',
          content: `用户消息：${message}

【当前东八区时间】
${formatShanghaiDateTime()}

【个人记录摘要】
${userContext || '暂无'}

【长期记忆】
${memoryContext || '暂无'}

【最近对话】
${recentContext || '暂无'}

【知识库资料】
${kbContext}`,
        },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || `DeepSeek understand failed: ${response.status}`);
  return safeJsonFromAi(body?.choices?.[0]?.message?.content || '{}');
}

async function deepseekWechatAssistant(question, userContext, knowledgeSources, globalContext = '') {
  const apiKey = await deepseekApiKey();
  if (!apiKey) {
    return userContext
      ? `暂未配置 AI。根据你的记录：\n${truncateWechatReply(userContext, 500)}`
      : '暂未配置 DeepSeek，无法进行智能回复。';
  }
  const kbContext = knowledgeSources.length
    ? knowledgeSources.map((item, index) => `【资料${index + 1}】${item.content}`).join('\n\n')
    : '（未检索到相关知识库资料）';
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: '你是企业微信个人助手。根据用户健康/账本记录和知识库资料回答问题，也能正常闲聊。只能基于提供的数据回答，不要编造数字。回答简洁友好，适合手机阅读，控制在 300 字以内。若资料不足请直接说明。',
        },
        {
          role: 'user',
          content: `用户问题：${question}\n\n【用户个人记录】\n${userContext || '暂无'}\n\n【知识库资料】\n${kbContext}\n\n【全局搜索结果：账本/健康/记忆/提醒/企微/报告】\n${globalContext || '暂无'}`,
        },
      ],
      temperature: 0.4,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || `DeepSeek chat failed: ${response.status}`);
  return body?.choices?.[0]?.message?.content || '暂时没有想好怎么回答，你可以换个问法试试。';
}

function classifyUsefulTopic(question, sources = []) {
  const t = String(question || '').trim();
  if (!t || t.length < 3) return null;
  if (/^(你好|您好|哈喽|在吗|在不在|谢谢|感谢|拜拜|再见|hi|hello|ok)[!?？。…~\s]*$/i.test(t)) return null;
  if (sources.length > 0) return 'knowledge';
  if (/体重|重量|称重|跑步|运动|健身|训练|游泳|骑行|hiit|睡眠|睡觉|睡了|饮食|吃了|餐|卡路里|消耗|bmi|跑了多久|睡了多久|体重多少|最近.*体重|体重.*趋势/.test(t)) return 'fitness';
  if (/花|买|支出|收入|工资|赚|账|消费|结余|花了|买了|到账|报销|收入多少|花了多少|买了什么|本月|这个月|最近.*花/.test(t)) return 'finance';
  return null;
}

function topicLabel(topic) {
  return { fitness: '健康', finance: '账本', knowledge: '知识库' }[topic] || '其他';
}

let knowledgeChunkCountCache = { kbId: null, count: 0, at: 0 };

async function getKnowledgeChunkCount(kbId) {
  const key = kbId ?? null;
  if (Date.now() - knowledgeChunkCountCache.at < 60000 && knowledgeChunkCountCache.kbId === key) {
    return knowledgeChunkCountCache.count;
  }
  const result = await pool.query(
    'SELECT COUNT(*)::int count FROM knowledge_chunks WHERE ($1::int IS NULL OR kb_id=$1)',
    [key]
  );
  knowledgeChunkCountCache = { kbId: key, count: result.rows[0].count, at: Date.now() };
  return knowledgeChunkCountCache.count;
}

function resetKnowledgeChunkCountCache() {
  knowledgeChunkCountCache.at = 0;
}

async function shouldSearchKnowledge(question, previewTopic = null) {
  const count = await getKnowledgeChunkCount(WECHAT_DEFAULT_KB_ID);
  if (!count) return false;
  const topic = previewTopic ?? classifyUsefulTopic(question, []);
  if (topic === 'fitness' || topic === 'finance') return false;
  if (/知识库|资料|文档|政策|手册|规定/.test(question)) return true;
  return topic === 'knowledge' || topic === null;
}

async function handleWechatChat(content, fromUser) {
  const userKb = await resolveUserKnowledgeBase(fromUser).catch(() => null);
  const kbId = userKb?.id || WECHAT_DEFAULT_KB_ID;
  const previewTopic = classifyUsefulTopic(content, []);
  if (previewTopic) {
    const cached = await getAssistantCache({
      question: content,
      channel: 'wechat',
      kbId,
      fromUser,
    });
    if (cached) {
      touchAssistantCache(cached.id).catch(() => {});
      return { answer: cached.answer, from_cache: true, cache_id: cached.id };
    }
  }
  const lightContext = !previewTopic && !looksLikeQuery(content);
  const searchKb = await shouldSearchKnowledge(content, previewTopic);
  const [userContext, knowledgeSources, globalBundle] = await Promise.all([
    buildWechatUserContext(fromUser, { light: lightContext }),
    searchKb ? searchKnowledge(kbId, content, 5) : Promise.resolve([]),
    globalSearch(content, { fromUser, kbId, limit: 5 }),
  ]);
  const topic = classifyUsefulTopic(content, knowledgeSources);
  const globalContext = formatGlobalSearchContext(globalBundle);
  const answer = await deepseekWechatAssistant(content, userContext, knowledgeSources, globalContext);
  const reply = truncateWechatReply(answer);
  if (topic) {
    await saveAssistantCache({
      question: content,
      answer: reply,
      channel: 'wechat',
      kbId,
      fromUser,
      topic,
      sources: knowledgeSources.map((item) => ({
        document_title: item.document_title,
        filename: item.filename,
        chunk_index: item.chunk_index,
        content: String(item.content || '').slice(0, 240),
      })),
      contextSnapshot: crypto.createHash('sha256').update(userContext).digest('hex').slice(0, 16),
    });
  }
  return { answer: reply, from_cache: false };
}

function normalizeQuestion(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function assistantCacheKey({ question, channel, kbId, fromUser }) {
  const raw = [normalizeQuestion(question), channel || 'wechat', String(kbId ?? ''), String(fromUser ?? '')].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function getAssistantCache({ question, channel, kbId, fromUser }) {
  const cacheKey = assistantCacheKey({ question, channel, kbId, fromUser });
  const result = await pool.query(`
    SELECT * FROM assistant_answer_cache
    WHERE cache_key=$1 AND (pinned=true OR expires_at IS NULL OR expires_at > now())`, [cacheKey]);
  return result.rows[0] || null;
}

async function touchAssistantCache(id) {
  await pool.query(`
    UPDATE assistant_answer_cache
    SET hit_count=hit_count+1, last_hit_at=now(), updated_at=now()
    WHERE id=$1`, [id]);
}

async function saveAssistantCache({
  question,
  answer,
  channel,
  kbId,
  fromUser,
  sources,
  contextSnapshot,
  pinned = false,
  topic = null,
}) {
  const cacheKey = assistantCacheKey({ question, channel, kbId, fromUser });
  const ttl = pinned
    ? ASSISTANT_CACHE_TTL_PINNED
    : (channel === 'wechat' ? ASSISTANT_CACHE_TTL_WECHAT : ASSISTANT_CACHE_TTL_WEB);
  const expiresAt = ttl > 0 ? new Date(Date.now() + ttl * 1000) : null;
  const result = await pool.query(`
    INSERT INTO assistant_answer_cache (
      cache_key, channel, kb_id, from_user, question, answer, sources, context_snapshot, pinned, expires_at, topic
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (cache_key) DO UPDATE SET
      answer=EXCLUDED.answer,
      sources=EXCLUDED.sources,
      context_snapshot=EXCLUDED.context_snapshot,
      pinned=EXCLUDED.pinned,
      expires_at=EXCLUDED.expires_at,
      topic=EXCLUDED.topic,
      updated_at=now()
    RETURNING *`,
    [
      cacheKey,
      channel,
      kbId || null,
      fromUser || null,
      question,
      answer,
      JSON.stringify(sources || []),
      contextSnapshot || '',
      pinned,
      expiresAt,
      topic,
    ]
  );
  return result.rows[0];
}

async function assistantMemoryBundle() {
  const [fitness, finance, monthStats, usefulCache, memories, tasks, reports] = await Promise.all([
    pool.query(`
      SELECT e.*, r.summary ai_summary
      FROM fitness_entries e
      LEFT JOIN LATERAL (
        SELECT summary FROM fitness_ai_reports r WHERE r.entry_id=e.id ORDER BY r.created_at DESC LIMIT 1
      ) r ON true
      ORDER BY e.recorded_at DESC, e.id DESC
      LIMIT 40`),
    pool.query('SELECT * FROM finance_entries ORDER BY occurred_at DESC, id DESC LIMIT 40'),
    pool.query(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE direction='expense'), 0)::float expense,
        COALESCE(SUM(amount) FILTER (WHERE direction='income'), 0)::float income
      FROM finance_entries
      WHERE occurred_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'`),
    pool.query(`
      SELECT c.*, b.name kb_name
      FROM assistant_answer_cache c
      LEFT JOIN knowledge_bases b ON b.id=c.kb_id
      WHERE c.topic IN ('fitness', 'finance', 'knowledge', 'memory')
      ORDER BY c.pinned DESC, c.hit_count DESC, c.updated_at DESC
      LIMIT 50`),
    pool.query(`
      SELECT * FROM assistant_memories
      WHERE category <> 'knowledge_upload_target'
      ORDER BY pinned DESC, importance DESC, updated_at DESC
      LIMIT 80`),
    pool.query("SELECT * FROM assistant_tasks WHERE status='pending' ORDER BY remind_at NULLS LAST, created_at DESC LIMIT 50"),
    pool.query('SELECT * FROM assistant_reports ORDER BY created_at DESC LIMIT 30'),
  ]);
  const expense = Number(monthStats.rows[0]?.expense || 0);
  const income = Number(monthStats.rows[0]?.income || 0);
  return {
    fitness: fitness.rows,
    finance: finance.rows,
    memories: memories.rows,
    tasks: tasks.rows,
    reports: reports.rows,
    useful_cache: usefulCache.rows,
    month_stats: { expense, income, balance: income - expense },
    counts: {
      fitness: fitness.rowCount,
      finance: finance.rowCount,
      memories: memories.rowCount,
      tasks: tasks.rowCount,
      reports: reports.rowCount,
      useful_cache: usefulCache.rowCount,
    },
  };
}

async function assistantCacheSummary() {
  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE topic IN ('fitness', 'finance', 'knowledge'))::int total,
      COUNT(*) FILTER (WHERE pinned=true)::int pinned,
      COUNT(*) FILTER (WHERE topic='fitness')::int fitness,
      COUNT(*) FILTER (WHERE topic='finance')::int finance,
      COUNT(*) FILTER (WHERE topic='knowledge')::int knowledge,
      COALESCE(SUM(hit_count) FILTER (WHERE topic IN ('fitness', 'finance', 'knowledge')),0)::int total_hits,
      COUNT(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at <= now() AND pinned=false)::int expired
    FROM assistant_answer_cache`);
  const records = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM fitness_entries) fitness_records,
      (SELECT COUNT(*)::int FROM finance_entries) finance_records`);
  return { ...result.rows[0], ...records.rows[0] };
}

async function dashboardMemoryBundle() {
  const [cacheHits, lifestyle, finance, monthStats, tasks] = await Promise.all([
    pool.query(`
      SELECT id, question, answer, topic, hit_count, last_hit_at, channel, pinned
      FROM assistant_answer_cache
      WHERE topic IN ('fitness', 'finance', 'knowledge') AND hit_count > 0
      ORDER BY last_hit_at DESC NULLS LAST, hit_count DESC, updated_at DESC
      LIMIT 15`),
    pool.query(`
      SELECT entry_type, recorded_at, weight_kg, meal_type, food_text, calories, sleep_hours, sleep_quality, note
      FROM fitness_entries
      WHERE entry_type IN ('weight', 'meal', 'sleep')
      ORDER BY recorded_at DESC, id DESC
      LIMIT 15`),
    pool.query(`
      SELECT direction, amount, category, title, occurred_at, note
      FROM finance_entries
      ORDER BY occurred_at DESC, id DESC
      LIMIT 15`),
    pool.query(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE direction='expense'), 0)::float expense,
        COALESCE(SUM(amount) FILTER (WHERE direction='income'), 0)::float income
      FROM finance_entries
      WHERE occurred_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'`),
    pool.query(`
      SELECT *
      FROM assistant_tasks
      WHERE status='pending'
      ORDER BY remind_at NULLS LAST, created_at DESC
      LIMIT 20`),
  ]);
  const expense = Number(monthStats.rows[0]?.expense || 0);
  const income = Number(monthStats.rows[0]?.income || 0);
  return {
    cache_hits: cacheHits.rows,
    lifestyle: lifestyle.rows,
    finance: finance.rows,
    tasks: tasks.rows,
    month_stats: { expense, income, balance: income - expense },
    counts: {
      cache_hits: cacheHits.rowCount,
      lifestyle: lifestyle.rowCount,
      finance: finance.rowCount,
      tasks: tasks.rowCount,
      tasks_due: tasks.rows.filter((row) => row.remind_at && new Date(row.remind_at).getTime() <= Date.now()).length,
    },
  };
}

async function invalidateAssistantCacheForUser(fromUser) {
  if (!fromUser) return;
  await pool.query(`
    DELETE FROM assistant_answer_cache
    WHERE channel='wechat' AND from_user=$1 AND pinned=false AND topic IN ('fitness', 'finance')`, [fromUser]);
}

async function deepseekKnowledgeAnswer(question, sources, globalContext = '') {
  const apiKey = await deepseekApiKey();
  if (!apiKey) throw new Error('DeepSeek Key not configured');
  const context = sources.map((item, index) => `【资料${index + 1}】${item.content}`).join('\n\n');
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: '你是个人数据中枢问答助手。优先根据知识库资料回答，也可以结合全局搜索到的账本、健康、记忆、提醒和企微消息。资料不足时明确说明。回答要简洁，并列出引用资料编号或全局来源。' },
        { role: 'user', content: `问题：${question}\n\n知识库资料：\n${context}\n\n全局搜索结果：\n${globalContext || '暂无'}` },
      ],
      temperature: 0.2,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || `DeepSeek ask failed: ${response.status}`);
  return body?.choices?.[0]?.message?.content || '没有生成答案。';
}

async function searchKnowledge(kbId, query, topK = 6) {
  try {
    const collection = await chromaCollection();
    const queryEmbedding = await embedQuery(query);
    if (!queryEmbedding) throw new Error('embedding unavailable');
    const result = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: topK,
      where: kbId ? { kb_id: Number(kbId) } : undefined,
    });
    const ids = result.metadatas?.[0]?.map((meta) => meta.chunk_id).filter(Boolean) || [];
    if (ids.length) {
      const rows = await pool.query(`
        SELECT c.*, d.title document_title, d.filename
        FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.doc_id
        WHERE c.id = ANY($1::int[])`, [ids]);
      const rowMap = new Map(rows.rows.map((row) => [row.id, row]));
      return ids.map((id, index) => ({ ...rowMap.get(id), score: result.distances?.[0]?.[index] ?? null })).filter((item) => item.id);
    }
  } catch (error) {
    console.error('[knowledge] chroma search failed:', error.message);
  }
  const result = await pool.query(`
    SELECT c.*, d.title document_title, d.filename,
           ts_rank_cd(to_tsvector('simple', c.content), plainto_tsquery('simple', $2)) score
    FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.doc_id
    WHERE ($1::int IS NULL OR c.kb_id=$1)
      AND (c.content ILIKE '%' || $2 || '%' OR to_tsvector('simple', c.content) @@ plainto_tsquery('simple', $2))
    ORDER BY score DESC NULLS LAST, c.id DESC
    LIMIT $3`, [kbId ? Number(kbId) : null, query, topK]);
  return result.rows;
}

function estimateMealNutrition(foodText = '') {
  const text = foodText.toLowerCase();
  const rules = [
    { pattern: /鸡胸|牛肉|鱼|虾|蛋|豆腐|protein|鸡蛋/, calories: 320, protein_g: 35, carbs_g: 8, fat_g: 12 },
    { pattern: /米饭|面|粉|馒头|面包|粥|土豆|红薯/, calories: 420, protein_g: 12, carbs_g: 78, fat_g: 6 },
    { pattern: /火锅|烧烤|炸|奶茶|蛋糕|披萨|汉堡/, calories: 850, protein_g: 28, carbs_g: 88, fat_g: 42 },
    { pattern: /沙拉|青菜|蔬菜|水果|苹果|香蕉/, calories: 220, protein_g: 5, carbs_g: 42, fat_g: 4 },
  ];
  const matched = rules.filter((rule) => rule.pattern.test(text));
  if (!matched.length) return { calories: 500, protein_g: 20, carbs_g: 55, fat_g: 18 };
  const total = matched.reduce((acc, item) => ({
    calories: acc.calories + item.calories,
    protein_g: acc.protein_g + item.protein_g,
    carbs_g: acc.carbs_g + item.carbs_g,
    fat_g: acc.fat_g + item.fat_g,
  }), { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
  return Object.fromEntries(Object.entries(total).map(([key, value]) => [key, Math.round(value / matched.length)]));
}

function estimateWorkoutBurn(workoutType = '', durationMin = 0, intensity = '中') {
  const base = { 力量: 6, 跑步: 10, 骑行: 8, HIIT: 12, 其他: 6 }[workoutType] || 6;
  const factor = { 低: 0.75, 中: 1, 高: 1.25 }[intensity] || 1;
  return Math.round(Number(durationMin || 0) * base * factor);
}

function chunkText(text, size = 900, overlap = 120) {
  const clean = String(text || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    const end = Math.min(clean.length, start + size);
    let slice = clean.slice(start, end);
    if (end < clean.length) {
      const breakAt = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf('。'), slice.lastIndexOf('.'));
      if (breakAt > size * 0.55) slice = slice.slice(0, breakAt + 1);
    }
    chunks.push(slice.trim());
    if (end >= clean.length) break;
    const nextStart = start + Math.max(1, slice.length - overlap);
    start = nextStart > start ? nextStart : end;
  }
  return chunks.filter(Boolean);
}

async function chromaCollection() {
  return chroma.getOrCreateCollection({ name: KNOWLEDGE_COLLECTION });
}

async function chromaHeartbeat() {
  try {
    const base = CHROMA_URL.replace(/\/$/, '');
    const response = await fetch(`${base}/api/v2/heartbeat`, { signal: AbortSignal.timeout(3000) });
    if (response.ok) return true;
    const legacy = await fetch(`${base}/api/v1/heartbeat`, { signal: AbortSignal.timeout(3000) });
    return legacy.ok;
  } catch (_) {
    return false;
  }
}

async function upsertChunksToChroma(chunks) {
  if (!chunks.length) return { ok: false, reason: 'empty chunks' };
  try {
    const collection = await chromaCollection();
    const embeddings = await embedTexts(chunks.map((chunk) => chunk.content));
    if (embeddings.length !== chunks.length) throw new Error('embedding count mismatch');
    await collection.upsert({
      ids: chunks.map((chunk) => chunk.embedding_id),
      embeddings,
      documents: chunks.map((chunk) => chunk.content),
      metadatas: chunks.map((chunk) => ({ kb_id: chunk.kb_id, doc_id: chunk.doc_id, chunk_id: chunk.id, chunk_index: chunk.chunk_index })),
    });
    return { ok: true, mode: USE_HASH_EMBEDDING ? 'hash' : 'transformers', model: USE_HASH_EMBEDDING ? 'hash-384' : EMBEDDING_MODEL };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

async function deleteChunksFromChroma(embeddingIds) {
  const ids = embeddingIds.filter(Boolean);
  if (!ids.length) return;
  try {
    const collection = await chromaCollection();
    await collection.delete({ ids });
  } catch (_) {
    // PostgreSQL remains the source of truth if Chroma is temporarily unavailable.
  }
}

async function parseDocumentBuffer(buffer, filename = '', sourceType = 'upload') {
  const ext = path.extname(filename).toLowerCase();
  if (sourceType === 'text' || ['.txt', '.md', '.json'].includes(ext)) return buffer.toString('utf8');
  if (ext === '.pdf') {
    const parser = new PDFParse({ data: buffer });
    try {
      const parsed = await parser.getText();
      return parsed.text || '';
    } finally {
      await parser.destroy();
    }
  }
  if (ext === '.docx') return (await mammoth.extractRawText({ buffer })).value;
  if (ext === '.csv') {
    const rows = csvParseSync(buffer.toString('utf8'), { relax_column_count: true });
    return rows.map((row) => row.join(' | ')).join('\n');
  }
  return buffer.toString('utf8');
}

async function processKnowledgeDocument(docId) {
  const docResult = await pool.query('SELECT * FROM knowledge_documents WHERE id=$1', [docId]);
  if (!docResult.rowCount) throw new Error('document not found');
  const doc = docResult.rows[0];
  const oldChunks = await pool.query('SELECT embedding_id FROM knowledge_chunks WHERE doc_id=$1', [docId]);
  await deleteChunksFromChroma(oldChunks.rows.map((row) => row.embedding_id));
  await pool.query('DELETE FROM knowledge_chunks WHERE doc_id=$1', [docId]);
  const pieces = chunkText(doc.raw_text);
  const inserted = [];
  for (let index = 0; index < pieces.length; index += 1) {
    const result = await pool.query(
      `INSERT INTO knowledge_chunks (kb_id, doc_id, chunk_index, content, char_count, embedding_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [doc.kb_id, doc.id, index, pieces[index], pieces[index].length, `kb${doc.kb_id}_doc${doc.id}_chunk${index}`]
    );
    inserted.push(result.rows[0]);
  }
  const chromaResult = await upsertChunksToChroma(inserted);
  await pool.query('UPDATE knowledge_documents SET status=$1,error_message=$2,updated_at=now() WHERE id=$3', [chromaResult.ok ? 'ready' : 'ready_pg_only', chromaResult.ok ? null : chromaResult.reason, docId]);
  resetKnowledgeChunkCountCache();
  return { chunks: inserted.length, chroma: chromaResult };
}

let wechatWorkTokenCache = { token: '', expiresAt: 0 };

async function getWechatWorkAccessToken() {
  if (!WECHAT_WORK_CORP_ID || !WECHAT_WORK_SECRET) throw new Error('未配置企业微信 CorpID 或 Secret');
  if (wechatWorkTokenCache.token && wechatWorkTokenCache.expiresAt > Date.now() + 60000) return wechatWorkTokenCache.token;
  const api = new URL('https://qyapi.weixin.qq.com/cgi-bin/gettoken');
  api.searchParams.set('corpid', WECHAT_WORK_CORP_ID);
  api.searchParams.set('corpsecret', WECHAT_WORK_SECRET);
  const response = await fetch(api);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.errcode) throw new Error(body.errmsg || `企业微信 access_token 获取失败：${response.status}`);
  wechatWorkTokenCache = { token: body.access_token, expiresAt: Date.now() + Number(body.expires_in || 7200) * 1000 };
  return wechatWorkTokenCache.token;
}

async function sendWechatWorkTextMessage(toUser, content) {
  if (!WECHAT_WORK_AGENT_ID) throw new Error('未配置 WECHAT_WORK_AGENT_ID');
  if (!toUser) throw new Error('缺少接收用户');
  const token = await getWechatWorkAccessToken();
  const response = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      touser: toUser,
      msgtype: 'text',
      agentid: WECHAT_WORK_AGENT_ID,
      text: { content: String(content || '').slice(0, 2000) },
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.errcode) {
    await systemEvent('wechat.push_failed', { entityType: 'wechat_push', entityId: toUser, level: 'error', detail: { to_user: toUser, errcode: body.errcode, errmsg: body.errmsg || `HTTP ${response.status}` } });
    throw new Error(body.errmsg || `企业微信发消息失败：${response.status}`);
  }
  await systemEvent('wechat.push_success', { entityType: 'wechat_push', entityId: toUser, level: 'info', detail: { to_user: toUser, msgtype: 'text' } });
  return body;
}

function computeNextRemindAt(current, recurrence) {
  const base = new Date(current);
  if (Number.isNaN(base.getTime())) return null;
  if (recurrence === 'daily') base.setDate(base.getDate() + 1);
  else if (recurrence === 'weekly') base.setDate(base.getDate() + 7);
  else if (recurrence === 'monthly') base.setMonth(base.getMonth() + 1);
  else return null;
  return base;
}

async function processDueAssistantTasks() {
  if (!WECHAT_WORK_AGENT_ID || !WECHAT_WORK_SECRET) {
    return { skipped: true, reason: 'wechat agent not configured', processed: 0, results: [] };
  }
  const due = await pool.query(`
    SELECT * FROM assistant_tasks
    WHERE status='pending'
      AND remind_at IS NOT NULL
      AND remind_at <= now()
      AND (last_notified_at IS NULL OR last_notified_at < remind_at)
    ORDER BY remind_at ASC
    LIMIT 20`);
  const results = [];
  for (const task of due.rows) {
    try {
      const text = `⏰ 提醒：${task.title}${task.note ? `\n${task.note}` : ''}`;
      if (task.from_user) await sendWechatWorkTextMessage(task.from_user, text);
      if (!task.recurrence || task.recurrence === 'none') {
        await pool.query(`
          UPDATE assistant_tasks
          SET status='done', completed_at=now(), last_notified_at=now(), updated_at=now()
          WHERE id=$1`, [task.id]);
      } else {
        const next = computeNextRemindAt(task.remind_at, task.recurrence);
        await pool.query(`
          UPDATE assistant_tasks
          SET remind_at=COALESCE($1, remind_at), last_notified_at=now(), updated_at=now()
          WHERE id=$2`, [next, task.id]);
      }
      results.push({ id: task.id, ok: true, user: task.from_user || null });
    } catch (error) {
      console.error(`[tasks] reminder ${task.id} failed:`, error.message);
      results.push({ id: task.id, ok: false, error: error.message });
    }
  }
  if (results.length) console.log(`[tasks] processed ${results.length} due reminders`);
  return { skipped: false, processed: results.length, results };
}

async function downloadWechatWorkMedia(mediaId) {
  if (!mediaId) throw new Error('缺少 MediaId');
  const token = await getWechatWorkAccessToken();
  const api = new URL('https://qyapi.weixin.qq.com/cgi-bin/media/get');
  api.searchParams.set('access_token', token);
  api.searchParams.set('media_id', mediaId);
  const response = await fetch(api);
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.errmsg || `企业微信素材下载失败：${response.status}`);
  }
  if (!response.ok) throw new Error(`企业微信素材下载失败：${response.status}`);
  const disposition = response.headers.get('content-disposition') || '';
  const filenameMatch = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    filename: filenameMatch ? decodeURIComponent(filenameMatch[1]) : `${mediaId}.dat`,
    contentType,
  };
}

async function ensureWechatDefaultKnowledgeBase() {
  if (WECHAT_DEFAULT_KB_ID) {
    const current = await pool.query('SELECT * FROM knowledge_bases WHERE id=$1', [WECHAT_DEFAULT_KB_ID]);
    if (current.rowCount) return current.rows[0];
  }
  const existing = await pool.query("SELECT * FROM knowledge_bases WHERE name='微信上传资料' ORDER BY id LIMIT 1");
  if (existing.rowCount) return existing.rows[0];
  const created = await pool.query(
    `INSERT INTO knowledge_bases (name, description, category, status)
     VALUES ('微信上传资料','企业微信上传的文档会自动进入这里','general','active') RETURNING *`
  );
  return created.rows[0];
}

async function getWechatUserProfile(fromUser) {
  if (!fromUser) return null;
  const result = await pool.query('SELECT * FROM wechat_user_profiles WHERE from_user=$1 AND enabled=true', [fromUser]);
  return result.rows[0] || null;
}

async function ensureWechatUserProfile(fromUser, data = {}) {
  const clean = String(fromUser || '').trim();
  if (!clean) throw new Error('from_user required');
  const result = await pool.query(
    `INSERT INTO wechat_user_profiles (from_user, display_name, default_kb_id, daily_report_time, weekly_report_time, weekly_report_weekday, media_fail_preference, enabled, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,true),$9)
     ON CONFLICT (from_user)
     DO UPDATE SET display_name=EXCLUDED.display_name, default_kb_id=EXCLUDED.default_kb_id, daily_report_time=EXCLUDED.daily_report_time,
       weekly_report_time=EXCLUDED.weekly_report_time, weekly_report_weekday=EXCLUDED.weekly_report_weekday,
       media_fail_preference=EXCLUDED.media_fail_preference, enabled=EXCLUDED.enabled, note=EXCLUDED.note, updated_at=now()
     RETURNING *`,
    [clean, data.display_name || '', data.default_kb_id || null, data.daily_report_time || '21:30', data.weekly_report_time || '09:00', Number(data.weekly_report_weekday ?? 1), data.media_fail_preference || 'ask', data.enabled === undefined ? true : Boolean(data.enabled), data.note || '']
  );
  return result.rows[0];
}

async function resolveUserKnowledgeBase(fromUser) {
  const profile = await getWechatUserProfile(fromUser);
  if (profile?.default_kb_id) {
    const kb = await pool.query('SELECT * FROM knowledge_bases WHERE id=$1', [profile.default_kb_id]);
    if (kb.rowCount) return kb.rows[0];
  }
  return ensureWechatDefaultKnowledgeBase();
}

async function findKnowledgeBaseByName(name) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  const exact = await pool.query('SELECT * FROM knowledge_bases WHERE name=$1 ORDER BY id LIMIT 1', [clean]);
  if (exact.rowCount) return exact.rows[0];
  const fuzzy = await pool.query(
    'SELECT * FROM knowledge_bases WHERE name ILIKE $1 ORDER BY id LIMIT 1',
    [`%${clean.replace(/[%_]/g, '')}%`]
  );
  return fuzzy.rows[0] || null;
}

async function findOrCreateKnowledgeBaseByName(name) {
  const clean = String(name || '').trim();
  if (!clean) return ensureWechatDefaultKnowledgeBase();
  const existing = await findKnowledgeBaseByName(clean);
  if (existing) return existing;
  const baseName = clean.endsWith('知识库') ? clean : `${clean}知识库`;
  const created = await pool.query(
    `INSERT INTO knowledge_bases (name, description, category, status)
     VALUES ($1, $2, 'general', 'active') RETURNING *`,
    [baseName, '企业微信指令自动创建']
  );
  return created.rows[0];
}

function parseKnowledgeTargetIntent(text) {
  const clean = String(text || '').trim();
  const match = clean.match(/(?:下一个|下一份|这个|这份)?(?:文件|文档|资料)?(?:保存|存入|上传|放)(?:到|进)?(.{0,30}?)(?:知识库|库)(?:里|中)?/);
  if (!match) return null;
  const target = (match[1] || '')
    .replace(/^(默认|这个|那个|我的|一个|的)/, '')
    .replace(/[，。,.!！?？\s]/g, '')
    .trim();
  return { target };
}

async function rememberNextKnowledgeUploadTarget(fromUser, content) {
  if (!fromUser) return null;
  const parsed = parseKnowledgeTargetIntent(content);
  if (!parsed) return null;
  const kb = parsed.target ? await findOrCreateKnowledgeBaseByName(parsed.target) : await resolveUserKnowledgeBase(fromUser);
  const uploadToken = crypto.randomBytes(18).toString('hex');
  const memory = await pool.query(
    `INSERT INTO assistant_memories (from_user, category, content, importance, source, pinned)
     VALUES ($1,'knowledge_upload_target',$2,4,'wechat',false) RETURNING *`,
    [fromUser, JSON.stringify({ kb_id: kb.id, kb_name: kb.name, requested: parsed.target || '默认知识库', upload_token: uploadToken, expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString() })]
  );
  return { kb, memory: memory.rows[0], upload_token: uploadToken };
}

async function consumeKnowledgeUploadToken(token) {
  const clean = String(token || '').trim();
  if (!/^[a-f0-9]{24,64}$/i.test(clean)) return null;
  const result = await pool.query(
    `SELECT * FROM assistant_memories
     WHERE category='knowledge_upload_target' AND content::jsonb->>'upload_token'=$1
     ORDER BY created_at DESC LIMIT 1`,
    [clean]
  );
  if (!result.rowCount) return null;
  const memory = result.rows[0];
  let data = {};
  try { data = JSON.parse(memory.content || '{}'); } catch (_) { data = {}; }
  if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) return null;
  const kb = data.kb_id ? await pool.query('SELECT * FROM knowledge_bases WHERE id=$1', [Number(data.kb_id)]) : null;
  return { memory, data, kb: kb?.rows?.[0] || await resolveUserKnowledgeBase(memory.from_user) };
}

async function claimKnowledgeUploadToken(token) {
  const target = await consumeKnowledgeUploadToken(token);
  if (!target) return null;
  const claimed = await pool.query('DELETE FROM assistant_memories WHERE id=$1 RETURNING *', [target.memory.id]);
  if (!claimed.rowCount) return null;
  return target;
}

async function consumeNextKnowledgeUploadTarget(fromUser) {
  if (!fromUser) return null;
  const result = await pool.query(
    `SELECT * FROM assistant_memories
     WHERE from_user=$1 AND category='knowledge_upload_target'
     ORDER BY created_at DESC LIMIT 1`,
    [fromUser]
  );
  if (!result.rowCount) return null;
  const memory = result.rows[0];
  await pool.query('DELETE FROM assistant_memories WHERE id=$1', [memory.id]);
  let data = {};
  try { data = JSON.parse(memory.content || '{}'); } catch (_) { data = {}; }
  if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) return null;
  if (!data.kb_id) return null;
  const kb = await pool.query('SELECT * FROM knowledge_bases WHERE id=$1', [Number(data.kb_id)]);
  return kb.rows[0] || null;
}

async function ingestTextToKnowledgeBase({ title, text, sourceType = 'wechat_text', sourceUser = null, kb = null, sourceNote = '' }) {
  const targetKb = kb || await resolveUserKnowledgeBase(sourceUser);
  const clean = String(text || '').trim();
  if (!clean) throw new Error('没有可写入的文本内容');
  const doc = await pool.query(
    `INSERT INTO knowledge_documents (kb_id, title, source_type, source_user, source_channel, source_note, raw_text, status)
     VALUES ($1, $2, $3, $4, 'wechat', $5, $6, 'processing') RETURNING *`,
    [targetKb.id, title || '企微文字资料', sourceType, sourceUser, sourceNote, clean]
  );
  const processed = await processKnowledgeDocument(doc.rows[0].id);
  return { kb: targetKb, document: doc.rows[0], processed };
}

async function importWechatWorkMediaToKnowledge(payload) {
  const kb = await consumeNextKnowledgeUploadTarget(payload.from_user) || await resolveUserKnowledgeBase(payload.from_user);
  const mediaId = payload.media_id || payload.MediaId || payload.raw_payload?.media_id || payload.raw_payload?.MediaId;
  const media = await downloadWechatWorkMedia(mediaId);
  const filename = payload.file_name || payload.FileName || payload.raw_payload?.file_name || payload.raw_payload?.FileName || media.filename || `${mediaId}.dat`;
  await mkdir(UPLOAD_DIR, { recursive: true });
  const safeName = `${Date.now()}_${filename}`.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, '_');
  const filePath = path.join(UPLOAD_DIR, safeName);
  await writeFile(filePath, media.buffer);
  const rawText = await parseDocumentBuffer(media.buffer, filename, 'upload');
  if (!rawText.trim()) throw new Error('文件没有解析出文本内容');
  const doc = await pool.query(
    `INSERT INTO knowledge_documents (kb_id,title,source_type,filename,file_path,source_user,source_channel,source_note,raw_text,status)
     VALUES ($1,$2,'wechat_upload',$3,$4,$5,'wechat',$6,$7,'processing') RETURNING *`,
    [kb.id, path.basename(filename), filename, filePath, payload.from_user || null, '企业微信文件上传', rawText]
  );
  const processed = await processKnowledgeDocument(doc.rows[0].id);
  return { kb, document: doc.rows[0], processed };
}

async function deleteKnowledgeDocument(docId) {
  const chunks = await pool.query('SELECT embedding_id FROM knowledge_chunks WHERE doc_id=$1', [docId]);
  await deleteChunksFromChroma(chunks.rows.map((row) => row.embedding_id));
  const result = await pool.query('DELETE FROM knowledge_documents WHERE id=$1', [docId]);
  resetKnowledgeChunkCountCache();
  return result.rowCount > 0;
}

async function deleteKnowledgeBase(kbId) {
  const chunks = await pool.query('SELECT embedding_id FROM knowledge_chunks WHERE kb_id=$1', [kbId]);
  await deleteChunksFromChroma(chunks.rows.map((row) => row.embedding_id));
  await pool.query('DELETE FROM knowledge_queries WHERE kb_id=$1', [kbId]);
  const result = await pool.query('DELETE FROM knowledge_bases WHERE id=$1', [kbId]);
  return result.rowCount > 0;
}

async function parseMultipart(req) {
  await mkdir(UPLOAD_DIR, { recursive: true });
  return new Promise((resolve, reject) => {
    const fields = {};
    const files = [];
    const busboy = Busboy({ headers: req.headers });
    busboy.on('field', (name, value) => { fields[name] = value; });
    busboy.on('file', (name, file, info) => {
      const chunks = [];
      file.on('data', (data) => chunks.push(data));
      file.on('end', () => {
        let filename = info.filename || '';
        if (/[ÃÂåæä]/.test(filename)) {
          try { filename = Buffer.from(filename, 'latin1').toString('utf8'); } catch (_) {}
        }
        files.push({ name, filename, mimeType: info.mimeType, buffer: Buffer.concat(chunks) });
      });
    });
    busboy.on('error', reject);
    busboy.on('finish', () => resolve({ fields, files }));
    req.pipe(busboy);
  });
}

function readTextBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function verifyWechatSignature(url) {
  const token = process.env.WECHAT_BOT_TOKEN || '';
  if (!token) return true;
  const signature = url.searchParams.get('signature') || '';
  const timestamp = url.searchParams.get('timestamp') || '';
  const nonce = url.searchParams.get('nonce') || '';
  const text = [token, timestamp, nonce].sort().join('');
  const digest = crypto.createHash('sha1').update(text).digest('hex');
  return digest === signature;
}

function wechatSha1(...items) {
  return crypto.createHash('sha1').update(items.map((item) => String(item || '')).sort().join('')).digest('hex');
}

function verifyWechatWorkSignature(url, encrypted) {
  if (!WECHAT_WORK_TOKEN) return true;
  const signature = url.searchParams.get('msg_signature') || '';
  const timestamp = url.searchParams.get('timestamp') || '';
  const nonce = url.searchParams.get('nonce') || '';
  return wechatSha1(WECHAT_WORK_TOKEN, timestamp, nonce, encrypted) === signature;
}

function wechatWorkAesKey() {
  if (!WECHAT_WORK_ENCODING_AES_KEY) throw new Error('WECHAT_WORK_ENCODING_AES_KEY not configured');
  return Buffer.from(`${WECHAT_WORK_ENCODING_AES_KEY}=`, 'base64');
}

function pkcs7Unpad(buffer) {
  const pad = buffer[buffer.length - 1];
  if (pad < 1 || pad > 32) return buffer;
  return buffer.subarray(0, buffer.length - pad);
}

function pkcs7Pad(buffer) {
  const blockSize = 32;
  const pad = blockSize - (buffer.length % blockSize || blockSize);
  return Buffer.concat([buffer, Buffer.alloc(pad, pad)]);
}

function decryptWechatWork(encrypted) {
  const aesKey = wechatWorkAesKey();
  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, aesKey.subarray(0, 16));
  decipher.setAutoPadding(false);
  const decrypted = pkcs7Unpad(Buffer.concat([decipher.update(encrypted, 'base64'), decipher.final()]));
  const xmlLength = decrypted.readUInt32BE(16);
  const xml = decrypted.subarray(20, 20 + xmlLength).toString('utf8');
  const receiveId = decrypted.subarray(20 + xmlLength).toString('utf8');
  if (WECHAT_WORK_CORP_ID && receiveId && receiveId !== WECHAT_WORK_CORP_ID) throw new Error('invalid receive id');
  return { xml, receiveId };
}

function encryptWechatWork(xml) {
  const aesKey = wechatWorkAesKey();
  const random = crypto.randomBytes(16);
  const xmlBuffer = Buffer.from(xml, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(xmlBuffer.length, 0);
  const receiveId = Buffer.from(WECHAT_WORK_CORP_ID || '', 'utf8');
  const plain = pkcs7Pad(Buffer.concat([random, length, xmlBuffer, receiveId]));
  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, aesKey.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64');
}

function wechatWorkReply(toUser, fromUser, content, url) {
  const xml = wechatTextReply(toUser, fromUser, content);
  if (!WECHAT_WORK_ENCODING_AES_KEY) return xml;
  const nonce = url.searchParams.get('nonce') || String(Date.now());
  const timestamp = String(Math.floor(Date.now() / 1000));
  const encrypt = encryptWechatWork(xml);
  const signature = wechatSha1(WECHAT_WORK_TOKEN, timestamp, nonce, encrypt);
  return `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt><MsgSignature><![CDATA[${signature}]]></MsgSignature><TimeStamp>${timestamp}</TimeStamp><Nonce><![CDATA[${nonce}]]></Nonce></xml>`;
}

function xmlValue(xml, tag) {
  const match = String(xml || '').match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return match ? (match[1] ?? match[2] ?? '').trim() : '';
}

function parseWechatXml(xml) {
  return {
    to_user: xmlValue(xml, 'ToUserName'),
    from_user: xmlValue(xml, 'FromUserName'),
    msg_type: xmlValue(xml, 'MsgType') || 'text',
    content: xmlValue(xml, 'Content'),
    media_id: xmlValue(xml, 'MediaId'),
    file_name: xmlValue(xml, 'FileName'),
    recognition: xmlValue(xml, 'Recognition'),
    pic_url: xmlValue(xml, 'PicUrl'),
    ocr_text: xmlValue(xml, 'OCRText') || xmlValue(xml, 'Text'),
    agent_id: xmlValue(xml, 'AgentID'),
    msg_id: xmlValue(xml, 'MsgId'),
  };
}

function wechatTextReply(toUser, fromUser, content) {
  return `<xml><ToUserName><![CDATA[${fromUser || ''}]]></ToUserName><FromUserName><![CDATA[${toUser || ''}]]></FromUserName><CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${content}]]></Content></xml>`;
}

function classifyFinanceCategory(text) {
  const rules = [
    [/咖啡|奶茶|饭|餐|面|米粉|外卖|早餐|午餐|晚餐|吃|水果|超市/, '餐饮'],
    [/打车|地铁|公交|高铁|机票|油费|停车|通勤/, '交通'],
    [/模型|api|服务器|云|域名|会员|软件|订阅/, '项目/工具'],
    [/健身|运动|蛋白粉|游泳|私教/, '健身'],
    [/工资|奖金|报销|收款|收入|到账|转账/, '收入'],
  ];
  return rules.find(([pattern]) => pattern.test(text))?.[1] || '未分类';
}

async function matchAssistantRule({ fromUser, ruleType, text }) {
  const result = await pool.query(
    `SELECT * FROM assistant_rules
     WHERE enabled=true AND rule_type=$1
       AND ($2::text IS NULL OR from_user=$2 OR from_user IS NULL)
     ORDER BY from_user NULLS LAST, priority ASC, updated_at DESC
     LIMIT 200`,
    [ruleType, fromUser || null]
  );
  const clean = String(text || '');
  const rule = result.rows.find((row) => row.pattern && clean.includes(row.pattern));
  if (rule) {
    await pool.query('UPDATE assistant_rules SET hit_count=hit_count+1, updated_at=now() WHERE id=$1', [rule.id]);
  }
  return rule || null;
}

function learnPatternFromText(text) {
  return String(text || '')
    .replace(/(?:我)?(?:今天|刚刚|刚才|昨天|前天|这次|那个|这个)/g, '')
    .replace(/(买了|买|花了|花|支出|消费|付款|付了|收入|收款|到账|工资|奖金|报销|元|块|¥|￥|rmb|RMB)/gi, ' ')
    .replace(/-?\d+(?:\.\d{1,2})?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 30);
}

async function saveAssistantRule({ fromUser = null, ruleType, pattern, value, priority = 50, source = 'manual' }) {
  const cleanPattern = String(pattern || '').trim();
  const cleanValue = String(value || '').trim();
  if (!cleanPattern || !cleanValue) return null;
  const result = await pool.query(
    `INSERT INTO assistant_rules (from_user, rule_type, pattern, value, priority, source)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (from_user, rule_type, pattern)
     DO UPDATE SET value=EXCLUDED.value, priority=LEAST(assistant_rules.priority, EXCLUDED.priority), source=EXCLUDED.source, enabled=true, updated_at=now()
     RETURNING *`,
    [fromUser || null, ruleType, cleanPattern, cleanValue, Number(priority || 50), source]
  );
  return result.rows[0];
}

async function savePendingMedia({ fromUser, toUser, msgType, mediaId, contentHint = '', rawPayload = {} }) {
  if (!fromUser || !msgType) return null;
  const result = await pool.query(
    `INSERT INTO pending_media_messages (from_user, to_user, msg_type, media_id, content_hint, raw_payload, status, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',now()+interval '10 minutes') RETURNING *`,
    [fromUser || null, toUser || null, msgType, mediaId || null, contentHint || '', JSON.stringify(rawPayload || {})]
  );
  return result.rows[0];
}

async function latestPendingMedia(fromUser) {
  if (!fromUser) return null;
  const result = await pool.query(
    `SELECT * FROM pending_media_messages
     WHERE from_user=$1 AND status='pending' AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1`,
    [fromUser]
  );
  return result.rows[0] || null;
}

function isMediaClarification(text) {
  const clean = String(text || '').trim();
  if (!clean) return false;
  return /这张|这图|图片|照片|截图|刚才|上面|语音|录音|那条|这个/.test(clean) || clean.length <= 80;
}

async function parseFinanceMessage(content, fromUser = null) {
  const text = String(content || '').trim();
  if (!text) return null;
  const amountMatch = text.match(/(?:¥|￥|rmb|RMB)?\s*(-?\d+(?:\.\d{1,2})?)\s*(?:元|块|rmb|RMB)?/);
  if (!amountMatch) return null;
  const amount = Math.abs(Number(amountMatch[1]));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const directionRule = await matchAssistantRule({ fromUser, ruleType: 'finance_direction', text });
  const isIncome = /收入|收款|到账|工资|奖金|报销|赚|入账|转入/.test(text) && !/买|花|支出|消费|付|付款/.test(text);
  const direction = directionRule?.value || (isIncome ? 'income' : 'expense');
  const categoryRule = await matchAssistantRule({ fromUser, ruleType: 'finance_category', text });
  const title = text
    .replace(/(?:我)?(?:今天|刚刚|刚才|昨天|前天)?/g, '')
    .replace(/(买了|买|花了|花|支出|消费|付款|付了|收入|收款|到账|工资|奖金|报销|元|块|¥|￥|rmb|RMB)/g, ' ')
    .replace(/-?\d+(?:\.\d{1,2})?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || (direction === 'income' ? '收入' : '支出');
  return {
    direction,
    amount,
    category: categoryRule?.value || classifyFinanceCategory(text),
    title,
    note: text,
    raw_message: text,
  };
}

function parseFitnessMessage(content) {
  const text = String(content || '').trim();
  if (!text) return null;
  const weight = text.match(/(?:体重|重量|称重)\D*(\d{2,3}(?:\.\d{1,2})?)\s*(?:kg|公斤|斤)?/i) || text.match(/(\d{2,3}(?:\.\d{1,2})?)\s*(?:kg|公斤)/i);
  if (weight) return { entry_type: 'weight', weight_kg: Number(weight[1]), note: text };
  const sleep = text.match(/(?:睡了|睡眠|睡觉)\D*(\d{1,2}(?:\.\d{1,2})?)\s*(?:小时|h)?/i);
  if (sleep) return { entry_type: 'sleep', sleep_hours: Number(sleep[1]), sleep_quality: /好|不错|良好/.test(text) ? '良好' : (/差|不好|失眠/.test(text) ? '较差' : '一般'), note: text };
  const workout = text.match(/(跑步|力量|骑行|游泳|HIIT|训练|健身|运动).*?(\d{1,3})\s*(?:分钟|min)/i) || text.match(/(\d{1,3})\s*(?:分钟|min).*?(跑步|力量|骑行|游泳|HIIT|训练|健身|运动)/i);
  if (workout) {
    const firstIsDuration = /^\d/.test(workout[1]);
    const duration = Number(firstIsDuration ? workout[1] : workout[2]);
    const type = firstIsDuration ? workout[2] : workout[1];
    return { entry_type: 'workout', workout_type: type === '训练' || type === '运动' || type === '健身' ? '其他' : type, workout_text: text, duration_min: duration, intensity: /高强度|很累|冲刺/.test(text) ? '高' : (/低强度|轻松/.test(text) ? '低' : '中'), note: text };
  }
  if (/吃了|吃|早餐|午餐|晚餐|加餐|喝了|饮食/.test(text) && !/花|元|块|¥|￥/.test(text)) {
    return { entry_type: 'meal', meal_type: /早餐/.test(text) ? '早餐' : (/午餐/.test(text) ? '午餐' : (/晚餐/.test(text) ? '晚餐' : '加餐')), food_text: text.replace(/^(我)?(今天|刚刚|刚才)?(吃了|吃|喝了)/, ''), note: text };
  }
  return null;
}

async function createFitnessEntry(data) {
  const mealEstimate = data.entry_type === 'meal' ? estimateMealNutrition(data.food_text || '') : {};
  const burnedCalories = data.entry_type === 'workout'
    ? estimateWorkoutBurn(data.workout_type, numberOrNull(data.duration_min), data.intensity)
    : null;
  const result = await pool.query(
    `INSERT INTO fitness_entries (
      entry_type, recorded_at, weight_kg, meal_type, food_text, calories, protein_g, carbs_g, fat_g,
      workout_type, workout_text, duration_min, intensity, burned_calories, sleep_hours, sleep_quality, note, source_user
    ) VALUES ($1,COALESCE($2::timestamp AT TIME ZONE 'Asia/Shanghai', now()),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
    RETURNING *`,
    [
      data.entry_type,
      data.recorded_at || null,
      numberOrNull(data.weight_kg),
      data.meal_type || null,
      data.food_text || null,
      mealEstimate.calories ?? null,
      mealEstimate.protein_g ?? null,
      mealEstimate.carbs_g ?? null,
      mealEstimate.fat_g ?? null,
      data.workout_type || null,
      data.workout_text || null,
      numberOrNull(data.duration_min),
      data.intensity || null,
      burnedCalories,
      numberOrNull(data.sleep_hours),
      data.sleep_quality || null,
      data.note || '',
      data.source_user || null,
    ]
  );
  const report = await createFitnessReport(result.rows[0]);
  return { entry: result.rows[0], report };
}

async function createFinanceEntry(data, fromUser, rawMessage) {
  const amount = numberOrNull(data.amount);
  if (!amount || amount <= 0) throw new Error('finance amount required');
  const directionRule = await matchAssistantRule({ fromUser, ruleType: 'finance_direction', text: rawMessage || data.note || data.title || '' });
  const categoryRule = await matchAssistantRule({ fromUser, ruleType: 'finance_category', text: rawMessage || data.note || data.title || '' });
  const direction = directionRule?.value === 'income' ? 'income' : (data.direction === 'income' ? 'income' : 'expense');
  const category = categoryRule?.value || data.category || '未分类';
  const result = await pool.query(
    `INSERT INTO finance_entries (direction, amount, category, title, note, source_user, raw_message)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [direction, amount, category, data.title || (direction === 'income' ? '收入' : '支出'), data.note || rawMessage || '', fromUser || null, rawMessage || '']
  );
  return result.rows[0];
}

async function saveAssistantMemory({ fromUser, category = 'general', content, importance = 3, source = 'wechat' }) {
  const clean = String(content || '').trim();
  if (!clean) return null;
  const result = await pool.query(
    `INSERT INTO assistant_memories (from_user, category, content, importance, source)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [fromUser || null, category || 'general', clean.slice(0, 1000), Math.max(1, Math.min(5, Number(importance || 3))), source]
  );
  return result.rows[0];
}

async function upsertProfileMemory({ fromUser, category, content, importance = 3, source = 'profile_auto' }) {
  const clean = String(content || '').trim();
  if (!clean) return null;
  const existing = await pool.query(
    `SELECT id FROM assistant_memories
     WHERE COALESCE(from_user,'')=COALESCE($1,'') AND category=$2 AND content=$3
     LIMIT 1`,
    [fromUser || null, category, clean]
  );
  if (existing.rowCount) {
    const updated = await pool.query('UPDATE assistant_memories SET importance=GREATEST(importance,$1), source=$2, updated_at=now() WHERE id=$3 RETURNING *', [importance, source, existing.rows[0].id]);
    return updated.rows[0];
  }
  return saveAssistantMemory({ fromUser, category, content: clean, importance, source });
}

async function autoUpdatePersonalProfile({ fromUser, financeEntry, fitnessEntry, tasks = [], memories = [], content = '' } = {}) {
  const writes = [];
  if (financeEntry) {
    writes.push(upsertProfileMemory({ fromUser, category: 'finance_profile', content: `常用消费分类：${financeEntry.category}`, importance: 3 }));
    if (Number(financeEntry.amount || 0) >= 100) writes.push(upsertProfileMemory({ fromUser, category: 'finance_profile', content: `较大${financeEntry.direction === 'income' ? '收入' : '支出'}关注：${financeEntry.title} ¥${Number(financeEntry.amount).toFixed(2)}`, importance: 4 }));
  }
  if (fitnessEntry) {
    if (fitnessEntry.entry_type === 'weight' && fitnessEntry.weight_kg) writes.push(upsertProfileMemory({ fromUser, category: 'fitness_profile', content: `最近体重记录：${Number(fitnessEntry.weight_kg).toFixed(1)}kg`, importance: 4 }));
    if (fitnessEntry.entry_type === 'sleep' && fitnessEntry.sleep_hours) writes.push(upsertProfileMemory({ fromUser, category: 'fitness_profile', content: `睡眠记录习惯：${Number(fitnessEntry.sleep_hours).toFixed(1)}小时`, importance: 3 }));
    if (fitnessEntry.entry_type === 'workout' && fitnessEntry.workout_type) writes.push(upsertProfileMemory({ fromUser, category: 'fitness_profile', content: `常见运动类型：${fitnessEntry.workout_type}`, importance: 3 }));
  }
  for (const task of tasks || []) writes.push(upsertProfileMemory({ fromUser, category: 'task_profile', content: `关注事项：${task.title}`, importance: 3 }));
  if (/服务器|项目|代码|部署|github|GitHub|知识库/.test(content)) writes.push(upsertProfileMemory({ fromUser, category: 'work_profile', content: `近期关注项目/工具：${String(content).slice(0, 80)}`, importance: 3 }));
  if (memories?.length) writes.push(upsertProfileMemory({ fromUser, category: 'memory_profile', content: `主动沉淀过长期记忆 ${memories.length} 条`, importance: 2 }));
  await Promise.all(writes);
}

function shanghaiTimestampOrNull(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text.replace('T', ' ');
}

const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function parseCnNumber(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  return CN_NUM[raw] ?? null;
}

function formatShanghaiDateTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function parseRelativeRemindAt(message) {
  const text = String(message || '');
  if (/半\s*小时(?:后|之内)?/.test(text)) return formatShanghaiDateTime(new Date(Date.now() + 30 * 60 * 1000));
  let match = text.match(/(\d+|一|二|两|三|四|五|六|七|八|九|十)\s*分钟(?:后|之内)?/);
  if (match) {
    const minutes = parseCnNumber(match[1]) || 1;
    return formatShanghaiDateTime(new Date(Date.now() + minutes * 60 * 1000));
  }
  match = text.match(/(\d+|一|二|两|三|四|五|六|七|八|九|十)\s*小时(?:后|之内)?/);
  if (match) {
    const hours = parseCnNumber(match[1]) || 1;
    return formatShanghaiDateTime(new Date(Date.now() + hours * 60 * 60 * 1000));
  }
  return null;
}

function resolveRemindAt(userMessage, aiRemindAt) {
  return parseRelativeRemindAt(userMessage) || shanghaiTimestampOrNull(aiRemindAt);
}

async function createAssistantTask(data, fromUser, userMessage = '') {
  const remindAt = resolveRemindAt(userMessage, data.remind_at);
  const result = await pool.query(
    `INSERT INTO assistant_tasks (from_user, title, note, remind_at, recurrence, status)
     VALUES ($1,$2,$3,CASE WHEN $4::text IS NULL THEN NULL ELSE $4::timestamp AT TIME ZONE 'Asia/Shanghai' END,$5,'pending') RETURNING *`,
    [fromUser || null, data.title || '提醒事项', data.note || '', remindAt, data.recurrence || 'none']
  );
  return result.rows[0];
}

async function latestLinkedMessage(fromUser, target = 'last') {
  const clauses = ["from_user=$1"];
  if (target === 'fitness') clauses.push('fitness_entry_id IS NOT NULL');
  if (target === 'finance') clauses.push('finance_entry_id IS NOT NULL');
  if (target === 'last') clauses.push('(finance_entry_id IS NOT NULL OR fitness_entry_id IS NOT NULL)');
  const result = await pool.query(`
    SELECT * FROM wechat_messages
    WHERE ${clauses.join(' AND ')}
    ORDER BY received_at DESC, id DESC
    LIMIT 1`, [fromUser || null]);
  return result.rows[0] || null;
}

async function applyCorrection(action, fromUser) {
  const target = action.target || 'last';
  const message = await latestLinkedMessage(fromUser, target);
  if (!message) return null;
  if (message.finance_entry_id) {
    const allowed = new Set(['amount', 'category', 'title', 'note']);
    if (!allowed.has(action.field)) return null;
    const value = action.field === 'amount' ? numberOrNull(action.value) : String(action.value || '');
    const result = await pool.query(`UPDATE finance_entries SET ${action.field}=$1 WHERE id=$2 RETURNING *`, [value, message.finance_entry_id]);
    let learnedRule = null;
    if (action.field === 'category') {
      const pattern = learnPatternFromText(message.content || result.rows[0]?.raw_message || result.rows[0]?.title || '');
      learnedRule = await saveAssistantRule({ fromUser, ruleType: 'finance_category', pattern, value, source: 'correction' });
    }
    return { type: 'finance', row: result.rows[0], rule: learnedRule };
  }
  if (message.fitness_entry_id) {
    const allowed = new Set(['weight_kg', 'food_text', 'workout_text', 'duration_min', 'sleep_hours', 'sleep_quality', 'note']);
    if (!allowed.has(action.field)) return null;
    const numeric = new Set(['weight_kg', 'duration_min', 'sleep_hours']);
    const value = numeric.has(action.field) ? numberOrNull(action.value) : String(action.value || '');
    const result = await pool.query(`UPDATE fitness_entries SET ${action.field}=$1 WHERE id=$2 RETURNING *`, [value, message.fitness_entry_id]);
    return { type: 'fitness', row: result.rows[0] };
  }
  return null;
}

async function applyDeleteAction(action, fromUser) {
  const target = action.target || 'last';
  const message = await latestLinkedMessage(fromUser, target);
  if (!message) return null;
  if (message.finance_entry_id) {
    await pool.query('UPDATE wechat_messages SET finance_entry_id=NULL WHERE finance_entry_id=$1', [message.finance_entry_id]);
    const result = await pool.query('DELETE FROM finance_entries WHERE id=$1 RETURNING *', [message.finance_entry_id]);
    return { type: 'finance', row: result.rows[0] };
  }
  if (message.fitness_entry_id) {
    await pool.query('UPDATE wechat_messages SET fitness_entry_id=NULL WHERE fitness_entry_id=$1', [message.fitness_entry_id]);
    const result = await pool.query('DELETE FROM fitness_entries WHERE id=$1 RETURNING *', [message.fitness_entry_id]);
    return { type: 'fitness', row: result.rows[0] };
  }
  return null;
}

async function buildReportText(reportType, fromUser) {
  const days = reportType === 'monthly' ? 31 : (reportType === 'weekly' ? 7 : 1);
  const [fitness, finance, goals] = await Promise.all([
    pool.query(`SELECT * FROM fitness_entries WHERE recorded_at >= now() - ($1 || ' days')::interval AND ($2::text IS NULL OR source_user=$2 OR source_user IS NULL) ORDER BY recorded_at ASC`, [days, fromUser || null]),
    pool.query(`SELECT * FROM finance_entries WHERE occurred_at >= now() - ($1 || ' days')::interval AND ($2::text IS NULL OR source_user=$2 OR source_user IS NULL) ORDER BY occurred_at ASC`, [days, fromUser || null]),
    pool.query(`SELECT * FROM assistant_goals WHERE enabled=true AND ($1::text IS NULL OR from_user=$1 OR from_user IS NULL) ORDER BY from_user NULLS LAST, goal_type`, [fromUser || null]),
  ]);
  const income = finance.rows.filter((row) => row.direction === 'income').reduce((sum, row) => sum + Number(row.amount), 0);
  const expense = finance.rows.filter((row) => row.direction === 'expense').reduce((sum, row) => sum + Number(row.amount), 0);
  const workouts = fitness.rows.filter((row) => row.entry_type === 'workout').reduce((sum, row) => sum + Number(row.duration_min || 0), 0);
  const weights = fitness.rows.filter((row) => row.entry_type === 'weight' && row.weight_kg);
  const title = { daily: '日报', weekly: '周报', monthly: '月报' }[reportType] || '报告';
  const lines = [
    `${title}：最近 ${days} 天`,
    `账本：收入 ¥${income.toFixed(2)}，支出 ¥${expense.toFixed(2)}，结余 ¥${(income - expense).toFixed(2)}。`,
    `健康：记录 ${fitness.rowCount} 条，运动 ${workouts} 分钟。`,
  ];
  if (weights.length) lines.push(`体重：${weights[0].weight_kg}kg → ${weights[weights.length - 1].weight_kg}kg。`);
  const goalLines = buildGoalStatusLines(goals.rows, { fitness: fitness.rows, finance: finance.rows });
  if (goalLines.length) lines.push('目标：', ...goalLines.map((line) => `- ${line}`));
  return lines.join('\n');
}

function buildGoalStatusLines(goals, data) {
  const lines = [];
  const fitness = data.fitness || [];
  const finance = data.finance || [];
  for (const goal of goals) {
    const target = Number(goal.target_value || 0);
    if (goal.goal_type === 'weight') {
      const latest = fitness.filter((row) => row.entry_type === 'weight' && row.weight_kg).at(-1);
      if (!latest) lines.push(`${goal.title}：暂无体重记录，目标 ${target}${goal.unit || 'kg'}`);
      else {
        const current = Number(latest.weight_kg);
        const diff = current - target;
        lines.push(`${goal.title}：当前 ${current.toFixed(1)}kg，目标 ${target.toFixed(1)}kg，${diff <= 0 ? '已达成' : `还差 ${diff.toFixed(1)}kg`}`);
      }
    }
    if (goal.goal_type === 'monthly_expense') {
      const expense = finance.filter((row) => row.direction === 'expense').reduce((sum, row) => sum + Number(row.amount), 0);
      lines.push(`${goal.title}：本期支出 ¥${expense.toFixed(2)} / 目标 ¥${target.toFixed(2)}，${expense <= target ? '未超预算' : `超出 ¥${(expense - target).toFixed(2)}`}`);
    }
    if (goal.goal_type === 'weekly_workout') {
      const count = fitness.filter((row) => row.entry_type === 'workout').length;
      lines.push(`${goal.title}：本期运动 ${count} 次 / 目标 ${target} 次，${count >= target ? '已达成' : `还差 ${target - count} 次`}`);
    }
    if (goal.goal_type === 'sleep') {
      const sleeps = fitness.filter((row) => row.entry_type === 'sleep' && row.sleep_hours);
      const avg = sleeps.length ? sleeps.reduce((sum, row) => sum + Number(row.sleep_hours), 0) / sleeps.length : 0;
      lines.push(`${goal.title}：平均睡眠 ${avg ? avg.toFixed(1) : '0'} 小时 / 目标 ${target} 小时，${avg >= target ? '已达成' : '未达成'}`);
    }
  }
  return lines;
}

async function createAssistantReport(action, fromUser) {
  const reportType = ['daily', 'weekly', 'monthly'].includes(action.report_type) ? action.report_type : 'daily';
  const content = await buildReportText(reportType, fromUser);
  const title = action.title || ({ daily: '日报', weekly: '周报', monthly: '月报' }[reportType] || '报告');
  const result = await pool.query(
    `INSERT INTO assistant_reports (from_user, report_type, title, content)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [fromUser || null, reportType, title, content]
  );
  return result.rows[0];
}

function shanghaiDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(value('weekday'));
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    time: `${value('hour')}:${value('minute')}`,
    weekday,
  };
}

function shouldSendReportSubscription(row, nowParts) {
  if (!row.enabled) return false;
  if (String(row.send_time || '').slice(0, 5) !== nowParts.time) return false;
  if (row.report_type === 'weekly' && row.weekday !== null && Number(row.weekday) !== nowParts.weekday) return false;
  if (!row.last_sent_at) return true;
  const last = shanghaiDateParts(new Date(row.last_sent_at));
  if (row.report_type === 'daily') return last.date !== nowParts.date;
  return last.date !== nowParts.date;
}

async function processDueReportSubscriptions() {
  if (!WECHAT_WORK_AGENT_ID || !WECHAT_WORK_SECRET) {
    return { skipped: true, reason: 'wechat agent not configured', processed: 0, results: [] };
  }
  const nowParts = shanghaiDateParts();
  const candidates = await pool.query(
    `SELECT * FROM assistant_report_subscriptions
     WHERE enabled=true AND send_time=$1
     ORDER BY id ASC
     LIMIT 50`,
    [nowParts.time]
  );
  const due = candidates.rows.filter((row) => shouldSendReportSubscription(row, nowParts));
  const results = [];
  for (const sub of due) {
    try {
      const report = await createAssistantReport({ report_type: sub.report_type }, sub.from_user);
      const title = sub.report_type === 'weekly' ? '📊 每周总结' : '📊 每日总结';
      await sendWechatWorkTextMessage(sub.from_user, `${title}\n${report.content}`);
      await pool.query('UPDATE assistant_report_subscriptions SET last_sent_at=now(), updated_at=now() WHERE id=$1', [sub.id]);
      results.push({ id: sub.id, ok: true, report_id: report.id, user: sub.from_user, type: sub.report_type });
    } catch (error) {
      console.error(`[reports] subscription ${sub.id} failed:`, error.message);
      results.push({ id: sub.id, ok: false, error: error.message });
    }
  }
  if (results.length) console.log(`[reports] processed ${results.length} report subscriptions`);
  return { skipped: false, processed: results.length, results };
}

async function executeAssistantActions(actions, content, fromUser) {
  const result = { financeEntry: null, fitnessEntry: null, memories: [], knowledgeDocuments: [], tasks: [], reports: [], corrections: [], deletions: [], intents: [] };
  for (const action of Array.isArray(actions) ? actions : []) {
    if (action?.type === 'fitness' && action.entry_type) {
      const created = await createFitnessEntry({ ...action, note: action.note || content, source_user: fromUser });
      result.fitnessEntry ||= created.entry;
      result.intents.push(`fitness.${action.entry_type}`);
      continue;
    }
    if (action?.type === 'finance') {
      const created = await createFinanceEntry(action, fromUser, content);
      result.financeEntry ||= created;
      result.intents.push(`finance.${created.direction}`);
      continue;
    }
    if (action?.type === 'memory') {
      const memory = await saveAssistantMemory({ fromUser, category: action.category, content: action.content, importance: action.importance });
      if (memory) {
        result.memories.push(memory);
        result.intents.push('memory.saved');
      }
      continue;
    }
    if (action?.type === 'knowledge') {
      const ingested = await ingestTextToKnowledgeBase({
        title: action.title || '企微文字资料',
        text: action.text || content,
        sourceType: 'wechat_text',
      });
      result.knowledgeDocuments.push(ingested);
      result.intents.push('knowledge.ingested');
      continue;
    }
    if (action?.type === 'task') {
      const task = await createAssistantTask(action, fromUser, content);
      result.tasks.push(task);
      result.intents.push('task.created');
      continue;
    }
    if (action?.type === 'correction') {
      const corrected = await applyCorrection(action, fromUser);
      if (corrected) {
        result.corrections.push(corrected);
        if (corrected.type === 'finance') result.financeEntry ||= corrected.row;
        if (corrected.type === 'fitness') result.fitnessEntry ||= corrected.row;
        result.intents.push(`${corrected.type}.corrected`);
      }
      continue;
    }
    if (action?.type === 'delete') {
      const deleted = await applyDeleteAction(action, fromUser);
      if (deleted) {
        result.deletions.push(deleted);
        result.intents.push(`${deleted.type}.deleted`);
      }
      continue;
    }
    if (action?.type === 'report') {
      const report = await createAssistantReport(action, fromUser);
      result.reports.push(report);
      result.intents.push(`report.${report.report_type}`);
    }
  }
  return result;
}

function actionReplySuffix(executed) {
  const parts = [];
  if (executed.fitnessEntry) parts.push('健康记录已保存');
  if (executed.financeEntry) parts.push(`${executed.financeEntry.direction === 'income' ? '收入' : '支出'}已保存`);
  if (executed.memories.length) parts.push(`已记住 ${executed.memories.length} 条长期记忆`);
  if (executed.knowledgeDocuments?.length) {
    const names = executed.knowledgeDocuments.map((item) => item.document?.title || '文档').join('、');
    const chunks = executed.knowledgeDocuments.reduce((sum, item) => sum + Number(item.processed?.chunks || 0), 0);
    parts.push(`已写入知识库：${names}（${chunks} 段）`);
  }
  if (executed.tasks.length) {
    const times = executed.tasks
      .map((task) => (task.remind_at ? formatShanghaiDateTime(new Date(task.remind_at)) : '未设时间'))
      .join('、');
    parts.push(`已创建 ${executed.tasks.length} 个提醒（${times}）`);
  }
  if (executed.corrections.length) parts.push('已按你的话修改');
  if (executed.deletions.length) parts.push('已删除对应记录');
  if (executed.reports.length) parts.push('报告已生成');
  return parts.length ? `\n\n${parts.join('，')}。` : '';
}

function buildWechatConfirmation({ messageId, intent, status, financeEntry, fitnessEntry, knowledgeDocument, tasks = [], memories = [] } = {}) {
  if (!['recorded', 'processing'].includes(status)) return '';
  const lines = [];
  if (financeEntry) lines.push(`账本：${financeEntry.direction === 'income' ? '收入' : '支出'} ¥${Number(financeEntry.amount).toFixed(2)}，${financeEntry.category}，${financeEntry.title}`);
  if (fitnessEntry) lines.push(`健康：${formatFitnessContextRow(fitnessEntry)}`);
  if (knowledgeDocument) lines.push(`知识库：${knowledgeDocument.title || knowledgeDocument.filename || `文档 #${knowledgeDocument.id}`}`);
  for (const task of tasks || []) lines.push(`提醒：${task.title}${task.remind_at ? `，${formatShanghaiDateTime(new Date(task.remind_at))}` : ''}`);
  if (memories?.length) lines.push(`记忆：${memories.length} 条`);
  if (!lines.length) return '';
  const idText = messageId ? `#${messageId}` : '这条消息';
  return `\n\n确认：已写入 ${lines.join('；')}。\n可回复“撤销${idText}”“改${idText}分类为餐饮”“把${idText}存为记忆：内容”进行修正。`;
}

function parseWechatControlCommand(text = '') {
  const clean = String(text || '').trim();
  let match = clean.match(/^(?:撤销|删除)(?:消息)?#?(\d+)?$/);
  if (match) return { type: 'undo', messageId: match[1] ? Number(match[1]) : null };
  match = clean.match(/^改(?:消息)?#?(\d+)?(?:的)?分类(?:为|成)(.+)$/);
  if (match) return { type: 'finance_category', messageId: match[1] ? Number(match[1]) : null, value: match[2].trim() };
  match = clean.match(/^改(?:消息)?#?(\d+)?(?:的)?方向(?:为|成)(收入|支出)$/);
  if (match) return { type: 'finance_direction', messageId: match[1] ? Number(match[1]) : null, value: match[2] === '收入' ? 'income' : 'expense' };
  match = clean.match(/^把(?:消息)?#?(\d+)?存为记忆[:：](.+)$/);
  if (match) return { type: 'save_memory', messageId: match[1] ? Number(match[1]) : null, value: match[2].trim() };
  return null;
}

async function latestActionableWechatMessage(fromUser) {
  const result = await pool.query(`
    SELECT * FROM wechat_messages
    WHERE from_user=$1 AND parse_status IN ('recorded','processing')
      AND (finance_entry_id IS NOT NULL OR fitness_entry_id IS NOT NULL OR knowledge_document_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM assistant_tasks t WHERE t.source_message_id=wechat_messages.id))
    ORDER BY received_at DESC, id DESC
    LIMIT 1`, [fromUser || null]);
  return result.rows[0] || null;
}

async function resolveControlTarget(command, fromUser) {
  if (command.messageId) return getWechatInboxRow(command.messageId);
  const latest = await latestActionableWechatMessage(fromUser);
  return latest ? getWechatInboxRow(latest.id) : null;
}

async function applyWechatControlCommand(command, fromUser) {
  const row = await resolveControlTarget(command, fromUser);
  if (!row) return { ok: false, reply: '没有找到可操作的上一条记录，请带上消息编号，例如“撤销#12”。' };
  if (command.type === 'undo') {
    const deleted = await deleteWechatMessageLinks(row);
    await pool.query("UPDATE wechat_messages SET correction_status='undone', reply_text=reply_text || $1 WHERE id=$2", [`\n已撤销关联记录：${deleted.map((item) => item.type).join('、') || '无'}。`, row.id]);
    return { ok: true, reply: `已撤销 #${row.id} 的关联记录。`, row: await getWechatInboxRow(row.id) };
  }
  if (command.type === 'finance_category' && row.finance_entry_id) {
    await pool.query('UPDATE finance_entries SET category=$1 WHERE id=$2', [command.value || '未分类', row.finance_entry_id]);
    const pattern = learnPatternFromText(row.content || row.finance_title || '');
    if (pattern) await saveAssistantRule({ fromUser: row.from_user, ruleType: 'finance_category', pattern, value: command.value || '未分类', source: 'wechat_correction' });
    await pool.query("UPDATE wechat_messages SET correction_status='corrected' WHERE id=$1", [row.id]);
    return { ok: true, reply: `已把 #${row.id} 的账本分类改为：${command.value}，并学习为规则。`, row: await getWechatInboxRow(row.id) };
  }
  if (command.type === 'finance_direction' && row.finance_entry_id) {
    await pool.query('UPDATE finance_entries SET direction=$1 WHERE id=$2', [command.value === 'income' ? 'income' : 'expense', row.finance_entry_id]);
    await pool.query("UPDATE wechat_messages SET correction_status='corrected' WHERE id=$1", [row.id]);
    return { ok: true, reply: `已把 #${row.id} 的账本方向改为：${command.value === 'income' ? '收入' : '支出'}。`, row: await getWechatInboxRow(row.id) };
  }
  if (command.type === 'save_memory') {
    await saveAssistantMemory({ fromUser: row.from_user, category: 'general', content: command.value || row.content, importance: 3, source: 'wechat_correction' });
    await pool.query("UPDATE wechat_messages SET correction_status='corrected' WHERE id=$1", [row.id]);
    return { ok: true, reply: `已把 #${row.id} 保存为长期记忆。`, row: await getWechatInboxRow(row.id) };
  }
  return { ok: false, reply: `#${row.id} 不支持这个修正，可能没有关联账本记录。` };
}

function isKnowledgeUploadIntent(text) {
  return Boolean(parseKnowledgeTargetIntent(text)) || /^(存入|保存到?|上传到?)\s*知识库/.test(String(text || '').trim());
}

function parseKnowledgeTextCommand(text) {
  const match = String(text || '').trim().match(/^(?:存入|保存到?|上传到?)\s*知识库[:：]?\s*([\s\S]+)/);
  return match?.[1]?.trim() || '';
}

function extractVoiceText(payload) {
  return String(payload.recognition || payload.Recognition || payload.raw_payload?.recognition || payload.raw_payload?.Recognition || '').trim();
}

function extractImageText(payload) {
  return String(
    payload.ocr_text || payload.OCRText || payload.text || payload.Text ||
    payload.raw_payload?.ocr_text || payload.raw_payload?.OCRText || payload.raw_payload?.text || payload.raw_payload?.Text || ''
  ).trim();
}

async function resolveImageText(payload) {
  const existing = extractImageText(payload);
  if (existing) return { text: existing, status: 'ocr_ready', error: null };
  try {
    let media;
    if (payload.image_base64) {
      media = {
        buffer: Buffer.from(String(payload.image_base64).replace(/^data:image\/[^;]+;base64,/, ''), 'base64'),
        contentType: payload.content_type || 'image/jpeg',
      };
    } else if (payload.media_id) {
      media = await downloadWechatWorkMedia(payload.media_id);
    } else {
      throw new Error('缺少图片媒体内容');
    }
    const text = await recognizeImageTextWithVision({ buffer: media.buffer, contentType: media.contentType, hint: payload.content || payload.file_name || '' });
    return { text, status: 'vision_ocr', error: null };
  } catch (error) {
    return { text: '', status: 'failed', error: `图片 OCR 失败：${error.message}` };
  }
}

function imageDataUrl(buffer, contentType = '') {
  const mimeType = contentType && contentType.startsWith('image/') ? contentType : 'image/jpeg';
  return `data:${mimeType};base64,${Buffer.from(buffer).toString('base64')}`;
}

function parseOcrResponse(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    return content.map((item) => item.text || item.content || '').join('\n').trim();
  }
  return String(content || '').trim();
}

async function recognizeImageTextWithVision({ buffer, contentType, hint = '' }) {
  if (!OCR_API_KEY || !OCR_BASE_URL || !OCR_MODEL) throw new Error('未配置 OCR_API_KEY / OCR_BASE_URL / OCR_MODEL');
  const url = `${OCR_BASE_URL.replace(/\/$/, '')}/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OCR_API_KEY}` },
    body: JSON.stringify({
      model: OCR_MODEL,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `请识别图片里的文字，只输出可见文字，不要解释。${hint ? `\n提示：${hint}` : ''}` },
            { type: 'image_url', image_url: { url: imageDataUrl(buffer, contentType) } },
          ],
        },
      ],
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `OCR 服务失败：${response.status}`);
  const text = parseOcrResponse(payload);
  if (!text) throw new Error('OCR 服务没有识别出文本');
  return text;
}

async function recordWechatMessageRow({ from_user, to_user, msg_type, content, raw_payload, financeEntry, fitnessEntry, knowledgeDocument, tasks = [], memories = [], intent, status, reply, sourceMsgType = null, mediaId = null, mediaStatus = null, mediaError = null }) {
  const message = await pool.query(
    `INSERT INTO wechat_messages (from_user, to_user, msg_type, content, raw_payload, finance_entry_id, fitness_entry_id, knowledge_document_id, intent, parse_status, reply_text, source_msg_type, media_id, media_status, media_error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [from_user || null, to_user || null, msg_type || 'text', content || '', JSON.stringify(raw_payload), financeEntry?.id || null, fitnessEntry?.id || null, knowledgeDocument?.id || null, intent, status, reply, sourceMsgType, mediaId, mediaStatus, mediaError]
  );
  const messageId = message.rows[0].id;
  if (tasks?.length) await pool.query('UPDATE assistant_tasks SET source_message_id=$1 WHERE id=ANY($2::int[])', [messageId, tasks.map((task) => task.id)]);
  if (memories?.length) await pool.query('UPDATE assistant_memories SET source_message_id=$1 WHERE id=ANY($2::int[])', [messageId, memories.map((memory) => memory.id)]);
  if (status === 'recorded') await autoUpdatePersonalProfile({ fromUser: from_user, financeEntry, fitnessEntry, tasks, memories, content }).catch((error) => console.error('[profile_auto]', error.message));
  const confirmation = buildWechatConfirmation({ messageId, intent, status, financeEntry, fitnessEntry, knowledgeDocument, tasks, memories });
  const finalReply = truncateWechatReply(`${reply || ''}${confirmation}`);
  if (finalReply !== reply) {
    const updated = await pool.query('UPDATE wechat_messages SET reply_text=$1 WHERE id=$2 RETURNING *', [finalReply, messageId]);
    message.rows[0] = updated.rows[0];
  }
  return { message: message.rows[0], finance_entry: financeEntry, fitness_entry: fitnessEntry, knowledge_document: knowledgeDocument, tasks, memories, reply: finalReply };
}

async function processWechatFileUploadAsync(payload) {
  const fromUser = payload.from_user;
  const mediaId = payload.media_id || payload.MediaId || payload.raw_payload?.media_id || payload.raw_payload?.MediaId || null;
  const filename = payload.file_name || payload.FileName || payload.raw_payload?.file_name || payload.raw_payload?.FileName || payload.content || '';
  let intent = 'knowledge.upload_failed';
  let status = 'failed';
  let reply = '文件入库失败，请稍后重试。';
  let knowledgeDocument = null;
  const existingMessageId = payload.message_id || null;
  try {
    const imported = await importWechatWorkMediaToKnowledge(payload);
    knowledgeDocument = imported.document;
    intent = 'knowledge.upload';
    status = 'recorded';
    reply = `已上传到知识库「${imported.kb.name}」：${imported.document.title}，切分 ${imported.processed.chunks} 段。之后可以直接问我这份资料里的内容。`;
  } catch (error) {
    console.error('[wechat] file upload failed:', error.message);
    reply = `文件入库失败：${error.message}。请确认文件是 TXT、MD、PDF、DOCX、JSON 或 CSV，且大小不超过企业微信限制。`;
  }
  if (existingMessageId) {
    await pool.query(
      `UPDATE wechat_messages
       SET knowledge_document_id=$1, intent=$2, parse_status=$3, reply_text=$4, media_status=$5, media_error=$6
       WHERE id=$7`,
      [knowledgeDocument?.id || null, intent, status, reply, status === 'recorded' ? 'imported' : 'failed', status === 'recorded' ? null : reply, existingMessageId]
    );
  } else {
    await recordWechatMessageRow({
      from_user: fromUser,
      to_user: payload.to_user,
      msg_type: payload.msg_type,
      content: filename,
      raw_payload: payload.raw_payload || payload,
      financeEntry: null,
      fitnessEntry: null,
      knowledgeDocument,
      intent,
      status,
      reply,
      sourceMsgType: payload.msg_type,
      mediaId,
      mediaStatus: status === 'recorded' ? 'imported' : 'failed',
      mediaError: status === 'recorded' ? null : reply,
    });
  }
  if (fromUser && WECHAT_WORK_AGENT_ID) {
    try {
      await sendWechatWorkTextMessage(fromUser, reply);
    } catch (error) {
      console.error('[wechat] upload notify failed:', error.message);
    }
  }
}

async function saveWechatMessage({ from_user, to_user, msg_type = 'text', content = '', raw_payload = {} }) {
  if (msg_type === 'text' && content.trim() && !raw_payload.pending_media_id) {
    const pending = await latestPendingMedia(from_user);
    if (pending && isMediaClarification(content)) {
      const merged = await saveWechatMessage({
        from_user,
        to_user,
        msg_type: 'text',
        content,
        raw_payload: { ...raw_payload, pending_media_id: pending.id, pending_media_type: pending.msg_type, pending_media_media_id: pending.media_id },
      });
      await pool.query('UPDATE pending_media_messages SET status=$1, resolved_message_id=$2, updated_at=now() WHERE id=$3', ['resolved', merged.message.id, pending.id]);
      merged.message.media_status = 'clarified';
      return merged;
    }
  }
  const sourceMsgType = msg_type;
  const mediaId = raw_payload.media_id || raw_payload.MediaId || null;
  let mediaStatus = null;
  let mediaError = null;
  if (msg_type === 'voice') {
    const voiceText = extractVoiceText({ ...raw_payload, content });
    if (voiceText) {
      content = voiceText;
      msg_type = 'text';
      mediaStatus = 'transcribed';
    } else {
      content = content || '[语音消息]';
      mediaStatus = 'failed';
      mediaError = '语音消息没有 Recognition 转写结果，请在企业微信后台开启语音识别或发送文字。';
    }
  }
  if (msg_type === 'image') {
    const imageResult = await resolveImageText({ ...raw_payload, content });
    if (imageResult.text) {
      content = imageResult.text;
      msg_type = 'text';
      mediaStatus = imageResult.status;
    } else {
      content = content || raw_payload.file_name || raw_payload.pic_url || '[图片消息]';
      mediaStatus = imageResult.status;
      mediaError = imageResult.error || '图片没有 OCR 文本结果。';
    }
  }
  let financeEntry = null;
  let fitnessEntry = null;
  let knowledgeDocument = null;
  let tasks = [];
  let memories = [];
  let intent = 'unknown';
  let status = 'ignored';
  let reply = '你好，我是你的助手。可以记录体重/消费/运动/睡眠，也可以问我「这个月花了多少」「最近体重趋势」或知识库问题。';
  let assistantContext = null;
  const controlCommand = msg_type === 'text' ? parseWechatControlCommand(content) : null;
  if (controlCommand) {
    const controlled = await applyWechatControlCommand(controlCommand, from_user);
    intent = controlled.ok ? `control.${controlCommand.type}` : 'control.failed';
    status = controlled.ok ? 'recorded' : 'failed';
    reply = controlled.reply;
  } else if (msg_type === 'file' && raw_payload.media_id) {
    intent = 'knowledge.upload_pending';
    status = 'processing';
    reply = '收到文件，正在写入知识库，请稍候…';
  } else if (mediaError) {
    await savePendingMedia({ fromUser: from_user, toUser: to_user, msgType: sourceMsgType, mediaId, contentHint: content, rawPayload: raw_payload });
    intent = `${sourceMsgType}.media_failed`;
    status = 'failed';
    reply = `${mediaError}\n你可以直接补充一句说明，例如：这张图是午餐 28 元、这张图是体重 70.8kg、这张图存入知识库。`;
  } else if (msg_type === 'text' && content.trim()) {
    const kbText = parseKnowledgeTextCommand(content);
    if (kbText) {
      try {
        const ingested = await ingestTextToKnowledgeBase({ title: '企微文字资料', text: kbText, sourceType: 'wechat_text', sourceUser: from_user, sourceNote: '企业微信文本命令' });
        knowledgeDocument = ingested.document;
        intent = 'knowledge.ingested';
        status = 'recorded';
        reply = `已写入知识库「${ingested.kb.name}」：${ingested.document.title}，切分 ${ingested.processed.chunks} 段。`;
      } catch (error) {
        intent = 'knowledge.ingest_failed';
        status = 'failed';
        reply = `写入知识库失败：${error.message}`;
      }
    } else if (isKnowledgeUploadIntent(content)) {
      try {
        const target = await rememberNextKnowledgeUploadTarget(from_user, content);
        intent = 'knowledge.upload_target';
        status = 'replied';
        const publicBase = raw_payload.public_base_url || PUBLIC_BASE_URL || '';
        const uploadUrl = `${String(publicBase).replace(/\/$/, '')}/wechat-upload.html?token=${target.upload_token}`;
        reply = `可以，30 分钟内发送的下一个文件会保存到知识库「${target?.kb?.name || '微信上传资料'}」。如果企业微信文件没有触发回调，也可以打开这个链接上传：${uploadUrl}\n也可以直接发「存入知识库：」+ 正文。`;
      } catch (error) {
        intent = 'knowledge.upload_target_failed';
        status = 'failed';
        reply = `设置知识库目标失败：${error.message}`;
      }
    } else try {
      const userKb = await resolveUserKnowledgeBase(from_user).catch(() => null);
      const searchKb = await shouldSearchKnowledge(content, classifyUsefulTopic(content, []));
      const [userContext, memoryContext, knowledgeSources] = await Promise.all([
        buildWechatUserContext(from_user, { light: false }),
        buildAssistantMemoryContext(from_user),
        searchKb ? searchKnowledge(userKb?.id || WECHAT_DEFAULT_KB_ID, content, 5) : Promise.resolve([]),
      ]);
      const recentContext = await buildRecentWechatContext(from_user);
      const understood = await deepseekUnderstandWechatMessage(content, userContext, memoryContext, knowledgeSources, recentContext);
      assistantContext = compactAssistantContext({ userContext, memoryContext, knowledgeSources, recentContext, understood });
      if (understood?.actions?.length) {
        const executed = await executeAssistantActions(understood.actions, content, from_user);
        financeEntry = executed.financeEntry;
        fitnessEntry = executed.fitnessEntry;
        knowledgeDocument = executed.knowledgeDocuments?.[0]?.document || null;
        tasks = executed.tasks || [];
        memories = executed.memories || [];
        intent = executed.intents[0] || 'chat.assistant';
        status = executed.intents.length ? 'recorded' : 'replied';
        reply = truncateWechatReply(`${understood.reply || '已处理。'}${actionReplySuffix(executed)}`);
        if (executed.intents.length) await invalidateAssistantCacheForUser(from_user);
      } else {
        const chatResult = await handleWechatChat(content, from_user);
        reply = chatResult.answer;
        intent = chatResult.from_cache ? 'chat.cache' : 'chat.assistant';
        status = 'replied';
      }
    } catch (error) {
      assistantContext = assistantContext || compactAssistantContext({ error });
      const fitnessParsed = parseFitnessMessage(content);
      const financeParsed = !fitnessParsed ? await parseFinanceMessage(content, from_user) : null;
      if (fitnessParsed) {
        const created = await createFitnessEntry({ ...fitnessParsed, note: fitnessParsed.note || content, source_user: from_user });
        fitnessEntry = created.entry;
        intent = `fitness.${fitnessParsed.entry_type}`;
        status = 'recorded';
        reply = `已记录：${created.report.summary}`;
      } else if (financeParsed) {
        financeEntry = await createFinanceEntry(financeParsed, from_user, content);
        intent = `finance.${financeEntry.direction}`;
        status = 'recorded';
        reply = `已记录${financeEntry.direction === 'income' ? '收入' : '支出'}：${financeEntry.title} ¥${Number(financeEntry.amount).toFixed(2)}，分类：${financeEntry.category}`;
      } else {
        reply = `回复失败：${error.message}`;
        intent = 'chat.error';
        status = 'failed';
      }
    }
  }
  if (assistantContext) raw_payload = { ...raw_payload, assistant_context: assistantContext };
  return recordWechatMessageRow({ from_user, to_user, msg_type, content, raw_payload, financeEntry, fitnessEntry, knowledgeDocument, tasks, memories, intent, status, reply, sourceMsgType, mediaId, mediaStatus, mediaError });
}

async function createFitnessReport(entry) {
  let report;
  try {
    report = await deepseekFitnessAdvice(entry);
  } catch (error) {
    report = localFitnessAdvice(entry);
    report.advice = `${report.advice}（DeepSeek 分析暂不可用：${error.message}）`;
  }
  const result = await pool.query(
    `INSERT INTO fitness_ai_reports (entry_id, summary, advice, risk_level)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [entry.id, report.summary, report.advice, report.risk_level]
  );
  return result.rows[0];
}

async function jsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function authorized(req) {
  if (!AUTH_USER || !AUTH_PASSWORD) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const index = decoded.indexOf(':');
  const user = decoded.slice(0, index);
  const password = decoded.slice(index + 1);
  return user === AUTH_USER && password === AUTH_PASSWORD;
}

function gatewayAuthorized(req) {
  if (!GATEWAY_TOKEN) return authorized(req);
  const header = req.headers.authorization || '';
  return header === `Bearer ${GATEWAY_TOKEN}`;
}

function sendUnauthorized(res) {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="AI Key Hub"',
    'Content-Type': 'text/plain; charset=utf-8',
  });
  res.end('authentication required');
}

function requestBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`.replace(/\/$/, '');
}

function copyPayload(provider, key, mode, model = '') {
  const apiKey = decryptSecret(key);
  const baseUrl = provider.base_url;
  const modelName = model || provider.default_model || '';
  if (mode === 'base_url') return `${baseUrl}\n${apiKey}`;
  if (mode === 'env') return `export ${provider.code.toUpperCase()}_API_KEY="${apiKey}"\nexport ${provider.code.toUpperCase()}_BASE_URL="${baseUrl}"`;
  if (mode === 'curl') {
    return `curl ${baseUrl}/chat/completions \\\n  -H "Authorization: Bearer ${apiKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${modelName}","messages":[{"role":"user","content":"你好"}]}'`;
  }
  return apiKey;
}

function parseGatewayModel(model = '') {
  const raw = String(model || '').trim();
  if (!raw) return { providerCode: '', modelName: '' };
  const separators = ['/', ':'];
  for (const separator of separators) {
    if (raw.includes(separator)) {
      const [providerCode, ...rest] = raw.split(separator);
      return { providerCode, modelName: rest.join(separator) || raw };
    }
  }
  return { providerCode: '', modelName: raw };
}

async function selectGatewayTarget(model) {
  const parsed = parseGatewayModel(model);
  const params = [parsed.modelName];
  let providerFilter = '';
  if (parsed.providerCode) {
    params.push(parsed.providerCode);
    providerFilter = `AND p.code=$${params.length}`;
  }
  const result = await pool.query(`
    SELECT p.id provider_id, p.code provider_code, p.name provider_name, p.base_url,
           k.id key_id, k.api_key, k.api_key_encrypted, k.api_key_iv, k.api_key_tag, k.name key_name,
           m.name model_name, m.input_price, m.output_price
    FROM models m
    JOIN providers p ON p.id=m.provider_id
    JOIN api_keys k ON k.provider_id=p.id
    WHERE m.enabled=true AND k.status='active' AND p.status='active'
      AND m.name=$1 ${providerFilter}
    ORDER BY k.updated_at DESC, k.id DESC
    LIMIT 1`, params);
  if (result.rowCount) return result.rows[0];
  const fallback = await pool.query(`
    SELECT p.id provider_id, p.code provider_code, p.name provider_name, p.base_url,
           k.id key_id, k.api_key, k.api_key_encrypted, k.api_key_iv, k.api_key_tag, k.name key_name,
           $1::text model_name, 0::numeric input_price, 0::numeric output_price
    FROM providers p
    JOIN api_keys k ON k.provider_id=p.id
    WHERE k.status='active' AND p.status='active'
      ${parsed.providerCode ? 'AND p.code=$2' : ''}
    ORDER BY k.updated_at DESC, k.id DESC
    LIMIT 1`, parsed.providerCode ? [parsed.modelName, parsed.providerCode] : [parsed.modelName]);
  if (!fallback.rowCount) throw new Error('No active provider key found for model');
  return fallback.rows[0];
}

async function selectGatewayTargets(model) {
  const parsed = parseGatewayModel(model);
  const params = [parsed.modelName];
  let providerFilter = '';
  if (parsed.providerCode) {
    params.push(parsed.providerCode);
    providerFilter = `AND p.code=$${params.length}`;
  }
  const exact = await pool.query(`
    SELECT p.id provider_id, p.code provider_code, p.name provider_name, p.base_url,
           k.id key_id, k.api_key, k.api_key_encrypted, k.api_key_iv, k.api_key_tag, k.name key_name,
           m.name model_name, m.input_price, m.output_price
    FROM models m
    JOIN providers p ON p.id=m.provider_id
    JOIN api_keys k ON k.provider_id=p.id
    WHERE m.enabled=true AND k.status='active' AND p.status='active'
      AND m.name=$1 ${providerFilter}
    ORDER BY k.updated_at DESC, k.id DESC
    LIMIT 5`, params);
  if (exact.rowCount) return exact.rows;
  const fallback = await pool.query(`
    SELECT p.id provider_id, p.code provider_code, p.name provider_name, p.base_url,
           k.id key_id, k.api_key, k.api_key_encrypted, k.api_key_iv, k.api_key_tag, k.name key_name,
           $1::text model_name, 0::numeric input_price, 0::numeric output_price
    FROM providers p
    JOIN api_keys k ON k.provider_id=p.id
    WHERE k.status='active' AND p.status='active'
      ${parsed.providerCode ? 'AND p.code=$2' : ''}
    ORDER BY k.updated_at DESC, k.id DESC
    LIMIT 5`, parsed.providerCode ? [parsed.modelName, parsed.providerCode] : [parsed.modelName]);
  if (!fallback.rowCount) throw new Error('No active provider key found for model');
  return fallback.rows;
}

function estimateGatewayCost(target, usage = {}) {
  const inputTokens = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const outputTokens = Number(usage.completion_tokens || usage.output_tokens || 0);
  const inputPrice = Number(target.input_price || 0);
  const outputPrice = Number(target.output_price || 0);
  return {
    inputTokens,
    outputTokens,
    cost: (inputTokens / 1_000_000) * inputPrice + (outputTokens / 1_000_000) * outputPrice,
  };
}

async function recordGatewayUsage(target, modelName, usage, status, latencyMs) {
  const estimated = estimateGatewayCost(target, usage);
  await pool.query(
    `INSERT INTO usage_logs (provider_id, api_key_id, model_name, input_tokens, output_tokens, cost, status, latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [target?.provider_id || null, target?.key_id || null, modelName || target?.model_name || 'unknown', estimated.inputTokens, estimated.outputTokens, estimated.cost, status, latencyMs]
  );
  if (target?.key_id && estimated.cost > 0) {
    await pool.query('UPDATE api_keys SET used_amount=COALESCE(used_amount,0)+$1, updated_at=now() WHERE id=$2', [estimated.cost, target.key_id]);
  }
  return estimated;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = GATEWAY_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callGatewayTarget(target, data) {
  const url = `${String(target.base_url).replace(/\/$/, '')}/chat/completions`;
  const upstreamBody = { ...data, model: target.model_name };
  const apiKey = decryptSecret(target);
  if (!apiKey || apiKey.includes('***')) throw new Error(`API Key unavailable for ${target.provider_code}/${target.key_name}`);
  let lastError = null;
  for (let attempt = 0; attempt <= GATEWAY_RETRY_COUNT; attempt += 1) {
    try {
      const upstream = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(upstreamBody),
      });
      const text = await upstream.text();
      let payload = null;
      try { payload = JSON.parse(text); } catch (_) { payload = null; }
      if (upstream.ok || upstream.status < 500 || attempt >= GATEWAY_RETRY_COUNT) {
        return { upstream, text, payload, attempt };
      }
      lastError = new Error(`upstream ${upstream.status}`);
    } catch (error) {
      lastError = error;
      if (attempt >= GATEWAY_RETRY_COUNT) break;
    }
  }
  throw lastError || new Error('gateway upstream failed');
}

async function handleGatewayChatCompletions(req, res) {
  const started = Date.now();
  let target = null;
  let modelName = 'unknown';
  const failures = [];
  try {
    const data = await jsonBody(req);
    const targets = await selectGatewayTargets(data.model);
    for (const candidate of targets) {
      target = candidate;
      modelName = target.model_name;
      const attemptStarted = Date.now();
      try {
        const { upstream, text, payload } = await callGatewayTarget(target, data);
        const latencyMs = Date.now() - attemptStarted;
        await recordGatewayUsage(target, modelName, payload?.usage || {}, upstream.ok ? 'success' : 'failed', latencyMs);
        if (!upstream.ok && upstream.status >= 500 && targets.indexOf(candidate) < targets.length - 1) {
          failures.push({ key_id: target.key_id, status: upstream.status });
          continue;
        }
        res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8' });
        return res.end(text);
      } catch (error) {
        failures.push({ key_id: candidate.key_id, error: error.message });
        await recordGatewayUsage(candidate, candidate.model_name, {}, 'failed', Date.now() - attemptStarted).catch(() => {});
      }
    }
    throw new Error(`All gateway targets failed: ${failures.map((item) => item.error || item.status).join(', ')}`);
  } catch (error) {
    const latencyMs = Date.now() - started;
    await recordGatewayUsage(target, modelName, {}, 'failed', latencyMs).catch(() => {});
    return sendJson(res, 500, { error: { message: error.message, type: 'gateway_error', failures } });
  }
}

function publicKeyRow(row) {
  const { raw_key, api_key, ...rest } = row;
  return { ...rest, api_key: maskKey(api_key || raw_key || '') };
}

function deepseekBalancePayload(payload) {
  const balances = Array.isArray(payload?.balance_infos) ? payload.balance_infos : [];
  const preferred = balances.find(item => item.currency === 'CNY') || balances[0];
  return {
    is_available: Boolean(payload?.is_available),
    currency: preferred?.currency || 'CNY',
    total_balance: Number(preferred?.total_balance || 0),
    granted_balance: Number(preferred?.granted_balance || 0),
    topped_up_balance: Number(preferred?.topped_up_balance || 0),
    balance_infos: balances,
  };
}

async function fetchDeepSeekBalance(apiKey) {
  const response = await fetch('https://api.deepseek.com/user/balance', {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message || body?.message || `DeepSeek balance request failed: ${response.status}`);
  }
  return deepseekBalancePayload(body);
}

async function refreshProviderBalances() {
  const rows = await pool.query(`
    SELECT DISTINCT ON (p.id) p.id provider_id, p.code, p.name, k.id key_id, k.api_key, k.api_key_encrypted, k.api_key_iv, k.api_key_tag
    FROM providers p
    JOIN api_keys k ON k.provider_id = p.id
    WHERE k.status = 'active'
    ORDER BY p.id, k.updated_at DESC, k.id DESC`);

  const results = [];
  for (const row of rows.rows) {
    if (row.code !== 'deepseek') {
      results.push({ provider_id: row.provider_id, provider: row.name, skipped: true, reason: 'provider balance API not configured' });
      continue;
    }
    try {
      const balance = await fetchDeepSeekBalance(decryptSecret(row));
      await pool.query(
        'UPDATE providers SET balance=$1,currency=$2,status=$3,updated_at=now() WHERE id=$4',
        [balance.total_balance, balance.currency, balance.is_available ? 'active' : 'warning', row.provider_id]
      );
      results.push({ provider_id: row.provider_id, provider: row.name, key_id: row.key_id, ok: true, ...balance });
    } catch (error) {
      results.push({ provider_id: row.provider_id, provider: row.name, key_id: row.key_id, ok: false, error: error.message });
    }
  }
  return results;
}

async function stats() {
  const [providers, keys, usage] = await Promise.all([
    pool.query('SELECT COUNT(*)::int count, COALESCE(SUM(balance),0)::float total_balance FROM providers'),
    pool.query("SELECT COUNT(*)::int count, COUNT(*) FILTER (WHERE status != 'active')::int abnormal FROM api_keys"),
    pool.query("SELECT COUNT(*)::int calls, COALESCE(SUM(\"cost\"),0)::float today_cost, COALESCE(AVG(latency_ms),0)::int avg_latency FROM usage_logs WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'"),
  ]);
  return { ...providers.rows[0], key_count: keys.rows[0].count, abnormal_keys: keys.rows[0].abnormal, today_calls: usage.rows[0].calls, today_cost: usage.rows[0].today_cost, avg_latency: usage.rows[0].avg_latency };
}

async function listTimeline(url) {
  const limit = Math.min(300, Math.max(20, Number(url.searchParams.get('limit') || 120)));
  const type = url.searchParams.get('type') || '';
  const result = await pool.query(`
    WITH timeline AS (
      SELECT 'finance' type, id::text entity_id, occurred_at event_at, title,
             jsonb_build_object('amount', amount, 'direction', direction, 'category', category, 'note', note, 'source_user', source_user) detail
      FROM finance_entries
      UNION ALL
      SELECT 'fitness' type, id::text entity_id, recorded_at event_at,
             CASE entry_type WHEN 'weight' THEN '体重记录' WHEN 'meal' THEN '饮食记录' WHEN 'workout' THEN '训练记录' WHEN 'sleep' THEN '睡眠记录' ELSE entry_type END title,
             jsonb_build_object('entry_type', entry_type, 'weight_kg', weight_kg, 'calories', calories, 'duration_min', duration_min, 'sleep_hours', sleep_hours, 'note', note, 'source_user', source_user) detail
      FROM fitness_entries
      UNION ALL
      SELECT 'knowledge' type, id::text entity_id, created_at event_at, title,
             jsonb_build_object('kb_id', kb_id, 'filename', filename, 'status', status, 'source_user', source_user, 'source_channel', source_channel) detail
      FROM knowledge_documents
      UNION ALL
      SELECT 'wechat' type, id::text entity_id, received_at event_at, COALESCE(NULLIF(content,''), msg_type) title,
             jsonb_build_object('from_user', from_user, 'msg_type', msg_type, 'intent', intent, 'parse_status', parse_status, 'media_status', media_status) detail
      FROM wechat_messages
      UNION ALL
      SELECT 'task' type, id::text entity_id, COALESCE(remind_at, created_at) event_at, title,
             jsonb_build_object('status', status, 'recurrence', recurrence, 'from_user', from_user, 'note', note) detail
      FROM assistant_tasks
      UNION ALL
      SELECT 'report' type, id::text entity_id, created_at event_at, title,
             jsonb_build_object('report_type', report_type, 'from_user', from_user) detail
      FROM assistant_reports
      UNION ALL
      SELECT 'audit' type, id::text entity_id, created_at event_at, action title,
             jsonb_build_object('actor', actor, 'entity_type', entity_type, 'entity_id', entity_id, 'detail', detail) detail
      FROM audit_logs
    )
    SELECT type, entity_id, event_at, title, detail
    FROM timeline
    WHERE ($1::text = '' OR type=$1)
    ORDER BY event_at DESC
    LIMIT $2`, [type, limit]);
  return result.rows;
}

async function listSystemEvents(url) {
  const level = url.searchParams.get('level') || '';
  const q = url.searchParams.get('q') || '';
  const limit = Math.min(300, Math.max(20, Number(url.searchParams.get('limit') || 120)));
  const params = [];
  const filters = [`(entity_type IN ('system_event','backup','wechat_retry','wechat_push') OR action LIKE 'backup.%' OR action LIKE 'wechat.retry%' OR action LIKE 'wechat.push%')`];
  if (level) {
    params.push(level);
    filters.push(`detail->>'level'=$${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    filters.push(`(action ILIKE $${params.length} OR entity_type ILIKE $${params.length} OR entity_id ILIKE $${params.length} OR detail::text ILIKE $${params.length})`);
  }
  params.push(limit);
  const where = `WHERE ${filters.join(' AND ')}`;
  const [rows, summary] = await Promise.all([
    pool.query(`
      SELECT id, actor, action, entity_type, entity_id, detail, created_at,
             COALESCE(detail->>'level','info') AS "level"
      FROM audit_logs
      ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length}`, params),
    pool.query(`
      SELECT COALESCE(detail->>'level','info') AS "level", COUNT(*)::int count
      FROM audit_logs
      WHERE created_at >= now() - interval '7 days'
        AND (entity_type IN ('system_event','backup','wechat_retry','wechat_push') OR action LIKE 'backup.%' OR action LIKE 'wechat.retry%' OR action LIKE 'wechat.push%')
      GROUP BY COALESCE(detail->>'level','info')`),
  ]);
  return { summary: summary.rows, rows: rows.rows.map((row) => ({ ...row, href: systemEventHref(row) })) };
}

function systemEventHref(row = {}) {
  const action = String(row.action || '');
  const entityType = String(row.entity_type || '');
  const entityId = String(row.entity_id || '');
  if (entityType === 'backup' || action.startsWith('backup.')) return '/backup.html';
  if (entityType === 'wechat_retry' || action.startsWith('wechat.retry')) return '/wechat-inbox.html?status=failed';
  if (entityType === 'wechat_push' || action.startsWith('wechat.push')) return '/wechat-diagnostics.html';
  if (entityType === 'wechat_message' && entityId) return `/wechat-inbox.html?q=${encodeURIComponent(`#${entityId}`)}`;
  if (entityType === 'assistant_memory' && entityId) return `/profile.html?memory=${encodeURIComponent(entityId)}`;
  return '/monitor.html';
}

async function systemStatus() {
  const started = Date.now();
 const status = {
    ok: true,
    checked_at: new Date().toISOString(),
    app: { port: PORT, auth_enabled: Boolean(AUTH_USER && AUTH_PASSWORD) },
    database: { ok: false },
    chroma: { ok: false, url: CHROMA_URL },
    embeddings: getEmbeddingStatus(),
    wechat: {
      corp_id: Boolean(WECHAT_WORK_CORP_ID),
      agent_id: Boolean(WECHAT_WORK_AGENT_ID),
      secret: Boolean(WECHAT_WORK_SECRET),
      token: Boolean(WECHAT_WORK_TOKEN),
      aes_key: Boolean(WECHAT_WORK_ENCODING_AES_KEY),
    },
    ocr: { configured: Boolean(OCR_API_KEY && OCR_BASE_URL && OCR_MODEL), base_url: Boolean(OCR_BASE_URL), model: OCR_MODEL || '' },
    gateway: { enabled: Boolean(GATEWAY_TOKEN), timeout_ms: GATEWAY_TIMEOUT_MS, retry_count: GATEWAY_RETRY_COUNT },
    backup: { enabled: AUTO_BACKUP_ENABLED, dir: BACKUP_DIR, interval_ms: AUTO_BACKUP_INTERVAL_MS, keep: AUTO_BACKUP_KEEP, last: lastAutoBackup },
  };
  try {
    const db = await pool.query('SELECT now() now');
    const [errors, gateway, audits, uploadFailures, retryQueue, backups, recentProblems, duplicateDocs, recentUploads] = await Promise.all([
      pool.query("SELECT COUNT(*)::int count FROM wechat_messages WHERE parse_status IN ('failed','needs_clarification') AND received_at >= now() - interval '24 hours'"),
      pool.query("SELECT COUNT(*)::int calls, COUNT(*) FILTER (WHERE status='failed')::int failed FROM usage_logs WHERE created_at >= now() - interval '24 hours'"),
      pool.query('SELECT action, actor, entity_type, entity_id, created_at FROM audit_logs ORDER BY created_at DESC LIMIT 20'),
      pool.query("SELECT COUNT(*)::int count FROM wechat_messages WHERE intent ILIKE 'knowledge.upload%' AND parse_status='failed' AND received_at >= now() - interval '24 hours'"),
      pool.query("SELECT COUNT(*)::int count FROM wechat_messages WHERE parse_status='failed' AND COALESCE(retry_count,0)<3"),
      listLocalBackups().catch(() => []),
      pool.query(`
        SELECT id, from_user, msg_type, intent, parse_status, media_status, media_error, reply_text, received_at
        FROM wechat_messages
        WHERE parse_status='failed' OR media_error IS NOT NULL
        ORDER BY received_at DESC, id DESC
        LIMIT 20`),
      pool.query(`
        SELECT kb_id, title, filename, COUNT(*)::int count, MAX(created_at) latest
        FROM knowledge_documents
        GROUP BY kb_id, title, filename
        HAVING COUNT(*) > 1
        ORDER BY latest DESC
        LIMIT 20`),
      pool.query(`
        SELECT id, title, filename, source_type, status, error_message, created_at
        FROM knowledge_documents
        WHERE source_channel='wechat' OR source_type ILIKE 'wechat%'
        ORDER BY created_at DESC
        LIMIT 20`),
    ]);
    status.database = { ok: true, now: db.rows[0].now };
    status.wechat.recent_problem_messages = errors.rows[0].count;
    status.wechat.upload_failures_24h = uploadFailures.rows[0].count;
    status.wechat.retry_queue = retryQueue.rows[0].count;
    status.wechat.failed_retry = { enabled: WECHAT_FAILED_RETRY_ENABLED, interval_ms: WECHAT_FAILED_RETRY_MS, notify: WECHAT_FAILED_RETRY_NOTIFY, last: lastFailedRetry };
    status.backup.files = backups.slice(0, 10);
    status.gateway.last_24h_calls = gateway.rows[0].calls;
    status.gateway.last_24h_failed = gateway.rows[0].failed;
    status.recent_audits = audits.rows;
    status.recent_problems = recentProblems.rows;
    status.knowledge = {
      duplicate_documents: duplicateDocs.rows,
      recent_uploads: recentUploads.rows,
    };
  } catch (error) {
    status.ok = false;
    status.database = { ok: false, error: error.message };
  }
  try {
    let heartbeat = await fetchWithTimeout(`${CHROMA_URL.replace(/\/$/, '')}/api/v2/heartbeat`, {}, 3000);
    if (heartbeat.status === 404) heartbeat = await fetchWithTimeout(`${CHROMA_URL.replace(/\/$/, '')}/api/v1/heartbeat`, {}, 3000);
    status.chroma.ok = heartbeat.ok;
    status.chroma.status = heartbeat.status;
  } catch (error) {
    status.chroma.error = error.message;
  }
  status.ok = status.ok && status.database.ok && status.chroma.ok;
  status.latency_ms = Date.now() - started;
  return status;
}

async function appConfigStatus() {
  const kb = WECHAT_DEFAULT_KB_ID ? await pool.query('SELECT id,name FROM knowledge_bases WHERE id=$1', [WECHAT_DEFAULT_KB_ID]).catch(() => ({ rows: [] })) : { rows: [] };
  const notificationStats = await pool.query(`SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE enabled=true)::int enabled, COUNT(*) FILTER (WHERE COALESCE(to_user,'')<>'')::int configured_users FROM notification_subscriptions`).catch(() => ({ rows: [{ total: 0, enabled: 0, configured_users: 0 }] }));
  return {
    app: { port: PORT, public_base_url: PUBLIC_BASE_URL || '', auth_enabled: Boolean(AUTH_USER && AUTH_PASSWORD), key_encryption: Boolean(KEY_ENCRYPTION_SECRET) },
    wechat: { corp_id: Boolean(WECHAT_WORK_CORP_ID), token: Boolean(WECHAT_WORK_TOKEN), aes_key: Boolean(WECHAT_WORK_ENCODING_AES_KEY), secret: Boolean(WECHAT_WORK_SECRET), agent_id: WECHAT_WORK_AGENT_ID || null, default_kb_id: WECHAT_DEFAULT_KB_ID || null, default_kb_name: kb.rows[0]?.name || '' },
    ocr: { configured: Boolean(OCR_API_KEY && OCR_BASE_URL && OCR_MODEL), base_url: OCR_BASE_URL ? '[configured]' : '', model: OCR_MODEL || '' },
    gateway: { token_enabled: Boolean(GATEWAY_TOKEN), timeout_ms: GATEWAY_TIMEOUT_MS, retry_count: GATEWAY_RETRY_COUNT },
    assistant: { task_poll_ms: ASSISTANT_TASK_POLL_MS, cache_ttl_wechat: ASSISTANT_CACHE_TTL_WECHAT, cache_ttl_web: ASSISTANT_CACHE_TTL_WEB, failed_retry_enabled: WECHAT_FAILED_RETRY_ENABLED, failed_retry_ms: WECHAT_FAILED_RETRY_MS },
    backup: { enabled: AUTO_BACKUP_ENABLED, dir: BACKUP_DIR ? '[configured]' : '', interval_ms: AUTO_BACKUP_INTERVAL_MS, keep: AUTO_BACKUP_KEEP, admin_notify_user: Boolean(WECHAT_ADMIN_USER) },
    notifications: notificationStats.rows[0],
    knowledge: { collection: KNOWLEDGE_COLLECTION, embedding: getEmbeddingStatus(), chroma_url: CHROMA_URL ? '[configured]' : '' },
  };
}

async function wechatDiagnostics() {
  const [messages, pendingTargets, pendingMedia, profiles, uploads, failedPushTasks] = await Promise.all([
    pool.query(`
      SELECT id, from_user, msg_type, content, intent, parse_status, media_status, media_error, reply_text, received_at
      FROM wechat_messages ORDER BY received_at DESC, id DESC LIMIT 80`),
    pool.query(`SELECT id, from_user, content, created_at FROM assistant_memories WHERE category='knowledge_upload_target' ORDER BY created_at DESC LIMIT 20`),
    pool.query(`SELECT id, from_user, msg_type, media_id, status, content_hint, created_at, expires_at FROM pending_media_messages ORDER BY created_at DESC LIMIT 20`),
    pool.query('SELECT from_user, display_name, default_kb_id, enabled, updated_at FROM wechat_user_profiles ORDER BY updated_at DESC LIMIT 50'),
    pool.query(`SELECT id, title, filename, status, error_message, source_user, created_at FROM knowledge_documents WHERE source_channel='wechat' OR source_type ILIKE 'wechat%' ORDER BY created_at DESC LIMIT 40`),
    pool.query("SELECT id, from_user, title, remind_at, last_notified_at, status FROM assistant_tasks WHERE remind_at IS NOT NULL ORDER BY updated_at DESC LIMIT 30"),
  ]);
  const summary = {
    total_messages: messages.rowCount,
    file_messages: messages.rows.filter((row) => row.msg_type === 'file').length,
    failed_messages: messages.rows.filter((row) => row.parse_status === 'failed').length,
    pending_upload_targets: pendingTargets.rowCount,
    pending_media: pendingMedia.rowCount,
    upload_records: uploads.rowCount,
  };
  return { summary, messages: messages.rows, pending_targets: pendingTargets.rows, pending_media: pendingMedia.rows, profiles: profiles.rows, uploads: uploads.rows, reminder_pushes: failedPushTasks.rows };
}

async function listWechatInbox(url) {
  const status = url.searchParams.get('status');
  const intent = url.searchParams.get('intent');
  const msgType = url.searchParams.get('msg_type');
  const q = url.searchParams.get('q');
  const limit = Math.min(200, Math.max(20, Number(url.searchParams.get('limit') || 80)));
  const filters = [];
  const params = [];
  if (status) {
    params.push(status);
    filters.push(`m.parse_status=$${params.length}`);
  }
  if (intent) {
    params.push(`${intent}%`);
    filters.push(`m.intent ILIKE $${params.length}`);
  }
  if (msgType) {
    params.push(msgType);
    filters.push(`m.msg_type=$${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    filters.push(`(m.content ILIKE $${params.length} OR m.reply_text ILIKE $${params.length} OR m.from_user ILIKE $${params.length})`);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  params.push(limit);
  const rows = await pool.query(`
    SELECT
      m.*,
      f.direction finance_direction,
      f.amount finance_amount,
      f.category finance_category,
      f.title finance_title,
      fit.entry_type fitness_type,
      fit.weight_kg,
      fit.meal_type,
      fit.food_text,
      fit.workout_type,
      fit.duration_min,
      fit.sleep_hours,
      d.title knowledge_title,
      d.filename knowledge_filename,
      d.status knowledge_status,
      d.source_channel knowledge_source_channel,
      kb.name knowledge_base_name,
      t.id task_id,
      t.title task_title,
      t.remind_at task_remind_at,
      t.status task_status
    FROM wechat_messages m
    LEFT JOIN finance_entries f ON f.id=m.finance_entry_id
    LEFT JOIN fitness_entries fit ON fit.id=m.fitness_entry_id
    LEFT JOIN knowledge_documents d ON d.id=m.knowledge_document_id
    LEFT JOIN knowledge_bases kb ON kb.id=d.kb_id
    LEFT JOIN LATERAL (
      SELECT id, title, remind_at, status
      FROM assistant_tasks
      WHERE source_message_id=m.id OR (from_user=m.from_user AND created_at BETWEEN m.received_at - interval '5 seconds' AND m.received_at + interval '30 seconds')
      ORDER BY created_at DESC
      LIMIT 1
    ) t ON true
    ${where}
    ORDER BY m.received_at DESC, m.id DESC
    LIMIT $${params.length}`,
    params
  );
  const summary = await pool.query(`
    SELECT
      COUNT(*)::int total,
      COUNT(*) FILTER (WHERE parse_status='recorded')::int recorded,
      COUNT(*) FILTER (WHERE parse_status='replied')::int replied,
      COUNT(*) FILTER (WHERE parse_status='failed')::int failed,
      COUNT(*) FILTER (WHERE parse_status='processing')::int processing,
      COUNT(*) FILTER (WHERE parse_status='ignored')::int ignored,
      COUNT(*) FILTER (WHERE received_at >= now() - interval '24 hours')::int last_24h
    FROM wechat_messages`);
  const intents = await pool.query(`
    SELECT intent, COUNT(*)::int count
    FROM wechat_messages
    GROUP BY intent
    ORDER BY count DESC, intent ASC
    LIMIT 40`);
  return { summary: summary.rows[0], intents: intents.rows, rows: rows.rows };
}

async function getWechatInboxRow(messageId) {
  const result = await pool.query(`
    SELECT
      m.*,
      f.direction finance_direction,
      f.amount finance_amount,
      f.category finance_category,
      f.title finance_title,
      fit.entry_type fitness_type,
      fit.weight_kg,
      fit.meal_type,
      fit.food_text,
      fit.workout_type,
      fit.duration_min,
      fit.sleep_hours,
      d.title knowledge_title,
      d.filename knowledge_filename,
      d.status knowledge_status,
      d.source_channel knowledge_source_channel,
      kb.name knowledge_base_name,
      t.id task_id,
      t.title task_title,
      t.remind_at task_remind_at,
      t.status task_status
    FROM wechat_messages m
    LEFT JOIN finance_entries f ON f.id=m.finance_entry_id
    LEFT JOIN fitness_entries fit ON fit.id=m.fitness_entry_id
    LEFT JOIN knowledge_documents d ON d.id=m.knowledge_document_id
    LEFT JOIN knowledge_bases kb ON kb.id=d.kb_id
    LEFT JOIN LATERAL (
      SELECT id, title, remind_at, status
      FROM assistant_tasks
      WHERE source_message_id=m.id OR (from_user=m.from_user AND created_at BETWEEN m.received_at - interval '5 seconds' AND m.received_at + interval '30 seconds')
      ORDER BY created_at DESC
      LIMIT 1
    ) t ON true
    WHERE m.id=$1`, [messageId]);
  return result.rows[0] || null;
}

async function deleteWechatMessageLinks(message) {
  const deleted = [];
  if (message.finance_entry_id) {
    const result = await pool.query('DELETE FROM finance_entries WHERE id=$1 RETURNING id,title,amount', [message.finance_entry_id]);
    if (result.rowCount) deleted.push({ type: 'finance', row: result.rows[0] });
  }
  if (message.fitness_entry_id) {
    const result = await pool.query('DELETE FROM fitness_entries WHERE id=$1 RETURNING id,entry_type,note', [message.fitness_entry_id]);
    if (result.rowCount) deleted.push({ type: 'fitness', row: result.rows[0] });
  }
  if (message.knowledge_document_id) {
    const deletedDoc = await deleteKnowledgeDocument(message.knowledge_document_id);
    if (deletedDoc) deleted.push({ type: 'knowledge_document', id: message.knowledge_document_id });
  }
  if (message.task_id) {
    const result = await pool.query('DELETE FROM assistant_tasks WHERE id=$1 RETURNING id,title', [message.task_id]);
    if (result.rowCount) deleted.push({ type: 'task', row: result.rows[0] });
  }
  await pool.query(
    `UPDATE wechat_messages
     SET finance_entry_id=NULL, fitness_entry_id=NULL, knowledge_document_id=NULL
     WHERE id=$1`,
    [message.id]
  );
  return deleted;
}

async function reprocessWechatMessage(messageId) {
  const original = await getWechatInboxRow(messageId);
  if (!original) throw new Error('消息不存在');
  if (original.msg_type !== 'text') throw new Error('目前只支持重新处理文本消息');
  await deleteWechatMessageLinks(original);
  const fresh = await saveWechatMessage({
    from_user: original.from_user,
    to_user: original.to_user,
    msg_type: original.msg_type,
    content: original.content,
    raw_payload: { ...(original.raw_payload || {}), reprocessed_from: original.id },
  });
  await pool.query(
    `UPDATE wechat_messages
     SET finance_entry_id=$1, fitness_entry_id=$2, knowledge_document_id=$3, intent=$4, parse_status=$5, reply_text=$6
     WHERE id=$7`,
    [
      fresh.message.finance_entry_id || null,
      fresh.message.fitness_entry_id || null,
      fresh.message.knowledge_document_id || null,
      fresh.message.intent,
      fresh.message.parse_status,
      fresh.message.reply_text,
      original.id,
    ]
  );
  await pool.query('DELETE FROM wechat_messages WHERE id=$1', [fresh.message.id]);
  return getWechatInboxRow(original.id);
}

async function retryFailedWechatMessages({ limit = 10, notify = false } = {}) {
  const result = await pool.query(`
    SELECT * FROM wechat_messages
    WHERE parse_status='failed'
      AND msg_type='text'
      AND COALESCE(retry_count,0) < 3
      AND (next_retry_at IS NULL OR next_retry_at <= now())
    ORDER BY received_at ASC
    LIMIT $1`, [Math.min(50, Math.max(1, Number(limit || 10)))]);
  const rows = [];
  for (const row of result.rows) {
    try {
      const reprocessed = await reprocessWechatMessage(row.id);
      await pool.query("UPDATE wechat_messages SET retry_count=COALESCE(retry_count,0)+1, next_retry_at=NULL, last_error=NULL WHERE id=$1", [row.id]);
      rows.push({ id: row.id, ok: true, status: reprocessed.parse_status, intent: reprocessed.intent });
      if (notify && row.from_user) await notifyBySubscription('wechat_retry_failed', `之前失败的消息 #${row.id} 已重新处理：${reprocessed.reply_text || reprocessed.intent}`, { fallbackUser: row.from_user }).catch(() => {});
    } catch (error) {
      const retryCount = Number(row.retry_count || 0) + 1;
      const minutes = Math.min(60, 5 * retryCount);
      await pool.query(
        `UPDATE wechat_messages
         SET retry_count=$1, next_retry_at=now()+($2 || ' minutes')::interval, last_error=$3
         WHERE id=$4`,
        [retryCount, String(minutes), error.message, row.id]
      );
      rows.push({ id: row.id, ok: false, retry_count: retryCount, error: error.message });
      if (notify && retryCount >= 3) await notifyBySubscription('wechat_retry_failed', `消息 #${row.id} 多次处理失败，已进入待处理队列。原因：${error.message}`, { fallbackUser: row.from_user }).catch(() => {});
    }
  }
  return { processed: rows.length, rows };
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health') {
    const [chromaOk, embedding] = await Promise.all([
      chromaHeartbeat(),
      Promise.resolve(getEmbeddingStatus()),
    ]);
    return sendJson(res, 200, {
      ok: true,
      chroma: chromaOk,
      knowledge_collection: KNOWLEDGE_COLLECTION,
      embedding,
    });
  }
  if (url.pathname === '/api/wechat/webhook' && req.method === 'GET') {
    if (!verifyWechatSignature(url)) return sendJson(res, 403, { error: 'invalid signature' });
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(url.searchParams.get('echostr') || 'ok');
  }
  if (url.pathname === '/api/wechat/work-webhook' && req.method === 'GET') {
    const echo = url.searchParams.get('echostr') || '';
    if (!verifyWechatWorkSignature(url, echo)) return sendJson(res, 403, { error: 'invalid signature' });
    const plainEcho = WECHAT_WORK_ENCODING_AES_KEY ? decryptWechatWork(echo).xml : echo;
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(plainEcho);
  }
  if (url.pathname === '/api/wechat/work-webhook' && req.method === 'POST') {
    const body = await readTextBody(req);
    const encrypted = xmlValue(body, 'Encrypt');
    if (!verifyWechatWorkSignature(url, encrypted || body)) return sendJson(res, 403, { error: 'invalid signature' });
    const xml = encrypted && WECHAT_WORK_ENCODING_AES_KEY ? decryptWechatWork(encrypted).xml : body;
    const payload = parseWechatXml(xml);
    console.log(`[wechat] inbound ${payload.msg_type} from ${payload.from_user || 'unknown'}${payload.file_name ? ` file=${payload.file_name}` : ''}`);
    if (payload.msg_type === 'file' && (payload.media_id || payload.MediaId)) {
      const initial = await recordWechatMessageRow({
        from_user: payload.from_user,
        to_user: payload.to_user,
        msg_type: payload.msg_type,
        content: payload.file_name || payload.FileName || payload.content || '',
        raw_payload: { provider: 'wechat_work', encrypted: Boolean(encrypted), xml, ...payload },
        financeEntry: null,
        fitnessEntry: null,
        knowledgeDocument: null,
        intent: 'knowledge.upload_pending',
        status: 'processing',
        reply: '收到文件，正在写入知识库，请稍候…',
        sourceMsgType: payload.msg_type,
        mediaId: payload.media_id || payload.MediaId,
        mediaStatus: 'downloading',
        mediaError: null,
      });
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end(wechatWorkReply(payload.to_user, payload.from_user, '收到文件，正在写入知识库，请稍候…', url));
      processWechatFileUploadAsync({
        ...payload,
        message_id: initial.message.id,
        raw_payload: { provider: 'wechat_work', encrypted: Boolean(encrypted), xml, ...payload },
      }).catch((error) => console.error('[wechat] async upload', error.message));
      return;
    }
    const saved = await saveWechatMessage({ ...payload, raw_payload: { provider: 'wechat_work', encrypted: Boolean(encrypted), public_base_url: requestBaseUrl(req), xml, ...payload } });
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
    return res.end(wechatWorkReply(payload.to_user, payload.from_user, saved.reply, url));
  }
  if (url.pathname === '/api/wechat/upload-token' && req.method === 'GET') {
    const token = url.searchParams.get('token') || '';
    const target = await consumeKnowledgeUploadToken(token);
    if (!target) return sendJson(res, 404, { error: '上传链接不存在或已过期' });
    return sendJson(res, 200, { kb_name: target.kb.name, expires_at: target.data.expires_at, from_user: target.memory.from_user });
  }
  if (url.pathname === '/api/wechat/upload-token' && req.method === 'POST') {
    const token = url.searchParams.get('token') || '';
    const target = await claimKnowledgeUploadToken(token);
    if (!target) return sendJson(res, 404, { error: '上传链接不存在或已过期' });
    const { fields, files } = await parseMultipart(req);
    const file = files[0];
    if (!file) return sendJson(res, 400, { error: 'file required' });
    await mkdir(UPLOAD_DIR, { recursive: true });
    const safeName = `${Date.now()}_${file.filename || 'wechat-upload'}`.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, '_');
    const filePath = path.join(UPLOAD_DIR, safeName);
    await writeFile(filePath, file.buffer);
    const rawText = await parseDocumentBuffer(file.buffer, file.filename, 'upload');
    if (!rawText.trim()) return sendJson(res, 400, { error: '文件没有解析出文本内容' });
    const doc = await pool.query(
      `INSERT INTO knowledge_documents (kb_id,title,source_type,filename,file_path,source_user,source_channel,source_note,raw_text,status)
       VALUES ($1,$2,'wechat_link_upload',$3,$4,$5,'wechat',$6,$7,'processing') RETURNING *`,
      [target.kb.id, fields.title || file.filename || safeName, file.filename || safeName, filePath, target.memory.from_user || null, '企业微信上传链接', rawText]
    );
    const processed = await processKnowledgeDocument(doc.rows[0].id);
    await recordWechatMessageRow({
      from_user: target.memory.from_user,
      to_user: 'wechat-upload-link',
      msg_type: 'file',
      content: file.filename || safeName,
      raw_payload: { provider: 'wechat_upload_link', token_used: true, kb_id: target.kb.id, filename: file.filename || safeName },
      financeEntry: null,
      fitnessEntry: null,
      knowledgeDocument: doc.rows[0],
      intent: 'knowledge.upload_link',
      status: 'recorded',
      reply: `已通过上传链接写入知识库「${target.kb.name}」：${doc.rows[0].title}，切分 ${processed.chunks} 段。`,
      sourceMsgType: 'file',
      mediaStatus: 'imported',
    });
    if (target.memory.from_user && WECHAT_WORK_AGENT_ID) {
      sendWechatWorkTextMessage(target.memory.from_user, `已写入知识库「${target.kb.name}」：${doc.rows[0].title}，切分 ${processed.chunks} 段。`).catch((error) => console.error('[wechat] upload-link notify failed:', error.message));
    }
    return sendJson(res, 201, { kb: target.kb, document: doc.rows[0], processed });
  }
  if (url.pathname === '/api/wechat/webhook' && req.method === 'POST') {
    if (!verifyWechatSignature(url)) return sendJson(res, 403, { error: 'invalid signature' });
    const xml = await readTextBody(req);
    const payload = parseWechatXml(xml);
    const saved = await saveWechatMessage({ ...payload, raw_payload: { public_base_url: requestBaseUrl(req), xml, ...payload } });
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
    return res.end(wechatTextReply(payload.to_user, payload.from_user, saved.reply));
  }
  if (url.pathname === '/api/wechat/test-message' && req.method === 'POST') {
    const data = await jsonBody(req);
    const saved = await saveWechatMessage({
      from_user: data.from_user || 'local-test-user',
      to_user: data.to_user || 'ai-key-hub',
      msg_type: data.msg_type || 'text',
      content: data.content || '',
      raw_payload: data,
    });
    return sendJson(res, 201, saved);
  }
  if (url.pathname === '/api/wechat/test-file' && req.method === 'POST') {
    const data = await jsonBody(req);
    const fromUser = data.from_user || 'local-test-user';
    const kb = await consumeNextKnowledgeUploadTarget(fromUser) || await resolveUserKnowledgeBase(fromUser);
    const filename = data.filename || 'wechat-test.txt';
    const buffer = Buffer.from(data.content || '', 'utf8');
    await mkdir(UPLOAD_DIR, { recursive: true });
    const safeName = `${Date.now()}_${filename}`.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, '_');
    const filePath = path.join(UPLOAD_DIR, safeName);
    await writeFile(filePath, buffer);
    const rawText = await parseDocumentBuffer(buffer, filename, 'upload');
    const doc = await pool.query(
      `INSERT INTO knowledge_documents (kb_id,title,source_type,filename,file_path,raw_text,status)
       VALUES ($1,$2,'wechat_upload_test',$3,$4,$5,'processing') RETURNING *`,
      [kb.id, path.basename(filename), filename, filePath, rawText]
    );
    const processed = await processKnowledgeDocument(doc.rows[0].id);
    return sendJson(res, 201, { kb, document: doc.rows[0], processed });
  }
  if (url.pathname === '/api/finance/entries' && req.method === 'GET') {
    const q = url.searchParams.get('q');
    const category = url.searchParams.get('category');
    const direction = url.searchParams.get('direction');
    const result = await pool.query(`
      SELECT * FROM finance_entries
      WHERE ($1::text IS NULL OR title ILIKE '%'||$1||'%' OR note ILIKE '%'||$1||'%' OR category ILIKE '%'||$1||'%' OR raw_message ILIKE '%'||$1||'%')
        AND ($2::text IS NULL OR category=$2)
        AND ($3::text IS NULL OR direction=$3)
      ORDER BY occurred_at DESC, id DESC LIMIT 300`, [q || null, category || null, direction || null]);
    return sendJson(res, 200, result.rows);
  }
  if (url.pathname === '/api/finance/summary' && req.method === 'GET') {
    const [month, categories, trend] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE direction='expense'),0)::float expense, COALESCE(SUM(amount) FILTER (WHERE direction='income'),0)::float income FROM finance_entries WHERE occurred_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'`),
      pool.query(`SELECT category, direction, COUNT(*)::int count, COALESCE(SUM(amount),0)::float amount FROM finance_entries WHERE occurred_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai' GROUP BY category,direction ORDER BY amount DESC LIMIT 20`),
      pool.query(`SELECT (occurred_at AT TIME ZONE 'Asia/Shanghai')::date record_day, COALESCE(SUM(amount) FILTER (WHERE direction='expense'),0)::float expense, COALESCE(SUM(amount) FILTER (WHERE direction='income'),0)::float income FROM finance_entries WHERE occurred_at >= now() - interval '30 days' GROUP BY record_day ORDER BY record_day ASC`),
    ]);
    return sendJson(res, 200, { month: { ...month.rows[0], balance: Number(month.rows[0].income || 0) - Number(month.rows[0].expense || 0) }, categories: categories.rows, trend: trend.rows });
  }
  const financeEntryMatch = url.pathname.match(/^\/api\/finance\/entries\/(\d+)$/);
  if (financeEntryMatch && req.method === 'PATCH') {
    const data = await jsonBody(req);
    const result = await pool.query(`
      UPDATE finance_entries
      SET direction=COALESCE($1,direction), amount=COALESCE($2,amount), category=COALESCE($3,category), title=COALESCE($4,title), note=COALESCE($5,note), occurred_at=COALESCE(CASE WHEN $6::text IS NULL THEN NULL ELSE $6::timestamp AT TIME ZONE 'Asia/Shanghai' END, occurred_at)
      WHERE id=$7 RETURNING *`, [data.direction || null, data.amount === undefined ? null : numberOrNull(data.amount), data.category || null, data.title || null, data.note === undefined ? null : String(data.note || ''), data.occurred_at || null, Number(financeEntryMatch[1])]);
    await auditLog(req, { action: 'finance.update', entityType: 'finance_entry', entityId: financeEntryMatch[1], detail: data });
    return sendJson(res, result.rowCount ? 200 : 404, result.rowCount ? result.rows[0] : { error: 'not found' });
  }
  if (financeEntryMatch && req.method === 'DELETE') {
    await pool.query('UPDATE wechat_messages SET finance_entry_id=NULL WHERE finance_entry_id=$1', [Number(financeEntryMatch[1])]);
    const result = await pool.query('DELETE FROM finance_entries WHERE id=$1', [Number(financeEntryMatch[1])]);
    await auditLog(req, { action: 'finance.delete', entityType: 'finance_entry', entityId: financeEntryMatch[1], detail: { deleted: result.rowCount > 0 } });
    return sendJson(res, 200, { deleted: result.rowCount > 0 });
  }
  if (url.pathname === '/api/wechat/messages' && req.method === 'GET') {
    const result = await pool.query('SELECT * FROM wechat_messages ORDER BY received_at DESC, id DESC LIMIT 100');
    return sendJson(res, 200, result.rows);
  }
  if (url.pathname === '/api/wechat/inbox' && req.method === 'GET') {
    return sendJson(res, 200, await listWechatInbox(url));
  }
  const inboxMatch = url.pathname.match(/^\/api\/wechat\/inbox\/(\d+)$/);
  if (inboxMatch && req.method === 'GET') {
    const row = await getWechatInboxRow(Number(inboxMatch[1]));
    if (!row) return sendJson(res, 404, { error: 'message not found' });
    return sendJson(res, 200, row);
  }
  const inboxReprocessMatch = url.pathname.match(/^\/api\/wechat\/inbox\/(\d+)\/reprocess$/);
  if (inboxReprocessMatch && req.method === 'POST') {
    try {
      const row = await reprocessWechatMessage(Number(inboxReprocessMatch[1]));
      await auditLog(req, { action: 'wechat_message.reprocess', entityType: 'wechat_message', entityId: inboxReprocessMatch[1], detail: { intent: row.intent, parse_status: row.parse_status } });
      return sendJson(res, 200, { message: row });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }
  const inboxCorrectMatch = url.pathname.match(/^\/api\/wechat\/inbox\/(\d+)\/correct$/);
  if (inboxCorrectMatch && req.method === 'POST') {
    const messageId = Number(inboxCorrectMatch[1]);
    const data = await jsonBody(req);
    const row = await getWechatInboxRow(messageId);
    if (!row) return sendJson(res, 404, { error: 'message not found' });
    let result = null;
    if (data.action === 'finance_category' && row.finance_entry_id) {
      result = await pool.query('UPDATE finance_entries SET category=$1 WHERE id=$2 RETURNING *', [data.value || '未分类', row.finance_entry_id]);
      const pattern = learnPatternFromText(row.content || row.finance_title || '');
      if (pattern) await saveAssistantRule({ fromUser: row.from_user, ruleType: 'finance_category', pattern, value: data.value || '未分类', source: 'manual_correction' });
    } else if (data.action === 'finance_direction' && row.finance_entry_id) {
      result = await pool.query('UPDATE finance_entries SET direction=$1 WHERE id=$2 RETURNING *', [data.value === 'income' ? 'income' : 'expense', row.finance_entry_id]);
    } else if (data.action === 'save_memory') {
      result = { rows: [await saveAssistantMemory({ fromUser: row.from_user, category: data.category || 'general', content: data.value || row.content, importance: data.importance || 3, source: 'correction' })], rowCount: 1 };
    } else if (data.action === 'delete_links') {
      result = { rows: [await deleteWechatMessageLinks(row)], rowCount: 1 };
    } else {
      return sendJson(res, 400, { error: 'unsupported correction action or missing linked record' });
    }
    await auditLog(req, { action: 'wechat_message.correct', entityType: 'wechat_message', entityId: messageId, detail: data });
    return sendJson(res, 200, { ok: true, result: result.rows[0], message: await getWechatInboxRow(messageId) });
  }
  const inboxUndoMatch = url.pathname.match(/^\/api\/wechat\/inbox\/(\d+)\/undo$/);
  if (inboxUndoMatch && req.method === 'POST') {
    const row = await getWechatInboxRow(Number(inboxUndoMatch[1]));
    if (!row) return sendJson(res, 404, { error: 'message not found' });
    const deleted = await deleteWechatMessageLinks(row);
    await pool.query("UPDATE wechat_messages SET correction_status='undone' WHERE id=$1", [row.id]);
    await auditLog(req, { action: 'wechat_message.undo', entityType: 'wechat_message', entityId: row.id, detail: { deleted } });
    return sendJson(res, 200, { ok: true, deleted, message: await getWechatInboxRow(row.id) });
  }
  const inboxLinksMatch = url.pathname.match(/^\/api\/wechat\/inbox\/(\d+)\/links$/);
  if (inboxLinksMatch && req.method === 'DELETE') {
    const row = await getWechatInboxRow(Number(inboxLinksMatch[1]));
    if (!row) return sendJson(res, 404, { error: 'message not found' });
    const deleted = await deleteWechatMessageLinks(row);
    const updated = await getWechatInboxRow(Number(inboxLinksMatch[1]));
    await auditLog(req, { action: 'wechat_message.unlink', entityType: 'wechat_message', entityId: inboxLinksMatch[1], detail: deleted });
    return sendJson(res, 200, { deleted, message: updated });
  }
  if (url.pathname === '/api/assistant/rules' && req.method === 'GET') {
    const ruleType = url.searchParams.get('rule_type');
    const result = await pool.query(
      `SELECT * FROM assistant_rules
       WHERE ($1::text IS NULL OR rule_type=$1)
       ORDER BY enabled DESC, priority ASC, updated_at DESC
       LIMIT 200`,
      [ruleType || null]
    );
    return sendJson(res, 200, result.rows);
  }
  if (url.pathname === '/api/assistant/rules' && req.method === 'POST') {
    const data = await jsonBody(req);
    const rule = await saveAssistantRule({
      fromUser: data.from_user || null,
      ruleType: data.rule_type || 'finance_category',
      pattern: data.pattern,
      value: data.value,
      priority: data.priority || 50,
      source: 'manual',
    });
    if (!rule) return sendJson(res, 400, { error: 'pattern and value required' });
    await auditLog(req, { action: 'assistant_rule.create', entityType: 'assistant_rule', entityId: rule.id, detail: { rule_type: rule.rule_type, pattern: rule.pattern, value: rule.value } });
    return sendJson(res, 201, rule);
  }
  const ruleMatch = url.pathname.match(/^\/api\/assistant\/rules\/(\d+)$/);
  if (ruleMatch && req.method === 'PATCH') {
    const data = await jsonBody(req);
    const result = await pool.query(
      `UPDATE assistant_rules
       SET value=COALESCE($1,value), priority=COALESCE($2,priority), enabled=COALESCE($3,enabled), updated_at=now()
       WHERE id=$4 RETURNING *`,
      [data.value || null, data.priority === undefined ? null : Number(data.priority), data.enabled === undefined ? null : Boolean(data.enabled), Number(ruleMatch[1])]
    );
    if (result.rowCount) await auditLog(req, { action: 'assistant_rule.update', entityType: 'assistant_rule', entityId: ruleMatch[1], detail: data });
    return sendJson(res, result.rowCount ? 200 : 404, result.rowCount ? result.rows[0] : { error: 'not found' });
  }
  if (ruleMatch && req.method === 'DELETE') {
    const result = await pool.query('DELETE FROM assistant_rules WHERE id=$1', [Number(ruleMatch[1])]);
    await auditLog(req, { action: 'assistant_rule.delete', entityType: 'assistant_rule', entityId: ruleMatch[1], detail: { deleted: result.rowCount > 0 } });
    return sendJson(res, 200, { deleted: result.rowCount > 0 });
  }
  if (url.pathname === '/api/wechat/user-profiles' && req.method === 'GET') {
    const result = await pool.query(`
      SELECT p.*, kb.name default_kb_name
      FROM wechat_user_profiles p
      LEFT JOIN knowledge_bases kb ON kb.id=p.default_kb_id
      ORDER BY p.enabled DESC, p.updated_at DESC
      LIMIT 200`);
    return sendJson(res, 200, result.rows);
  }
  if (url.pathname === '/api/wechat/user-profiles' && req.method === 'POST') {
    const data = await jsonBody(req);
    try {
      const profile = await ensureWechatUserProfile(data.from_user, data);
      await auditLog(req, { action: 'wechat_profile.upsert', entityType: 'wechat_user_profile', entityId: profile.from_user, detail: { display_name: profile.display_name, enabled: profile.enabled, default_kb_id: profile.default_kb_id } });
      return sendJson(res, 201, profile);
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }
  const profileMatch = url.pathname.match(/^\/api\/wechat\/user-profiles\/([^/]+)$/);
  if (profileMatch && req.method === 'PATCH') {
    const fromUser = decodeURIComponent(profileMatch[1]);
    const current = await pool.query('SELECT * FROM wechat_user_profiles WHERE from_user=$1', [fromUser]);
    if (!current.rowCount) return sendJson(res, 404, { error: 'not found' });
    const data = { ...current.rows[0], ...(await jsonBody(req)) };
    const profile = await ensureWechatUserProfile(fromUser, data);
    await auditLog(req, { action: 'wechat_profile.update', entityType: 'wechat_user_profile', entityId: fromUser, detail: { display_name: profile.display_name, enabled: profile.enabled, default_kb_id: profile.default_kb_id } });
    return sendJson(res, 200, profile);
  }
  if (profileMatch && req.method === 'DELETE') {
    const result = await pool.query('DELETE FROM wechat_user_profiles WHERE from_user=$1', [decodeURIComponent(profileMatch[1])]);
    await auditLog(req, { action: 'wechat_profile.delete', entityType: 'wechat_user_profile', entityId: decodeURIComponent(profileMatch[1]), detail: { deleted: result.rowCount > 0 } });
    return sendJson(res, 200, { deleted: result.rowCount > 0 });
  }
  if (url.pathname === '/api/timeline' && req.method === 'GET') return sendJson(res, 200, await listTimeline(url));
  if (url.pathname === '/api/audit-logs' && req.method === 'GET') {
    const result = await pool.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200');
    return sendJson(res, 200, result.rows);
  }
  if (url.pathname === '/api/system/status' && req.method === 'GET') return sendJson(res, 200, await systemStatus());
  if (url.pathname === '/api/system/events' && req.method === 'GET') return sendJson(res, 200, await listSystemEvents(url));
  if (url.pathname === '/api/config/status' && req.method === 'GET') return sendJson(res, 200, await appConfigStatus());
  if (url.pathname === '/api/wechat/diagnostics' && req.method === 'GET') return sendJson(res, 200, await wechatDiagnostics());
  if (url.pathname === '/api/notifications' && req.method === 'GET') return sendJson(res, 200, await listNotificationSubscriptions());
  const notificationMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)$/);
  if (notificationMatch && req.method === 'PATCH') {
    const data = await jsonBody(req);
    const row = await updateNotificationSubscription(decodeURIComponent(notificationMatch[1]), data);
    if (!row) return sendJson(res, 404, { error: 'notification not found' });
    await auditLog(req, { action: 'notification.update', entityType: 'notification_subscription', entityId: row.notification_type, detail: data });
    return sendJson(res, 200, row);
  }
  if (url.pathname === '/api/stats') return sendJson(res, 200, await stats());
  if (url.pathname === '/api/balances/refresh' && req.method === 'POST') {
    return sendJson(res, 200, { updated_at: new Date().toISOString(), results: await refreshProviderBalances() });
  }
  if (url.pathname === '/api/providers' && req.method === 'GET') {
    const result = await pool.query(`
      SELECT p.*, COUNT(DISTINCT k.id)::int key_count, COUNT(DISTINCT m.id)::int model_count,
             COALESCE(SUM(DISTINCT k.used_amount),0)::float used_amount
      FROM providers p
      LEFT JOIN api_keys k ON k.provider_id = p.id
      LEFT JOIN models m ON m.provider_id = p.id
      GROUP BY p.id
      ORDER BY p.id`);
    return sendJson(res, 200, result.rows);
  }
  if (url.pathname === '/api/usage/hourly' && req.method === 'GET') {
    const result = await pool.query(`
      SELECT date_trunc('hour', created_at) bucket,
             COUNT(*)::int calls,
             COALESCE(SUM("cost"),0)::float usage_cost,
             COALESCE(AVG(latency_ms),0)::int avg_latency
      FROM usage_logs
      WHERE created_at >= now() - interval '24 hours'
      GROUP BY bucket
      ORDER BY bucket DESC`);
    return sendJson(res, 200, result.rows);
  }
  if (url.pathname === '/api/keys' && req.method === 'GET') {
    const result = await pool.query(`
      SELECT k.*, p.name provider_name, p.code provider_code, p.base_url,
             p.balance provider_balance, p.currency provider_currency, p.low_balance_threshold,
             COALESCE(today_usage.usage_cost_sum,0)::float today_used_amount,
             COALESCE(month_usage.usage_cost_sum,0)::float month_used_amount,
             k.api_key AS raw_key
      FROM api_keys k JOIN providers p ON p.id = k.provider_id
      LEFT JOIN (
        SELECT api_key_id, SUM(ul."cost") AS usage_cost_sum
        FROM usage_logs ul
        WHERE ul.created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
        GROUP BY api_key_id
      ) today_usage ON today_usage.api_key_id = k.id
      LEFT JOIN (
        SELECT api_key_id, SUM(ul."cost") AS usage_cost_sum
        FROM usage_logs ul
        WHERE ul.created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
        GROUP BY api_key_id
      ) month_usage ON month_usage.api_key_id = k.id
      ORDER BY k.id DESC`);
    return sendJson(res, 200, result.rows.map(publicKeyRow));
  }
  if (url.pathname === '/api/keys' && req.method === 'POST') {
    const data = await jsonBody(req);
    const secret = encryptSecret(data.api_key);
    const result = await pool.query(
      `INSERT INTO api_keys (provider_id, name, api_key, api_key_encrypted, api_key_iv, api_key_tag, key_encryption_version, status, monthly_quota, used_amount, remark)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [data.provider_id, data.name, secret.api_key, secret.api_key_encrypted, secret.api_key_iv, secret.api_key_tag, secret.key_encryption_version, data.status || 'active', data.monthly_quota || 0, data.used_amount || 0, data.remark || '']
    );
    await auditLog(req, { action: 'api_key.create', entityType: 'api_key', entityId: result.rows[0].id, detail: { provider_id: data.provider_id, name: data.name, status: data.status || 'active' } });
    return sendJson(res, 201, publicKeyRow(result.rows[0]));
  }
  const keyMatch = url.pathname.match(/^\/api\/keys\/(\d+)$/);
  if (keyMatch && req.method === 'PUT') {
    const id = Number(keyMatch[1]);
    const data = await jsonBody(req);
    const current = await pool.query('SELECT * FROM api_keys WHERE id=$1', [id]);
    if (!current.rowCount) return sendJson(res, 404, { error: 'not found' });
    const keepExistingSecret = !data.api_key || String(data.api_key).includes('***');
    const secret = keepExistingSecret ? current.rows[0] : encryptSecret(data.api_key);
    const result = await pool.query(
      `UPDATE api_keys
       SET provider_id=$1,name=$2,api_key=$3,api_key_encrypted=$4,api_key_iv=$5,api_key_tag=$6,key_encryption_version=$7,
           status=$8,monthly_quota=$9,used_amount=$10,remark=$11,updated_at=now()
       WHERE id=$12 RETURNING *`,
      [data.provider_id, data.name, secret.api_key, secret.api_key_encrypted, secret.api_key_iv, secret.api_key_tag, secret.key_encryption_version || 0, data.status || 'active', data.monthly_quota || 0, data.used_amount || 0, data.remark || '', id]
    );
    await auditLog(req, { action: 'api_key.update', entityType: 'api_key', entityId: id, detail: { provider_id: data.provider_id, name: data.name, status: data.status || 'active', changed_secret: !keepExistingSecret } });
    return sendJson(res, result.rowCount ? 200 : 404, result.rowCount ? publicKeyRow(result.rows[0]) : { error: 'not found' });
  }
  const budgetMatch = url.pathname.match(/^\/api\/keys\/(\d+)\/budget$/);
  if (budgetMatch && req.method === 'PUT') {
    const id = Number(budgetMatch[1]);
    const data = await jsonBody(req);
    const dailyQuota = Number(data.daily_quota || 0);
    const monthlyQuota = Number(data.monthly_quota || 0);
    const budgetAction = ['alert', 'disable_copy', 'disable_key'].includes(data.budget_action) ? data.budget_action : 'alert';
    const result = await pool.query(
      `UPDATE api_keys
       SET daily_quota=$1, monthly_quota=$2, budget_action=$3, remark=$4, updated_at=now()
       WHERE id=$5 RETURNING *`,
      [dailyQuota, monthlyQuota, budgetAction, data.remark || '', id]
    );
    if (result.rowCount) await auditLog(req, { action: 'api_key.budget_update', entityType: 'api_key', entityId: id, detail: { daily_quota: dailyQuota, monthly_quota: monthlyQuota, budget_action: budgetAction } });
    return sendJson(res, result.rowCount ? 200 : 404, result.rowCount ? publicKeyRow(result.rows[0]) : { error: 'not found' });
  }
  if (keyMatch && req.method === 'DELETE') {
    const result = await pool.query('DELETE FROM api_keys WHERE id=$1', [Number(keyMatch[1])]);
    await auditLog(req, { action: 'api_key.delete', entityType: 'api_key', entityId: keyMatch[1], detail: { deleted: result.rowCount > 0 } });
    return sendJson(res, 200, { deleted: result.rowCount > 0 });
  }
  const copyMatch = url.pathname.match(/^\/api\/keys\/(\d+)\/copy$/);
  if (copyMatch && req.method === 'GET') {
    const mode = url.searchParams.get('mode') || 'key';
    const model = url.searchParams.get('model') || '';
    const result = await pool.query('SELECT k.*, p.* FROM api_keys k JOIN providers p ON p.id=k.provider_id WHERE k.id=$1', [Number(copyMatch[1])]);
    if (!result.rowCount) return sendJson(res, 404, { error: 'not found' });
    const row = result.rows[0];
    await auditLog(req, { action: 'api_key.copy', entityType: 'api_key', entityId: copyMatch[1], detail: { mode, model } });
    return sendJson(res, 200, { mode, content: copyPayload(row, row, mode, model) });
  }
  if (url.pathname === '/api/models' && req.method === 'GET') {
    const result = await pool.query('SELECT m.*, p.name provider_name, p.code provider_code FROM models m JOIN providers p ON p.id=m.provider_id ORDER BY p.id,m.name');
    return sendJson(res, 200, result.rows);
  }
  if (url.pathname === '/api/fitness/summary' && req.method === 'GET') {
    const [latestWeight, weightTrend, todayMeals, todayWorkout, recentAdvice, dailyRecords] = await Promise.all([
      pool.query("SELECT weight_kg, recorded_at FROM fitness_entries WHERE entry_type='weight' AND weight_kg IS NOT NULL ORDER BY recorded_at DESC LIMIT 1"),
      pool.query("SELECT recorded_at, weight_kg FROM fitness_entries WHERE entry_type='weight' AND weight_kg IS NOT NULL AND recorded_at >= now() - interval '30 days' ORDER BY recorded_at ASC"),
      pool.query("SELECT COUNT(*)::int count, COALESCE(SUM(calories),0)::float calories FROM fitness_entries WHERE entry_type='meal' AND recorded_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'"),
      pool.query("SELECT COUNT(*)::int count, COALESCE(SUM(duration_min),0)::int duration_min, COALESCE(SUM(burned_calories),0)::float burned_calories FROM fitness_entries WHERE entry_type='workout' AND recorded_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'"),
      pool.query('SELECT r.* FROM fitness_ai_reports r JOIN fitness_entries e ON e.id=r.entry_id ORDER BY r.created_at DESC LIMIT 1'),
      pool.query(`
        SELECT (recorded_at AT TIME ZONE 'Asia/Shanghai')::date record_day,
               COUNT(*) FILTER (WHERE entry_type='meal')::int meal_count,
               COALESCE(SUM(calories) FILTER (WHERE entry_type='meal'),0)::float calories,
               COALESCE(SUM(duration_min) FILTER (WHERE entry_type='workout'),0)::int workout_min,
               COALESCE(SUM(burned_calories) FILTER (WHERE entry_type='workout'),0)::float burned_calories,
               COALESCE(AVG(sleep_hours) FILTER (WHERE entry_type='sleep'),0)::float sleep_hours
        FROM fitness_entries
        WHERE recorded_at >= now() - interval '30 days'
        GROUP BY record_day
        ORDER BY record_day ASC`),
    ]);
    const weight = latestWeight.rows[0]?.weight_kg ? Number(latestWeight.rows[0].weight_kg) : null;
    const heightM = PROFILE_HEIGHT_CM / 100;
    const bmi = weight ? Number((weight / (heightM * heightM)).toFixed(1)) : null;
    return sendJson(res, 200, {
      profile: { height_cm: PROFILE_HEIGHT_CM, bmi },
      latest_weight: latestWeight.rows[0] || null,
      weight_trend: weightTrend.rows,
      daily_records: dailyRecords.rows,
      today_meals: todayMeals.rows[0],
      today_workout: todayWorkout.rows[0],
      latest_advice: recentAdvice.rows[0] || null,
    });
  }
  if (url.pathname === '/api/fitness/entries' && req.method === 'GET') {
    const result = await pool.query(`
      SELECT e.*, r.summary ai_summary, r.advice ai_advice, r.risk_level ai_risk_level
      FROM fitness_entries e
      LEFT JOIN LATERAL (
        SELECT * FROM fitness_ai_reports r WHERE r.entry_id=e.id ORDER BY r.created_at DESC LIMIT 1
      ) r ON true
      ORDER BY e.recorded_at DESC, e.id DESC
      LIMIT 100`);
    return sendJson(res, 200, result.rows);
  }
  if (url.pathname === '/api/fitness/entries' && req.method === 'POST') {
    const data = await jsonBody(req);
    const created = await createFitnessEntry(data);
    return sendJson(res, 201, created);
  }
  const fitnessEntryMatch = url.pathname.match(/^\/api\/fitness\/entries\/(\d+)$/);
  if (fitnessEntryMatch && req.method === 'DELETE') {
    await pool.query('UPDATE wechat_messages SET fitness_entry_id=NULL WHERE fitness_entry_id=$1', [Number(fitnessEntryMatch[1])]);
    const result = await pool.query('DELETE FROM fitness_entries WHERE id=$1', [Number(fitnessEntryMatch[1])]);
    await auditLog(req, { action: 'fitness.delete', entityType: 'fitness_entry', entityId: fitnessEntryMatch[1], detail: { deleted: result.rowCount > 0 } });
    return sendJson(res, 200, { deleted: result.rowCount > 0 });
  }
  if (url.pathname === '/api/knowledge/summary' && req.method === 'GET') {
    const [bases, docs, chunks, queries] = await Promise.all([
      pool.query('SELECT COUNT(*)::int count FROM knowledge_bases'),
      pool.query('SELECT COUNT(*)::int count FROM knowledge_documents'),
      pool.query('SELECT COUNT(*)::int count FROM knowledge_chunks'),
      pool.query('SELECT COUNT(*)::int count FROM knowledge_queries'),
    ]);
    return sendJson(res, 200, { bases: bases.rows[0].count, documents: docs.rows[0].count, chunks: chunks.rows[0].count, queries: queries.rows[0].count });
  }
  if (url.pathname === '/api/knowledge/bases' && req.method === 'GET') {
    const result = await pool.query(`
      SELECT b.*, COUNT(DISTINCT d.id)::int document_count, COUNT(DISTINCT c.id)::int chunk_count
      FROM knowledge_bases b
      LEFT JOIN knowledge_documents d ON d.kb_id=b.id
      LEFT JOIN knowledge_chunks c ON c.kb_id=b.id
      GROUP BY b.id
      ORDER BY b.updated_at DESC, b.id DESC`);
    return sendJson(res, 200, result.rows);
  }
  if (url.pathname === '/api/knowledge/categories' && req.method === 'GET') {
    const result = await pool.query(`
      SELECT c.*, COUNT(b.id)::int base_count
      FROM knowledge_categories c
      LEFT JOIN knowledge_bases b ON b.category=c.code
      GROUP BY c.id
      ORDER BY c.id`);
    return sendJson(res, 200, result.rows);
  }
  if (url.pathname === '/api/knowledge/categories' && req.method === 'POST') {
    const data = await jsonBody(req);
    const name = String(data.name || '').trim();
    if (!name) return sendJson(res, 400, { error: 'name required' });
    const code = categoryCode(data.code || name);
    const result = await pool.query(
      `INSERT INTO knowledge_categories (code, name) VALUES ($1,$2) RETURNING *`,
      [code, name]
    );
    return sendJson(res, 201, result.rows[0]);
  }
  const categoryMatch = url.pathname.match(/^\/api\/knowledge\/categories\/(\d+)$/);
  if (categoryMatch && req.method === 'PUT') {
    const data = await jsonBody(req);
    const name = String(data.name || '').trim();
    if (!name) return sendJson(res, 400, { error: 'name required' });
    const result = await pool.query(
      `UPDATE knowledge_categories SET name=$1, updated_at=now() WHERE id=$2 RETURNING *`,
      [name, Number(categoryMatch[1])]
    );
    return sendJson(res, result.rowCount ? 200 : 404, result.rowCount ? result.rows[0] : { error: 'not found' });
  }
  if (categoryMatch && req.method === 'DELETE') {
    const category = await pool.query('SELECT * FROM knowledge_categories WHERE id=$1', [Number(categoryMatch[1])]);
    if (!category.rowCount) return sendJson(res, 404, { error: 'not found' });
    if (category.rows[0].code === 'general') return sendJson(res, 400, { error: '通用分类不能删除' });
    await pool.query('UPDATE knowledge_bases SET category=$1, updated_at=now() WHERE category=$2', ['general', category.rows[0].code]);
    const result = await pool.query('DELETE FROM knowledge_categories WHERE id=$1', [Number(categoryMatch[1])]);
    return sendJson(res, 200, { deleted: result.rowCount > 0 });
  }
  if (url.pathname === '/api/knowledge/bases' && req.method === 'POST') {
    const data = await jsonBody(req);
    const result = await pool.query(
      `INSERT INTO knowledge_bases (name, description, category, status) VALUES ($1,$2,$3,'active') RETURNING *`,
      [data.name, data.description || '', data.category || 'general']
    );
    return sendJson(res, 201, result.rows[0]);
  }
  const kbMatch = url.pathname.match(/^\/api\/knowledge\/bases\/(\d+)$/);
  if (kbMatch && req.method === 'DELETE') {
    const deleted = await deleteKnowledgeBase(Number(kbMatch[1]));
    return sendJson(res, 200, { deleted });
  }
  if (url.pathname === '/api/wechat/inbox/retry-failed' && req.method === 'POST') {
    const data = await jsonBody(req);
    const result = await retryFailedWechatMessages({ limit: data.limit || 10, notify: Boolean(data.notify) });
    await auditLog(req, { action: 'wechat_message.retry_failed', entityType: 'wechat_message', detail: result });
    return sendJson(res, 200, result);
  }
  const kbDocsMatch = url.pathname.match(/^\/api\/knowledge\/bases\/(\d+)\/documents$/);
  if (kbDocsMatch && req.method === 'GET') {
    const result = await pool.query(`
      SELECT d.*, COUNT(c.id)::int chunk_count
      FROM knowledge_documents d LEFT JOIN knowledge_chunks c ON c.doc_id=d.id
      WHERE d.kb_id=$1
      GROUP BY d.id
      ORDER BY d.created_at DESC`, [Number(kbDocsMatch[1])]);
    return sendJson(res, 200, result.rows);
  }
  const textDocMatch = url.pathname.match(/^\/api\/knowledge\/bases\/(\d+)\/documents\/text$/);
  if (textDocMatch && req.method === 'POST') {
    const data = await jsonBody(req);
    const doc = await pool.query(
      `INSERT INTO knowledge_documents (kb_id,title,source_type,raw_text,status) VALUES ($1,$2,'text',$3,'processing') RETURNING *`,
      [Number(textDocMatch[1]), data.title || '未命名文本', data.text || '']
    );
    const processed = await processKnowledgeDocument(doc.rows[0].id);
    return sendJson(res, 201, { document: doc.rows[0], processed });
  }
  const uploadDocMatch = url.pathname.match(/^\/api\/knowledge\/bases\/(\d+)\/documents\/upload$/);
  if (uploadDocMatch && req.method === 'POST') {
    const { fields, files } = await parseMultipart(req);
    const file = files[0];
    if (!file) return sendJson(res, 400, { error: 'file required' });
    const safeName = `${Date.now()}_${file.filename || 'upload'}`.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(UPLOAD_DIR, safeName);
    await writeFile(filePath, file.buffer);
    const rawText = await parseDocumentBuffer(file.buffer, file.filename, 'upload');
    const doc = await pool.query(
      `INSERT INTO knowledge_documents (kb_id,title,source_type,filename,file_path,raw_text,status) VALUES ($1,$2,'upload',$3,$4,$5,'processing') RETURNING *`,
      [Number(uploadDocMatch[1]), fields.title || file.filename || '上传文档', file.filename || safeName, filePath, rawText]
    );
    const processed = await processKnowledgeDocument(doc.rows[0].id);
    return sendJson(res, 201, { document: doc.rows[0], processed });
  }
  const docMatch = url.pathname.match(/^\/api\/knowledge\/documents\/(\d+)$/);
  if (docMatch && req.method === 'GET') {
    const docId = Number(docMatch[1]);
    const [doc, chunks, queries, duplicates] = await Promise.all([
      pool.query(`
        SELECT d.*, kb.name kb_name, kb.category kb_category, COUNT(c.id)::int chunk_count
        FROM knowledge_documents d
        JOIN knowledge_bases kb ON kb.id=d.kb_id
        LEFT JOIN knowledge_chunks c ON c.doc_id=d.id
        WHERE d.id=$1
        GROUP BY d.id, kb.id`, [docId]),
      pool.query('SELECT id, chunk_index, content, char_count, embedding_id, created_at FROM knowledge_chunks WHERE doc_id=$1 ORDER BY chunk_index ASC', [docId]),
      pool.query(`
        SELECT id, question, answer, sources, created_at
        FROM knowledge_queries
        WHERE sources::text LIKE $1
        ORDER BY created_at DESC
        LIMIT 30`, [`%"doc_id":${docId}%`]),
      pool.query(`
        SELECT id, title, filename, status, created_at
        FROM knowledge_documents
        WHERE id<>$1 AND (title=(SELECT title FROM knowledge_documents WHERE id=$1) OR filename=(SELECT filename FROM knowledge_documents WHERE id=$1))
        ORDER BY created_at DESC`, [docId]),
    ]);
    if (!doc.rowCount) return sendJson(res, 404, { error: 'not found' });
    return sendJson(res, 200, { document: doc.rows[0], chunks: chunks.rows, queries: queries.rows, duplicates: duplicates.rows });
  }
  const docReindexMatch = url.pathname.match(/^\/api\/knowledge\/documents\/(\d+)\/reindex$/);
  if (docReindexMatch && req.method === 'POST') {
    const processed = await processKnowledgeDocument(Number(docReindexMatch[1]));
    return sendJson(res, 200, processed);
  }
  const docDuplicatesMatch = url.pathname.match(/^\/api\/knowledge\/documents\/(\d+)\/duplicates$/);
  if (docDuplicatesMatch && req.method === 'DELETE') {
    const docId = Number(docDuplicatesMatch[1]);
    const docs = await pool.query(`
      SELECT d2.id
      FROM knowledge_documents d1
      JOIN knowledge_documents d2 ON d2.id<>d1.id AND (d2.title=d1.title OR d2.filename=d1.filename)
      WHERE d1.id=$1
      ORDER BY d2.created_at DESC`, [docId]);
    for (const row of docs.rows) await deleteKnowledgeDocument(row.id);
    return sendJson(res, 200, { deleted: docs.rows.length });
  }
  if (docMatch && req.method === 'DELETE') {
    const deleted = await deleteKnowledgeDocument(Number(docMatch[1]));
    return sendJson(res, 200, { deleted });
  }
  if (url.pathname === '/api/knowledge/search' && req.method === 'POST') {
    const data = await jsonBody(req);
    const rows = await searchKnowledge(data.kb_id, data.query || '', Number(data.top_k || 6));
    return sendJson(res, 200, rows);
  }
  if (url.pathname === '/api/global-search' && req.method === 'POST') {
    const data = await jsonBody(req);
    const bundle = await globalSearch(data.query || '', { fromUser: data.from_user || null, kbId: data.kb_id || null, limit: Number(data.limit || 8) });
    return sendJson(res, 200, bundle);
  }
  if (url.pathname === '/api/global-answer' && req.method === 'POST') {
    const data = await jsonBody(req);
    const bundle = await globalSearch(data.question || data.query || '', { fromUser: data.from_user || null, kbId: data.kb_id || null, limit: Number(data.limit || 10) });
    const profile = await buildPersonalProfile(data.from_user || null);
    const answer = await deepseekGlobalAnswer(data.question || data.query || '', bundle, profile);
    return sendJson(res, 200, { answer, global_results: bundle.items.slice(0, 20), profile_summary: profile.summary });
  }
  if (url.pathname === '/api/profile' && req.method === 'GET') {
    return sendJson(res, 200, await buildPersonalProfile(url.searchParams.get('from_user') || null));
  }
  if (url.pathname === '/api/backup/export' && req.method === 'GET') {
    return sendJson(res, 200, await exportBackup());
  }
  if (url.pathname === '/api/backup/files' && req.method === 'GET') {
    return sendJson(res, 200, await listLocalBackups());
  }
  if (url.pathname === '/api/backup/create' && req.method === 'POST') {
    const data = await jsonBody(req);
    const result = await createLocalBackup({ reason: data.reason || 'manual', notify: Boolean(data.notify) });
    await auditLog(req, { action: 'backup.create', entityType: 'backup', entityId: result.file, detail: { size: result.size, reason: data.reason || 'manual' } });
    await systemEvent('backup.manual_success', { entityType: 'backup', entityId: result.file, level: 'info', detail: { size: result.size, reason: data.reason || 'manual' } });
    return sendJson(res, 201, result);
  }
  if (url.pathname === '/api/backup/preview-import' && req.method === 'POST') {
    const data = await jsonBody(req);
    return sendJson(res, 200, await previewBackupImport(data));
  }
  if (url.pathname === '/api/backup/import' && req.method === 'POST') {
    const data = await jsonBody(req);
    const result = await importBackup(data.backup || data, { mode: data.mode === 'replace' ? 'replace' : 'skip' });
    await auditLog(req, { action: 'backup.import', entityType: 'backup', detail: { mode: result.mode, summary: result.summary } });
    await systemEvent('backup.import_success', { entityType: 'backup', level: 'warn', detail: { mode: result.mode, summary: result.summary } });
    return sendJson(res, 200, result);
  }
  if (url.pathname === '/api/knowledge/reindex' && req.method === 'POST') {
    const docs = await pool.query(`
      SELECT id, title FROM knowledge_documents
      WHERE COALESCE(length(raw_text), 0) > 0
      ORDER BY id ASC`);
    const results = [];
    for (const doc of docs.rows) {
      try {
        const processed = await processKnowledgeDocument(doc.id);
        results.push({ id: doc.id, title: doc.title, ok: true, chunks: processed.chunks, chroma: processed.chroma });
      } catch (error) {
        results.push({ id: doc.id, title: doc.title, ok: false, error: error.message });
      }
    }
    resetKnowledgeChunkCountCache();
    return sendJson(res, 200, {
      collection: KNOWLEDGE_COLLECTION,
      embedding: getEmbeddingStatus(),
      processed: results.length,
      ok: results.filter((item) => item.ok).length,
      results,
    });
  }
  if (url.pathname === '/api/knowledge/ask' && req.method === 'POST') {
    const data = await jsonBody(req);
    const question = data.question || '';
    const [sources, globalBundle] = await Promise.all([
      searchKnowledge(data.kb_id, question, Number(data.top_k || 6)),
      globalSearch(question, { kbId: data.kb_id || null, limit: 6 }),
    ]);
    const globalContext = formatGlobalSearchContext(globalBundle);
    const topic = classifyUsefulTopic(question, sources);
    if (topic) {
      const cached = await getAssistantCache({
        question,
        channel: 'web',
        kbId: data.kb_id || null,
        fromUser: null,
      });
      if (cached) {
        await touchAssistantCache(cached.id);
        const saved = await pool.query(
          'INSERT INTO knowledge_queries (kb_id,question,answer,sources) VALUES ($1,$2,$3,$4) RETURNING *',
          [data.kb_id || null, question, cached.answer, JSON.stringify(cached.sources || [])]
        );
        return sendJson(res, 200, {
          answer: cached.answer,
          sources: cached.sources || [],
          from_cache: true,
          cache_id: cached.id,
          query: saved.rows[0],
        });
      }
    }
    const answer = (sources.length || globalBundle.items.length)
      ? await deepseekKnowledgeAnswer(question, sources, globalContext)
      : '没有检索到相关内容。';
    if (topic && sources.length) {
      await saveAssistantCache({
        question,
        answer,
        channel: 'web',
        kbId: data.kb_id || null,
        fromUser: null,
        topic,
        sources: sources.map((item) => ({
          document_title: item.document_title,
          filename: item.filename,
          chunk_index: item.chunk_index,
          content: String(item.content || '').slice(0, 240),
        })),
      });
    }
    const saved = await pool.query('INSERT INTO knowledge_queries (kb_id,question,answer,sources) VALUES ($1,$2,$3,$4) RETURNING *', [data.kb_id || null, question, answer, JSON.stringify(sources.slice(0, 6))]);
    return sendJson(res, 200, { answer, sources, global_results: globalBundle.items.slice(0, 12), from_cache: false, query: saved.rows[0] });
  }
  const historyMatch = url.pathname.match(/^\/api\/knowledge\/bases\/(\d+)\/queries$/);
  if (historyMatch && req.method === 'GET') {
    const result = await pool.query('SELECT * FROM knowledge_queries WHERE kb_id=$1 ORDER BY created_at DESC LIMIT 30', [Number(historyMatch[1])]);
    return sendJson(res, 200, result.rows);
  }
  if (url.pathname === '/api/assistant/cache/summary' && req.method === 'GET') {
    return sendJson(res, 200, await assistantCacheSummary());
  }
  if (url.pathname === '/api/assistant/memory' && req.method === 'GET') {
    return sendJson(res, 200, await assistantMemoryBundle());
  }
  if (url.pathname === '/api/dashboard/memory' && req.method === 'GET') {
    return sendJson(res, 200, await dashboardMemoryBundle());
  }
  if (url.pathname === '/api/assistant/cache' && req.method === 'GET') {
    const channel = url.searchParams.get('channel');
    const topic = url.searchParams.get('topic');
    const q = url.searchParams.get('q');
    const limit = Math.min(Number(url.searchParams.get('limit') || 100), 200);
    const result = await pool.query(`
      SELECT c.*, b.name kb_name
      FROM assistant_answer_cache c
      LEFT JOIN knowledge_bases b ON b.id=c.kb_id
      WHERE c.topic IN ('fitness', 'finance', 'knowledge')
        AND ($1::text IS NULL OR c.channel=$1)
        AND ($2::text IS NULL OR c.topic=$2)
        AND ($3::text IS NULL OR c.question ILIKE '%' || $3 || '%' OR c.answer ILIKE '%' || $3 || '%')
      ORDER BY c.pinned DESC, c.hit_count DESC, c.updated_at DESC
      LIMIT $4`, [channel || null, topic || null, q || null, limit]);
    return sendJson(res, 200, result.rows);
  }
  if (url.pathname === '/api/assistant/memories' && req.method === 'GET') {
    const category = url.searchParams.get('category');
    const q = url.searchParams.get('q');
    const result = await pool.query(`
      SELECT * FROM assistant_memories
      WHERE ($1::text IS NULL OR category=$1)
        AND ($2::text IS NULL OR content ILIKE '%' || $2 || '%')
        AND category <> 'knowledge_upload_target'
      ORDER BY pinned DESC, importance DESC, updated_at DESC
      LIMIT 200`, [category || null, q || null]);
    return sendJson(res, 200, result.rows);
  }
  if (url.pathname === '/api/assistant/memories' && req.method === 'POST') {
    const data = await jsonBody(req);
    const memory = await saveAssistantMemory({ fromUser: data.from_user || null, category: data.category, content: data.content, importance: data.importance, source: 'manual' });
    return sendJson(res, 201, memory);
  }
  if (url.pathname === '/api/assistant/tasks' && req.method === 'GET') {
    const status = url.searchParams.get('status');
    const result = await pool.query(`
      SELECT * FROM assistant_tasks
      WHERE ($1::text IS NULL OR status=$1)
      ORDER BY status, remind_at NULLS LAST, created_at DESC
      LIMIT 200`, [status || null]);
    return sendJson(res, 200, result.rows);
  }
  if (url.pathname === '/api/assistant/tasks' && req.method === 'POST') {
    const data = await jsonBody(req);
    return sendJson(res, 201, await createAssistantTask(data, data.from_user || null));
  }
  if (url.pathname === '/api/assistant/tasks/run-due' && req.method === 'POST') {
    return sendJson(res, 200, await processDueAssistantTasks());
  }
  const taskMatch = url.pathname.match(/^\/api\/assistant\/tasks\/(\d+)$/);
  if (taskMatch && req.method === 'PATCH') {
    const data = await jsonBody(req);
    const remindAt = data.remind_at === undefined ? null : shanghaiTimestampOrNull(data.remind_at);
    const result = await pool.query(`
      UPDATE assistant_tasks
      SET title=COALESCE($1,title), note=COALESCE($2,note), remind_at=COALESCE(CASE WHEN $3::text IS NULL THEN NULL ELSE $3::timestamp AT TIME ZONE 'Asia/Shanghai' END, remind_at),
          recurrence=COALESCE($4,recurrence), status=COALESCE($5,status), completed_at=CASE WHEN $5='done' THEN now() WHEN $5='pending' THEN NULL ELSE completed_at END, updated_at=now()
      WHERE id=$6 RETURNING *`, [data.title || null, data.note === undefined ? null : String(data.note || ''), remindAt, data.recurrence || null, data.status || null, Number(taskMatch[1])]);
    return sendJson(res, result.rowCount ? 200 : 404, result.rowCount ? result.rows[0] : { error: 'not found' });
  }
  if (taskMatch && req.method === 'DELETE') {
    const result = await pool.query('DELETE FROM assistant_tasks WHERE id=$1', [Number(taskMatch[1])]);
    return sendJson(res, 200, { deleted: result.rowCount > 0 });
  }
  if (url.pathname === '/api/assistant/reports' && req.method === 'GET') {
    const result = await pool.query('SELECT * FROM assistant_reports ORDER BY created_at DESC LIMIT 100');
    return sendJson(res, 200, result.rows);
  }
  if (url.pathname === '/api/assistant/reports' && req.method === 'POST') {
    const data = await jsonBody(req);
    return sendJson(res, 201, await createAssistantReport(data, data.from_user || null));
  }
  if (url.pathname === '/api/assistant/report-subscriptions' && req.method === 'GET') {
    const result = await pool.query('SELECT * FROM assistant_report_subscriptions ORDER BY enabled DESC, report_type ASC, from_user ASC');
    return sendJson(res, 200, result.rows);
  }
  if (url.pathname === '/api/assistant/report-subscriptions' && req.method === 'POST') {
    const data = await jsonBody(req);
    const fromUser = String(data.from_user || '').trim();
    const reportType = ['daily', 'weekly'].includes(data.report_type) ? data.report_type : 'daily';
    const sendTime = String(data.send_time || '21:30').slice(0, 5);
    if (!fromUser) return sendJson(res, 400, { error: 'from_user required' });
    if (!/^\d{2}:\d{2}$/.test(sendTime)) return sendJson(res, 400, { error: 'send_time must be HH:mm' });
    const weekday = reportType === 'weekly' ? Number(data.weekday ?? 1) : null;
    const result = await pool.query(
      `INSERT INTO assistant_report_subscriptions (from_user, report_type, send_time, weekday, enabled)
       VALUES ($1,$2,$3,$4,COALESCE($5,true))
       ON CONFLICT (from_user, report_type)
       DO UPDATE SET send_time=EXCLUDED.send_time, weekday=EXCLUDED.weekday, enabled=EXCLUDED.enabled, updated_at=now()
       RETURNING *`,
      [fromUser, reportType, sendTime, weekday, data.enabled === undefined ? true : Boolean(data.enabled)]
    );
    await auditLog(req, { action: 'report_subscription.upsert', entityType: 'assistant_report_subscription', entityId: result.rows[0].id, detail: { from_user: fromUser, report_type: reportType, send_time: sendTime, weekday } });
    return sendJson(res, 201, result.rows[0]);
  }
  if (url.pathname === '/api/assistant/report-subscriptions/run-due' && req.method === 'POST') {
    return sendJson(res, 200, await processDueReportSubscriptions());
  }
  const reportSubMatch = url.pathname.match(/^\/api\/assistant\/report-subscriptions\/(\d+)$/);
  if (reportSubMatch && req.method === 'PATCH') {
    const data = await jsonBody(req);
    const sendTime = data.send_time === undefined ? null : String(data.send_time).slice(0, 5);
    if (sendTime !== null && !/^\d{2}:\d{2}$/.test(sendTime)) return sendJson(res, 400, { error: 'send_time must be HH:mm' });
    const result = await pool.query(
      `UPDATE assistant_report_subscriptions
       SET send_time=COALESCE($1,send_time), weekday=COALESCE($2,weekday), enabled=COALESCE($3,enabled), updated_at=now()
       WHERE id=$4 RETURNING *`,
      [sendTime, data.weekday === undefined ? null : Number(data.weekday), data.enabled === undefined ? null : Boolean(data.enabled), Number(reportSubMatch[1])]
    );
    if (result.rowCount) await auditLog(req, { action: 'report_subscription.update', entityType: 'assistant_report_subscription', entityId: reportSubMatch[1], detail: data });
    return sendJson(res, result.rowCount ? 200 : 404, result.rowCount ? result.rows[0] : { error: 'not found' });
  }
  if (reportSubMatch && req.method === 'DELETE') {
    const result = await pool.query('DELETE FROM assistant_report_subscriptions WHERE id=$1', [Number(reportSubMatch[1])]);
    await auditLog(req, { action: 'report_subscription.delete', entityType: 'assistant_report_subscription', entityId: reportSubMatch[1], detail: { deleted: result.rowCount > 0 } });
    return sendJson(res, 200, { deleted: result.rowCount > 0 });
  }
  if (url.pathname === '/api/assistant/goals' && req.method === 'GET') {
    const result = await pool.query('SELECT * FROM assistant_goals ORDER BY enabled DESC, goal_type ASC, updated_at DESC LIMIT 200');
    return sendJson(res, 200, result.rows);
  }
  if (url.pathname === '/api/assistant/goals' && req.method === 'POST') {
    const data = await jsonBody(req);
    const goalType = ['weight', 'monthly_expense', 'weekly_workout', 'sleep'].includes(data.goal_type) ? data.goal_type : 'weight';
    const targetValue = numberOrNull(data.target_value);
    if (!targetValue || targetValue <= 0) return sendJson(res, 400, { error: 'target_value required' });
    const defaultTitle = { weight: '体重目标', monthly_expense: '月支出目标', weekly_workout: '周运动目标', sleep: '睡眠目标' }[goalType];
    const defaultUnit = { weight: 'kg', monthly_expense: 'CNY', weekly_workout: '次', sleep: '小时' }[goalType];
    const result = await pool.query(
      `INSERT INTO assistant_goals (from_user, goal_type, title, target_value, unit, period, enabled, note)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,true),$8) RETURNING *`,
      [data.from_user || null, goalType, data.title || defaultTitle, targetValue, data.unit || defaultUnit, data.period || 'ongoing', data.enabled === undefined ? true : Boolean(data.enabled), data.note || '']
    );
    await auditLog(req, { action: 'goal.create', entityType: 'assistant_goal', entityId: result.rows[0].id, detail: { goal_type: goalType, title: result.rows[0].title, target_value: targetValue } });
    return sendJson(res, 201, result.rows[0]);
  }
  const goalMatch = url.pathname.match(/^\/api\/assistant\/goals\/(\d+)$/);
  if (goalMatch && req.method === 'PATCH') {
    const data = await jsonBody(req);
    const result = await pool.query(
      `UPDATE assistant_goals
       SET title=COALESCE($1,title), target_value=COALESCE($2,target_value), unit=COALESCE($3,unit), period=COALESCE($4,period), enabled=COALESCE($5,enabled), note=COALESCE($6,note), updated_at=now()
       WHERE id=$7 RETURNING *`,
      [data.title || null, data.target_value === undefined ? null : numberOrNull(data.target_value), data.unit || null, data.period || null, data.enabled === undefined ? null : Boolean(data.enabled), data.note === undefined ? null : String(data.note || ''), Number(goalMatch[1])]
    );
    if (result.rowCount) await auditLog(req, { action: 'goal.update', entityType: 'assistant_goal', entityId: goalMatch[1], detail: data });
    return sendJson(res, result.rowCount ? 200 : 404, result.rowCount ? result.rows[0] : { error: 'not found' });
  }
  if (goalMatch && req.method === 'DELETE') {
    const result = await pool.query('DELETE FROM assistant_goals WHERE id=$1', [Number(goalMatch[1])]);
    await auditLog(req, { action: 'goal.delete', entityType: 'assistant_goal', entityId: goalMatch[1], detail: { deleted: result.rowCount > 0 } });
    return sendJson(res, 200, { deleted: result.rowCount > 0 });
  }
  const memoryMatch = url.pathname.match(/^\/api\/assistant\/memories\/(\d+)$/);
  if (memoryMatch && req.method === 'PATCH') {
    const data = await jsonBody(req);
    const result = await pool.query(`
      UPDATE assistant_memories
      SET pinned=COALESCE($1, pinned), importance=COALESCE($2, importance), category=COALESCE($3, category), content=COALESCE($4, content), updated_at=now()
      WHERE id=$5 RETURNING *`, [data.pinned === undefined ? null : Boolean(data.pinned), data.importance === undefined ? null : Number(data.importance), data.category || null, data.content === undefined ? null : String(data.content || '').trim(), Number(memoryMatch[1])]);
    if (result.rowCount) await auditLog(req, { action: 'memory.update', entityType: 'assistant_memory', entityId: memoryMatch[1], detail: data });
    return sendJson(res, result.rowCount ? 200 : 404, result.rowCount ? result.rows[0] : { error: 'not found' });
  }
  if (memoryMatch && req.method === 'DELETE') {
    const result = await pool.query('DELETE FROM assistant_memories WHERE id=$1', [Number(memoryMatch[1])]);
    await auditLog(req, { action: 'memory.delete', entityType: 'assistant_memory', entityId: memoryMatch[1], detail: { deleted: result.rowCount > 0 } });
    return sendJson(res, 200, { deleted: result.rowCount > 0 });
  }
  if (url.pathname === '/api/assistant/cache/clear' && req.method === 'POST') {
    const data = await jsonBody(req);
    if (data.expired_only) {
      const result = await pool.query(`
        DELETE FROM assistant_answer_cache
        WHERE pinned=false AND expires_at IS NOT NULL AND expires_at <= now()`);
      return sendJson(res, 200, { deleted: result.rowCount });
    }
    const result = await pool.query(`
      DELETE FROM assistant_answer_cache
      WHERE pinned=false AND topic IN ('fitness', 'finance', 'knowledge')`);
    return sendJson(res, 200, { deleted: result.rowCount });
  }
  const cacheMatch = url.pathname.match(/^\/api\/assistant\/cache\/(\d+)$/);
  if (cacheMatch && req.method === 'PATCH') {
    const data = await jsonBody(req);
    const pinned = Boolean(data.pinned);
    const current = await pool.query('SELECT channel FROM assistant_answer_cache WHERE id=$1', [Number(cacheMatch[1])]);
    if (!current.rowCount) return sendJson(res, 404, { error: 'not found' });
    const ttl = pinned
      ? ASSISTANT_CACHE_TTL_PINNED
      : (current.rows[0].channel === 'wechat' ? ASSISTANT_CACHE_TTL_WECHAT : ASSISTANT_CACHE_TTL_WEB);
    const expiresAt = ttl > 0 ? new Date(Date.now() + ttl * 1000) : null;
    const result = await pool.query(`
      UPDATE assistant_answer_cache
      SET pinned=$1, expires_at=$2, updated_at=now()
      WHERE id=$3
      RETURNING *`, [pinned, expiresAt, Number(cacheMatch[1])]);
    return sendJson(res, 200, result.rows[0]);
  }
  if (cacheMatch && req.method === 'DELETE') {
    const result = await pool.query('DELETE FROM assistant_answer_cache WHERE id=$1', [Number(cacheMatch[1])]);
    return sendJson(res, 200, { deleted: result.rowCount > 0 });
  }
  return sendJson(res, 404, { error: 'not found' });
}

async function serveStatic(req, res, url) {
  const safePath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const filePath = path.resolve(__dirname, `.${safePath}`);
  if (!filePath.startsWith(__dirname) || !existsSync(filePath)) {
    res.writeHead(404);
    return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] || 'application/octet-stream' });
  createReadStream(filePath).pipe(res);
}

await initDb();
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      if (!gatewayAuthorized(req)) return sendUnauthorized(res);
      return await handleGatewayChatCompletions(req, res);
    }
    const publicPage = ['/wechat-upload.html', '/wechat-upload.js', '/theme.css', '/knowledge.css'].includes(url.pathname);
    const publicApi = ['/api/health', '/api/wechat/webhook', '/api/wechat/work-webhook', '/api/wechat/upload-token'].includes(url.pathname);
    if (publicPage) return await serveStatic(req, res, url);
    if (!publicApi && !authorized(req)) return sendUnauthorized(res);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: error.message });
  }
}).listen(PORT, () => {
  console.log(`AI Key Hub running at http://127.0.0.1:${PORT}`);
  console.log(`[knowledge] collection=${KNOWLEDGE_COLLECTION} embedding=${USE_HASH_EMBEDDING ? 'hash' : EMBEDDING_MODEL}`);
  warmupEmbeddings().catch((error) => console.error('[embeddings] warmup failed:', error.message));
  setTimeout(() => {
    processDueAssistantTasks().catch((error) => console.error('[tasks] startup', error.message));
    processDueReportSubscriptions().catch((error) => console.error('[reports] startup', error.message));
    runFailedWechatRetry('startup').catch((error) => console.error('[wechat] retry startup', error.message));
    runAutoBackup('startup').catch((error) => console.error('[backup] startup', error.message));
  }, 5000);
  setInterval(() => {
    processDueAssistantTasks().catch((error) => console.error('[tasks] poll', error.message));
    processDueReportSubscriptions().catch((error) => console.error('[reports] poll', error.message));
  }, ASSISTANT_TASK_POLL_MS);
  if (WECHAT_FAILED_RETRY_ENABLED) {
    setInterval(() => {
      runFailedWechatRetry('auto').catch((error) => console.error('[wechat] retry poll', error.message));
    }, WECHAT_FAILED_RETRY_MS);
  }
  if (AUTO_BACKUP_ENABLED) {
    setInterval(() => {
      runAutoBackup('auto').catch((error) => console.error('[backup] poll', error.message));
    }, AUTO_BACKUP_INTERVAL_MS);
  }
});
