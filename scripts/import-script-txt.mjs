#!/usr/bin/env node
/**
 * Import a LocalMiniDrama-style full-script .txt into drama_projects.
 * Usage: node scripts/import-script-txt.mjs /path/to/剧本.txt
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://ai_admin:ai_admin_123@127.0.0.1:5432/ai_key_hub';
const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node scripts/import-script-txt.mjs <script.txt>');
  process.exit(1);
}

function parseFullScript(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  const title = (lines[0] || '').trim() || '未命名剧本';

  let genre = '';
  let synopsis = '';
  const characters = [];
  let section = null;
  const synopsisLines = [];
  const appearanceLines = [];

  for (const line of lines.slice(1)) {
    const t = line.trim();
    if (/^={5,}/.test(t)) {
      if (section === 'synopsis' || section === 'appearance') section = null;
      continue;
    }
    if (/^类型[：:]/.test(t)) {
      genre = t.replace(/^类型[：:]\s*/, '').trim();
      continue;
    }
    if (/^集数[：:]/.test(t) || /^导出时间[：:]/.test(t)) continue;
    if (t === '【角色外形】') {
      section = 'appearance';
      continue;
    }
    if (t === '【剧情简介】') {
      section = 'synopsis';
      continue;
    }
    if (/^第\s*\d+\s*集/.test(t)) break;
    if (section === 'appearance' && t) appearanceLines.push(t);
    if (section === 'synopsis' && t) synopsisLines.push(t);
  }

  synopsis = synopsisLines.join('\n').trim();
  for (const row of appearanceLines) {
    const m = row.match(/^([^：:]+)[：:]\s*(.+)$/);
    if (m) characters.push({ name: m[1].trim(), appearance: m[2].trim() });
  }

  const markerRe = /^(第\s*\d+\s*集)\s*[　\s]*(.*)$/;
  const episodes = [];
  let current = null;
  let pastHeader = false;

  for (const line of lines) {
    const t = line.trim();
    if (/^第\s*\d+\s*集/.test(t)) pastHeader = true;
    if (!pastHeader) continue;
    if (/^-{5,}$/.test(t)) continue;
    const m = t.match(markerRe);
    if (m) {
      if (current) {
        current.script_content = current.lines.join('\n').replace(/\s+$/, '').trim();
        episodes.push(current);
      }
      const epNo = Number(m[1].match(/\d+/)?.[0] || episodes.length + 1);
      const epTitle = (m[2] || '').trim() || m[1];
      current = { episode_no: epNo, title: epTitle, lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) {
    current.script_content = current.lines.join('\n').replace(/\s+$/, '').trim();
    episodes.push(current);
  }

  return { title, genre, synopsis, characters, episodes };
}

const parsed = parseFullScript(readFileSync(filePath, 'utf8'));
if (!parsed.episodes.length) {
  console.error('未解析到分集内容');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

const client = await pool.connect();
try {
  await client.query('BEGIN');
  const existing = await client.query(
    'SELECT id FROM drama_projects WHERE title=$1 ORDER BY id DESC LIMIT 1',
    [parsed.title],
  );
  let projectId = existing.rows[0]?.id;
  if (projectId) {
    await client.query(
      `UPDATE drama_projects SET
        genre=$2, synopsis=$3, outline=$3, logline=$4, status='ready', updated_at=now()
       WHERE id=$1`,
      [projectId, parsed.genre, parsed.synopsis, parsed.synopsis.slice(0, 120)],
    );
    await client.query('DELETE FROM drama_episodes WHERE project_id=$1', [projectId]);
    await client.query('DELETE FROM drama_characters WHERE project_id=$1', [projectId]);
    console.log(`更新已有项目 #${projectId}`);
  } else {
    const inserted = await client.query(
      `INSERT INTO drama_projects (title, genre, synopsis, outline, logline, style_guide, status)
       VALUES ($1,$2,$3,$3,$4,'写实青春', 'ready')
       RETURNING id`,
      [parsed.title, parsed.genre, parsed.synopsis, parsed.synopsis.slice(0, 120)],
    );
    projectId = inserted.rows[0].id;
    console.log(`新建项目 #${projectId}`);
  }

  for (let i = 0; i < parsed.episodes.length; i += 1) {
    const ep = parsed.episodes[i];
    const synopsis = ep.script_content.slice(0, 400);
    await client.query(
      `INSERT INTO drama_episodes (project_id, episode_no, title, synopsis, script_content, status, sort_order)
       VALUES ($1,$2,$3,$4,$5,'ready',$2)`,
      [projectId, ep.episode_no, ep.title, synopsis, ep.script_content],
    );
  }

  for (let i = 0; i < parsed.characters.length; i += 1) {
    const c = parsed.characters[i];
    await client.query(
      `INSERT INTO drama_characters (project_id, name, appearance, sort_order)
       VALUES ($1,$2,$3,$4)`,
      [projectId, c.name, c.appearance, i + 1],
    );
  }

  await client.query('COMMIT');
  console.log(JSON.stringify({
    project_id: projectId,
    title: parsed.title,
    genre: parsed.genre,
    episodes: parsed.episodes.length,
    characters: parsed.characters.map((c) => c.name),
    open: `http://127.0.0.1:8899/drama.html`,
  }, null, 2));
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
  await pool.end();
}
