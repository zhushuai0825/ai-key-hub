import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8899);
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://ai_admin:ai_admin_123@127.0.0.1:5432/ai_key_hub';
const pool = new Pool({ connectionString: DATABASE_URL });

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

async function stats() {
  const [providers, keys, usage] = await Promise.all([
    pool.query('SELECT COUNT(*)::int count, COALESCE(SUM(balance),0)::float total_balance FROM providers'),
    pool.query("SELECT COUNT(*)::int count, COUNT(*) FILTER (WHERE status != 'active')::int abnormal FROM api_keys"),
    pool.query("SELECT COUNT(*)::int calls, COALESCE(SUM(cost),0)::float cost, COALESCE(AVG(latency_ms),0)::int avg_latency FROM usage_logs WHERE created_at::date = now()::date"),
  ]);
  return { ...providers.rows[0], key_count: keys.rows[0].count, abnormal_keys: keys.rows[0].abnormal, today_calls: usage.rows[0].calls, today_cost: usage.rows[0].cost, avg_latency: usage.rows[0].avg_latency };
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true });
  if (url.pathname === '/api/stats') return sendJson(res, 200, await stats());
  if (url.pathname === '/api/providers' && req.method === 'GET') {
    const result = await pool.query(`
      SELECT p.*, COUNT(k.id)::int key_count, COUNT(m.id)::int model_count,
             COALESCE(SUM(k.used_amount),0)::float used_amount
      FROM providers p
      LEFT JOIN api_keys k ON k.provider_id = p.id
      LEFT JOIN models m ON m.provider_id = p.id
      GROUP BY p.id
      ORDER BY p.id`);
    return sendJson(res, 200, result.rows);
  }
  if (url.pathname === '/api/keys' && req.method === 'GET') {
    const result = await pool.query(`
      SELECT k.*, p.name provider_name, p.code provider_code, p.base_url,
             k.api_key AS raw_key
      FROM api_keys k JOIN providers p ON p.id = k.provider_id
      ORDER BY k.id DESC`);
    return sendJson(res, 200, result.rows.map(row => ({ ...row, api_key: maskKey(row.api_key) })));
  }
  if (url.pathname === '/api/keys' && req.method === 'POST') {
    const data = await jsonBody(req);
    const result = await pool.query(
      `INSERT INTO api_keys (provider_id, name, api_key, status, monthly_quota, used_amount, remark)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [data.provider_id, data.name, data.api_key, data.status || 'active', data.monthly_quota || 0, data.used_amount || 0, data.remark || '']
    );
    return sendJson(res, 201, { ...result.rows[0], api_key: maskKey(result.rows[0].api_key) });
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
    return sendJson(res, result.rowCount ? 200 : 404, result.rowCount ? { ...result.rows[0], api_key: maskKey(result.rows[0].api_key) } : { error: 'not found' });
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
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: error.message });
  }
}).listen(PORT, () => console.log(`AI Key Hub running at http://127.0.0.1:${PORT}`));
