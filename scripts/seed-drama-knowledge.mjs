#!/usr/bin/env node
/**
 * 将 knowledge-seeds/*.md 同步到主知识库（同名 replace）。
 * 用法：node scripts/seed-drama-knowledge.mjs [baseUrl]
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SEED_DIR = path.join(ROOT, 'knowledge-seeds');
const BASE = process.argv[2] || process.env.AI_KEY_HUB_URL || 'http://127.0.0.1:8899';

/** 文件名前缀 → drama_tags（script / storyboard） */
const TAGS_BY_PREFIX = {
  '01': 'storyboard',
  '02': 'storyboard',
  '03': 'script',
  '04': 'script',
  '05': 'script',
  '06': 'storyboard',
  '07': 'script',
  '08': 'script',
  '09': 'storyboard',
  '10': 'script',
};

async function api(pathname, options = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) { /* noop */ }
  if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
  return data;
}

function titleFromFilename(name) {
  return name
    .replace(/^\d+-/, '')
    .replace(/\.md$/i, '')
    .trim();
}

function tagsForFile(name) {
  const prefix = String(name).slice(0, 2);
  return TAGS_BY_PREFIX[prefix] || 'script,storyboard';
}

async function main() {
  const kb = await api('/api/knowledge/primary');
  const files = (await readdir(SEED_DIR))
    .filter((f) => f.endsWith('.md'))
    .sort();
  if (!files.length) {
    console.log('No seed files in knowledge-seeds/');
    return;
  }
  console.log(`KB #${kb.id} (${kb.name}) @ ${BASE}`);
  const results = [];
  for (const file of files) {
    const text = await readFile(path.join(SEED_DIR, file), 'utf8');
    const title = titleFromFilename(file);
    const tags = tagsForFile(file);
    const created = await api(`/api/knowledge/bases/${kb.id}/documents/text`, {
      method: 'POST',
      body: JSON.stringify({
        title,
        text,
        version_strategy: 'replace',
        source_note: `drama_tags:${tags}`,
      }),
    });
    const doc = created.document || created;
    const chunks = created.processed?.chunks ?? doc.chunk_count ?? 0;
    results.push({ title, id: doc.id, chunks, status: doc.status, tags });
    console.log(`✓ ${title} → doc#${doc.id} (${chunks} chunks, tags=${tags})`);
  }
  console.log(`Done: ${results.length} documents`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
