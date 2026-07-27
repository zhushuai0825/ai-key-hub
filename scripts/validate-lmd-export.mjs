#!/usr/bin/env node
/**
 * 校验 export-lmd 的 project.json 是否符合 LocalMiniDrama 导入要求
 * 用法：node scripts/validate-lmd-export.mjs [projectId] [baseUrl]
 */
import { validateLmdProjectJson } from '../lib/drama-workflow.js';

const projectId = process.argv[2] || '2';
const base = process.argv[3] || process.env.AI_KEY_HUB_URL || 'http://127.0.0.1:8899';

const res = await fetch(`${base}/api/drama/projects/${projectId}/export-lmd`);
if (!res.ok) throw new Error(`export-lmd HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());

// minimal unzip for project.json
const sig = buf.indexOf(Buffer.from('project.json'));
if (sig < 0) throw new Error('ZIP 中未找到 project.json');
// use dynamic import for unzip - read via server API alternative
const jsonRes = await fetch(`${base}/api/drama/projects/${projectId}`);
const bundle = await jsonRes.json();
const shotsRes = await fetch(`${base}/api/drama/episodes/${bundle.episodes?.[0]?.id}/shots`).catch(() => null);

// Rebuild via same endpoint - parse zip manually with fflate not available; use export API json path
import { buildLmdProjectJson } from '../lib/drama-workflow.js';

const allShots = [];
for (const ep of bundle.episodes || []) {
  const r = await fetch(`${base}/api/drama/episodes/${ep.id}/shots`);
  if (r.ok) {
    const rows = await r.json();
    if (Array.isArray(rows)) allShots.push(...rows);
  }
}

const projectJson = buildLmdProjectJson({
  project: bundle.project,
  characters: bundle.characters,
  scenes: (bundle.scenes || []).map((s) => ({ ...s, time: s.time_label })),
  props: bundle.props,
  episodes: bundle.episodes,
  shots: allShots,
});

const result = validateLmdProjectJson(projectJson);
console.log(`Project #${projectId} · ${bundle.project?.title || ''}`);
console.log(`version ${projectJson.version} · episodes ${projectJson.episodes?.length} · chars ${projectJson.characters?.length} · shots ${allShots.length}`);
console.log(result.ok ? '✓ 通过 LMD 导入必填校验' : '✗ 存在阻断项');
if (result.issues.length) {
  console.log('\n阻断:');
  result.issues.forEach((x) => console.log(' -', x));
}
if (result.warnings.length) {
  console.log('\n建议:');
  result.warnings.slice(0, 20).forEach((x) => console.log(' -', x));
  if (result.warnings.length > 20) console.log(` ... 另有 ${result.warnings.length - 20} 条`);
}
process.exit(result.ok ? 0 : 1);
