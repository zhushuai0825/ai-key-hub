import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, writeFile, readFile as readLocalFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import Busboy from 'busboy';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import { parse as csvParseSync } from 'csv-parse/sync';
import { ChromaClient } from 'chromadb';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8899);
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://ai_admin:ai_admin_123@127.0.0.1:5432/ai_key_hub';
const AUTH_USER = process.env.APP_AUTH_USER || '';
const AUTH_PASSWORD = process.env.APP_AUTH_PASSWORD || '';
const PROFILE_HEIGHT_CM = 177;
const CHROMA_URL = process.env.CHROMA_URL || 'http://127.0.0.1:8000';
const KNOWLEDGE_COLLECTION = process.env.KNOWLEDGE_COLLECTION || 'ai_key_hub_knowledge';
const UPLOAD_DIR = path.join(__dirname, 'uploads', 'knowledge');
const WECHAT_WORK_TOKEN = process.env.WECHAT_WORK_TOKEN || '';
const WECHAT_WORK_ENCODING_AES_KEY = process.env.WECHAT_WORK_ENCODING_AES_KEY || '';
const WECHAT_WORK_CORP_ID = process.env.WECHAT_WORK_CORP_ID || '';
const WECHAT_WORK_SECRET = process.env.WECHAT_WORK_SECRET || '';
const WECHAT_WORK_AGENT_ID = process.env.WECHAT_WORK_AGENT_ID ? Number(process.env.WECHAT_WORK_AGENT_ID) : null;
const ASSISTANT_TASK_POLL_MS = Number(process.env.ASSISTANT_TASK_POLL_MS || 60000);
const ASSISTANT_CACHE_TTL_WECHAT = Number(process.env.ASSISTANT_CACHE_TTL_WECHAT || 1800);
const ASSISTANT_CACHE_TTL_WEB = Number(process.env.ASSISTANT_CACHE_TTL_WEB || 86400);
const ASSISTANT_CACHE_TTL_PINNED = Number(process.env.ASSISTANT_CACHE_TTL_PINNED || 60 * 60 * 24 * 30);
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

async function initDb() {
  const sql = await readFile(path.join(__dirname, 'db/schema.sql'), 'utf8');
  await pool.query(sql);
  await pool.query('ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS daily_quota NUMERIC(12, 2) DEFAULT 0');
  await pool.query("ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS budget_action TEXT NOT NULL DEFAULT 'alert'");
  await pool.query('ALTER TABLE fitness_entries DROP CONSTRAINT IF EXISTS fitness_entries_entry_type_check');
  await pool.query("ALTER TABLE fitness_entries ADD CONSTRAINT fitness_entries_entry_type_check CHECK (entry_type IN ('weight', 'meal', 'workout', 'sleep'))");
  await pool.query('ALTER TABLE fitness_entries ADD COLUMN IF NOT EXISTS sleep_hours NUMERIC(5, 2)');
  await pool.query('ALTER TABLE fitness_entries ADD COLUMN IF NOT EXISTS sleep_quality TEXT');
  await pool.query('ALTER TABLE wechat_messages ADD COLUMN IF NOT EXISTS fitness_entry_id INTEGER REFERENCES fitness_entries(id) ON DELETE SET NULL');
  await pool.query("ALTER TABLE wechat_messages ADD COLUMN IF NOT EXISTS intent TEXT NOT NULL DEFAULT 'unknown'");
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
  await pool.query('CREATE INDEX IF NOT EXISTS idx_fitness_entries_user_time ON fitness_entries(source_user, recorded_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_assistant_tasks_user_status ON assistant_tasks(from_user, status, remind_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_assistant_reports_user_type ON assistant_reports(from_user, report_type, created_at DESC)');
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
    SELECT k.api_key
    FROM api_keys k JOIN providers p ON p.id=k.provider_id
    WHERE p.code='deepseek' AND k.status='active'
    ORDER BY k.updated_at DESC, k.id DESC
    LIMIT 1`);
  return result.rows[0]?.api_key || '';
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
3. 用户表达偏好、身份信息、长期目标、重要事实、承诺、计划、习惯、项目背景、AI 说过值得以后复用的话时，写入 memory。
4. 用户只是提问、闲聊、要求总结时，直接回答；必要时结合个人记录、长期记忆和知识库。
5. 你可以同时执行多个动作，例如“我今天72kg，记住我想减到68kg”要同时记录 fitness 和 memory。
6. 用户要求“提醒我/明天/每周/每月/到点叫我”时，创建 task。
7. 用户说“刚才那条错了/删除上一条/不是18是28/分类改成项目成本”时，根据最近对话输出 correction 或 delete。
8. 用户要日报/周报/月报/总结时，输出 report。

必须只返回 JSON，不要返回 Markdown。格式：
{
  "reply": "给用户的简短回复，适合微信阅读，300字以内",
  "actions": [
    {"type":"fitness","entry_type":"weight|meal|workout|sleep","weight_kg":72.5,"food_text":"...","meal_type":"早餐|午餐|晚餐|加餐","workout_type":"跑步|力量|骑行|HIIT|其他","workout_text":"...","duration_min":30,"intensity":"低|中|高","sleep_hours":7,"sleep_quality":"良好|一般|较差","note":"原话或摘要"},
    {"type":"finance","direction":"expense|income","amount":18,"category":"餐饮|交通|项目/工具|健身|收入|未分类","title":"咖啡","note":"原话或摘要"},
    {"type":"memory","category":"preference|profile|goal|project|health|finance|knowledge|general","content":"值得长期记住的一句话","importance":1-5},
    {"type":"task","title":"提醒事项","note":"补充说明","remind_at":"2026-07-07 09:00","recurrence":"none|daily|weekly|monthly"},
    {"type":"correction","target":"last|fitness|finance|memory|task","field":"amount|category|title|note|weight_kg|content|status","value":"新值"},
    {"type":"delete","target":"last|fitness|finance|memory|task"},
    {"type":"report","report_type":"daily|weekly|monthly","title":"报告标题"},
    {"type":"answer","topic":"general|fitness|finance|knowledge|memory"}
  ]
}
如果没有需要记录的内容，actions 可以只包含 answer。纠错/删除必须优先参考最近对话。不要编造金额、体重、时间等数字；资料不足就说明。所有 remind_at 使用东八区时间，格式 YYYY-MM-DD HH:mm。`,
        },
        {
          role: 'user',
          content: `用户消息：${message}

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

async function deepseekWechatAssistant(question, userContext, knowledgeSources) {
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
          content: `用户问题：${question}\n\n【用户个人记录】\n${userContext || '暂无'}\n\n【知识库资料】\n${kbContext}`,
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
  const previewTopic = classifyUsefulTopic(content, []);
  if (previewTopic) {
    const cached = await getAssistantCache({
      question: content,
      channel: 'wechat',
      kbId: WECHAT_DEFAULT_KB_ID,
      fromUser,
    });
    if (cached) {
      touchAssistantCache(cached.id).catch(() => {});
      return { answer: cached.answer, from_cache: true, cache_id: cached.id };
    }
  }
  const lightContext = !previewTopic && !looksLikeQuery(content);
  const searchKb = await shouldSearchKnowledge(content, previewTopic);
  const [userContext, knowledgeSources] = await Promise.all([
    buildWechatUserContext(fromUser, { light: lightContext }),
    searchKb ? searchKnowledge(WECHAT_DEFAULT_KB_ID, content, 5) : Promise.resolve([]),
  ]);
  const topic = classifyUsefulTopic(content, knowledgeSources);
  const answer = await deepseekWechatAssistant(content, userContext, knowledgeSources);
  const reply = truncateWechatReply(answer);
  if (topic) {
    await saveAssistantCache({
      question: content,
      answer: reply,
      channel: 'wechat',
      kbId: WECHAT_DEFAULT_KB_ID,
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

async function deepseekKnowledgeAnswer(question, sources) {
  const apiKey = await deepseekApiKey();
  if (!apiKey) throw new Error('DeepSeek Key not configured');
  const context = sources.map((item, index) => `【资料${index + 1}】${item.content}`).join('\n\n');
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: '你是知识库问答助手。只能根据提供资料回答；资料不足时明确说明。回答要简洁，并列出引用资料编号。' },
        { role: 'user', content: `问题：${question}\n\n资料：\n${context}` },
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
    const result = await collection.query({
      queryEmbeddings: [hashEmbedding(query)],
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
  } catch (_) {
    // Fall back to PostgreSQL keyword search below.
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

function hashEmbedding(text, dimensions = 384) {
  const vector = Array(dimensions).fill(0);
  const tokens = String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  tokens.forEach((token) => {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i += 1) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const index = Math.abs(hash) % dimensions;
    vector[index] += 1;
  });
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

const localEmbeddingFunction = {
  name: 'local-hash-embedding',
  async generate(texts) {
    return texts.map((text) => hashEmbedding(text));
  },
  async generateForQueries(texts) {
    return texts.map((text) => hashEmbedding(text));
  },
};

async function chromaCollection() {
  return chroma.getOrCreateCollection({ name: KNOWLEDGE_COLLECTION, embeddingFunction: localEmbeddingFunction });
}

async function upsertChunksToChroma(chunks) {
  if (!chunks.length) return { ok: false, reason: 'empty chunks' };
  try {
    const collection = await chromaCollection();
    await collection.upsert({
      ids: chunks.map((chunk) => chunk.embedding_id),
      embeddings: chunks.map((chunk) => hashEmbedding(chunk.content)),
      documents: chunks.map((chunk) => chunk.content),
      metadatas: chunks.map((chunk) => ({ kb_id: chunk.kb_id, doc_id: chunk.doc_id, chunk_id: chunk.id, chunk_index: chunk.chunk_index })),
    });
    return { ok: true };
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
  if (!response.ok || body.errcode) throw new Error(body.errmsg || `企业微信发消息失败：${response.status}`);
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

async function importWechatWorkMediaToKnowledge(payload) {
  const kb = await ensureWechatDefaultKnowledgeBase();
  const media = await downloadWechatWorkMedia(payload.media_id);
  const filename = payload.file_name || media.filename || `${payload.media_id}.dat`;
  await mkdir(UPLOAD_DIR, { recursive: true });
  const safeName = `${Date.now()}_${filename}`.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, '_');
  const filePath = path.join(UPLOAD_DIR, safeName);
  await writeFile(filePath, media.buffer);
  const rawText = await parseDocumentBuffer(media.buffer, filename, 'upload');
  if (!rawText.trim()) throw new Error('文件没有解析出文本内容');
  const doc = await pool.query(
    `INSERT INTO knowledge_documents (kb_id,title,source_type,filename,file_path,raw_text,status)
     VALUES ($1,$2,'wechat_upload',$3,$4,$5,'processing') RETURNING *`,
    [kb.id, path.basename(filename), filename, filePath, rawText]
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
      file.on('end', () => files.push({ name, filename: info.filename, mimeType: info.mimeType, buffer: Buffer.concat(chunks) }));
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

function parseFinanceMessage(content) {
  const text = String(content || '').trim();
  if (!text) return null;
  const amountMatch = text.match(/(?:¥|￥|rmb|RMB)?\s*(-?\d+(?:\.\d{1,2})?)\s*(?:元|块|rmb|RMB)?/);
  if (!amountMatch) return null;
  const amount = Math.abs(Number(amountMatch[1]));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const isIncome = /收入|收款|到账|工资|奖金|报销|赚|入账|转入/.test(text) && !/买|花|支出|消费|付|付款/.test(text);
  const direction = isIncome ? 'income' : 'expense';
  const title = text
    .replace(/(?:我)?(?:今天|刚刚|刚才|昨天|前天)?/g, '')
    .replace(/(买了|买|花了|花|支出|消费|付款|付了|收入|收款|到账|工资|奖金|报销|元|块|¥|￥|rmb|RMB)/g, ' ')
    .replace(/-?\d+(?:\.\d{1,2})?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || (direction === 'income' ? '收入' : '支出');
  return {
    direction,
    amount,
    category: classifyFinanceCategory(text),
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
  const direction = data.direction === 'income' ? 'income' : 'expense';
  const result = await pool.query(
    `INSERT INTO finance_entries (direction, amount, category, title, note, source_user, raw_message)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [direction, amount, data.category || '未分类', data.title || (direction === 'income' ? '收入' : '支出'), data.note || rawMessage || '', fromUser || null, rawMessage || '']
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

function shanghaiTimestampOrNull(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text.replace('T', ' ');
}

async function createAssistantTask(data, fromUser) {
  const result = await pool.query(
    `INSERT INTO assistant_tasks (from_user, title, note, remind_at, recurrence, status)
     VALUES ($1,$2,$3,CASE WHEN $4::text IS NULL THEN NULL ELSE $4::timestamp AT TIME ZONE 'Asia/Shanghai' END,$5,'pending') RETURNING *`,
    [fromUser || null, data.title || '提醒事项', data.note || '', shanghaiTimestampOrNull(data.remind_at), data.recurrence || 'none']
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
    return { type: 'finance', row: result.rows[0] };
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
  const [fitness, finance] = await Promise.all([
    pool.query(`SELECT * FROM fitness_entries WHERE recorded_at >= now() - ($1 || ' days')::interval AND ($2::text IS NULL OR source_user=$2 OR source_user IS NULL) ORDER BY recorded_at ASC`, [days, fromUser || null]),
    pool.query(`SELECT * FROM finance_entries WHERE occurred_at >= now() - ($1 || ' days')::interval AND ($2::text IS NULL OR source_user=$2 OR source_user IS NULL) ORDER BY occurred_at ASC`, [days, fromUser || null]),
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
  return lines.join('\n');
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

async function executeAssistantActions(actions, content, fromUser) {
  const result = { financeEntry: null, fitnessEntry: null, memories: [], tasks: [], reports: [], corrections: [], deletions: [], intents: [] };
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
    if (action?.type === 'task') {
      const task = await createAssistantTask(action, fromUser);
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
  if (executed.tasks.length) parts.push(`已创建 ${executed.tasks.length} 个提醒`);
  if (executed.corrections.length) parts.push('已按你的话修改');
  if (executed.deletions.length) parts.push('已删除对应记录');
  if (executed.reports.length) parts.push('报告已生成');
  return parts.length ? `\n\n${parts.join('，')}。` : '';
}

async function saveWechatMessage({ from_user, to_user, msg_type = 'text', content = '', raw_payload = {} }) {
  let financeEntry = null;
  let fitnessEntry = null;
  let intent = 'unknown';
  let status = 'ignored';
  let reply = '你好，我是你的助手。可以记录体重/消费/运动/睡眠，也可以问我「这个月花了多少」「最近体重趋势」或知识库问题。';
  if (['file', 'image'].includes(msg_type) && raw_payload.media_id) {
    try {
      const imported = await importWechatWorkMediaToKnowledge(raw_payload);
      intent = 'knowledge.upload';
      status = 'recorded';
      reply = `已上传到知识库「${imported.kb.name}」：${imported.document.title}，切分 ${imported.processed.chunks} 段。之后可以直接问我这份资料里的内容。`;
    } catch (error) {
      intent = 'knowledge.upload_failed';
      status = 'failed';
      reply = `文件入库失败：${error.message}。请确认已配置企业微信 Secret，且文件是 TXT、MD、PDF、DOCX、JSON 或 CSV。`;
    }
  } else if (msg_type === 'text' && content.trim()) {
    try {
      const searchKb = await shouldSearchKnowledge(content, classifyUsefulTopic(content, []));
      const [userContext, memoryContext, knowledgeSources] = await Promise.all([
        buildWechatUserContext(from_user, { light: false }),
        buildAssistantMemoryContext(from_user),
        searchKb ? searchKnowledge(WECHAT_DEFAULT_KB_ID, content, 5) : Promise.resolve([]),
      ]);
      const recentContext = await buildRecentWechatContext(from_user);
      const understood = await deepseekUnderstandWechatMessage(content, userContext, memoryContext, knowledgeSources, recentContext);
      if (understood?.actions?.length) {
        const executed = await executeAssistantActions(understood.actions, content, from_user);
        financeEntry = executed.financeEntry;
        fitnessEntry = executed.fitnessEntry;
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
      const fitnessParsed = parseFitnessMessage(content);
      const financeParsed = !fitnessParsed ? parseFinanceMessage(content) : null;
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
  const message = await pool.query(
    `INSERT INTO wechat_messages (from_user, to_user, msg_type, content, raw_payload, finance_entry_id, fitness_entry_id, intent, parse_status, reply_text)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [from_user || null, to_user || null, msg_type || 'text', content || '', JSON.stringify(raw_payload), financeEntry?.id || null, fitnessEntry?.id || null, intent, status, reply]
  );
  return { message: message.rows[0], finance_entry: financeEntry, fitness_entry: fitnessEntry, reply };
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

function sendUnauthorized(res) {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="AI Key Hub"',
    'Content-Type': 'text/plain; charset=utf-8',
  });
  res.end('authentication required');
}

function copyPayload(provider, key, mode, model = '') {
  const apiKey = key.api_key;
  const baseUrl = provider.base_url;
  const modelName = model || provider.default_model || '';
  if (mode === 'base_url') return `${baseUrl}\n${apiKey}`;
  if (mode === 'env') return `export ${provider.code.toUpperCase()}_API_KEY="${apiKey}"\nexport ${provider.code.toUpperCase()}_BASE_URL="${baseUrl}"`;
  if (mode === 'curl') {
    return `curl ${baseUrl}/chat/completions \\\n  -H "Authorization: Bearer ${apiKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${modelName}","messages":[{"role":"user","content":"你好"}]}'`;
  }
  return apiKey;
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
    SELECT DISTINCT ON (p.id) p.id provider_id, p.code, p.name, k.id key_id, k.api_key
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
      const balance = await fetchDeepSeekBalance(row.api_key);
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

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true });
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
    const saved = await saveWechatMessage({ ...payload, raw_payload: { provider: 'wechat_work', encrypted: Boolean(encrypted), xml, ...payload } });
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
    return res.end(wechatWorkReply(payload.to_user, payload.from_user, saved.reply, url));
  }
  if (url.pathname === '/api/wechat/webhook' && req.method === 'POST') {
    if (!verifyWechatSignature(url)) return sendJson(res, 403, { error: 'invalid signature' });
    const xml = await readTextBody(req);
    const payload = parseWechatXml(xml);
    const saved = await saveWechatMessage({ ...payload, raw_payload: { xml, ...payload } });
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
    return res.end(wechatTextReply(payload.to_user, payload.from_user, saved.reply));
  }
  if (url.pathname === '/api/wechat/test-message' && req.method === 'POST') {
    const data = await jsonBody(req);
    const saved = await saveWechatMessage({
      from_user: data.from_user || 'local-test-user',
      to_user: data.to_user || 'ai-key-hub',
      msg_type: 'text',
      content: data.content || '',
      raw_payload: data,
    });
    return sendJson(res, 201, saved);
  }
  if (url.pathname === '/api/wechat/test-file' && req.method === 'POST') {
    const data = await jsonBody(req);
    const kb = await ensureWechatDefaultKnowledgeBase();
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
    const result = await pool.query('SELECT * FROM finance_entries ORDER BY occurred_at DESC, id DESC LIMIT 100');
    return sendJson(res, 200, result.rows);
  }
  const financeEntryMatch = url.pathname.match(/^\/api\/finance\/entries\/(\d+)$/);
  if (financeEntryMatch && req.method === 'DELETE') {
    await pool.query('UPDATE wechat_messages SET finance_entry_id=NULL WHERE finance_entry_id=$1', [Number(financeEntryMatch[1])]);
    const result = await pool.query('DELETE FROM finance_entries WHERE id=$1', [Number(financeEntryMatch[1])]);
    return sendJson(res, 200, { deleted: result.rowCount > 0 });
  }
  if (url.pathname === '/api/wechat/messages' && req.method === 'GET') {
    const result = await pool.query('SELECT * FROM wechat_messages ORDER BY received_at DESC, id DESC LIMIT 100');
    return sendJson(res, 200, result.rows);
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
    const result = await pool.query(
      `INSERT INTO api_keys (provider_id, name, api_key, status, monthly_quota, used_amount, remark)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [data.provider_id, data.name, data.api_key, data.status || 'active', data.monthly_quota || 0, data.used_amount || 0, data.remark || '']
    );
    return sendJson(res, 201, publicKeyRow(result.rows[0]));
  }
  const keyMatch = url.pathname.match(/^\/api\/keys\/(\d+)$/);
  if (keyMatch && req.method === 'PUT') {
    const id = Number(keyMatch[1]);
    const data = await jsonBody(req);
    const result = await pool.query(
      `UPDATE api_keys SET provider_id=$1,name=$2,api_key=$3,status=$4,monthly_quota=$5,used_amount=$6,remark=$7,updated_at=now()
       WHERE id=$8 RETURNING *`,
      [data.provider_id, data.name, data.api_key, data.status || 'active', data.monthly_quota || 0, data.used_amount || 0, data.remark || '', id]
    );
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
    return sendJson(res, result.rowCount ? 200 : 404, result.rowCount ? publicKeyRow(result.rows[0]) : { error: 'not found' });
  }
  if (keyMatch && req.method === 'DELETE') {
    const result = await pool.query('DELETE FROM api_keys WHERE id=$1', [Number(keyMatch[1])]);
    return sendJson(res, 200, { deleted: result.rowCount > 0 });
  }
  const copyMatch = url.pathname.match(/^\/api\/keys\/(\d+)\/copy$/);
  if (copyMatch && req.method === 'GET') {
    const mode = url.searchParams.get('mode') || 'key';
    const model = url.searchParams.get('model') || '';
    const result = await pool.query('SELECT k.*, p.* FROM api_keys k JOIN providers p ON p.id=k.provider_id WHERE k.id=$1', [Number(copyMatch[1])]);
    if (!result.rowCount) return sendJson(res, 404, { error: 'not found' });
    const row = result.rows[0];
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
  if (docMatch && req.method === 'DELETE') {
    const deleted = await deleteKnowledgeDocument(Number(docMatch[1]));
    return sendJson(res, 200, { deleted });
  }
  if (url.pathname === '/api/knowledge/search' && req.method === 'POST') {
    const data = await jsonBody(req);
    const rows = await searchKnowledge(data.kb_id, data.query || '', Number(data.top_k || 6));
    return sendJson(res, 200, rows);
  }
  if (url.pathname === '/api/knowledge/ask' && req.method === 'POST') {
    const data = await jsonBody(req);
    const question = data.question || '';
    const sources = await searchKnowledge(data.kb_id, question, Number(data.top_k || 6));
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
    const answer = sources.length ? await deepseekKnowledgeAnswer(question, sources) : '知识库里没有检索到相关内容。';
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
    return sendJson(res, 200, { answer, sources, from_cache: false, query: saved.rows[0] });
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
    const result = await pool.query(`
      UPDATE assistant_tasks
      SET status=COALESCE($1,status), completed_at=CASE WHEN $1='done' THEN now() ELSE completed_at END, updated_at=now()
      WHERE id=$2 RETURNING *`, [data.status || null, Number(taskMatch[1])]);
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
  const memoryMatch = url.pathname.match(/^\/api\/assistant\/memories\/(\d+)$/);
  if (memoryMatch && req.method === 'PATCH') {
    const data = await jsonBody(req);
    const result = await pool.query(`
      UPDATE assistant_memories
      SET pinned=COALESCE($1, pinned), importance=COALESCE($2, importance), updated_at=now()
      WHERE id=$3 RETURNING *`, [data.pinned === undefined ? null : Boolean(data.pinned), data.importance === undefined ? null : Number(data.importance), Number(memoryMatch[1])]);
    return sendJson(res, result.rowCount ? 200 : 404, result.rowCount ? result.rows[0] : { error: 'not found' });
  }
  if (memoryMatch && req.method === 'DELETE') {
    const result = await pool.query('DELETE FROM assistant_memories WHERE id=$1', [Number(memoryMatch[1])]);
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
    const publicApi = ['/api/health', '/api/wechat/webhook', '/api/wechat/work-webhook'].includes(url.pathname);
    if (!publicApi && !authorized(req)) return sendUnauthorized(res);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: error.message });
  }
}).listen(PORT, () => {
  console.log(`AI Key Hub running at http://127.0.0.1:${PORT}`);
  setTimeout(() => {
    processDueAssistantTasks().catch((error) => console.error('[tasks] startup', error.message));
  }, 5000);
  setInterval(() => {
    processDueAssistantTasks().catch((error) => console.error('[tasks] poll', error.message));
  }, ASSISTANT_TASK_POLL_MS);
});
