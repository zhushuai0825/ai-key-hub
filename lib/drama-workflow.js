/**
 * LocalMiniDrama-aligned drama workflow helpers:
 * outline → episode scripts → extract characters/scenes/props → ZIP v1.5
 */

import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const LMD_EXPORT_VERSION = '1.5';

export function parseModelJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try { return JSON.parse(fenced[1].trim()); } catch (_) { /* fallthrough */ }
    }
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try { return JSON.parse(arrayMatch[0]); } catch (_) { /* fallthrough */ }
    }
    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try { return JSON.parse(objectMatch[0]); } catch (_) { /* fallthrough */ }
    }
  }
  return null;
}

export function outlineSystemPrompt() {
  return `你是短剧/漫剧策划。根据用户想法写出可拍的大纲。
要求：
1. 用中文。
2. synopsis（故事大纲）1500～2800 字，写清人物、冲突、反转、结局走向，必须是「看得见的情节」，不是空口号。
3. episode_hooks 按集给出可见动作钩子，数量与 suggested_episode_count 一致。
4. 只返回 JSON 对象，不要 markdown。
格式：
{
  "title": "剧名",
  "logline": "一句话卖点",
  "synopsis": "完整大纲正文",
  "genre": "类型",
  "style": "画风/气质",
  "suggested_episode_count": 3,
  "episode_hooks": [{"episode":1,"hook":"本集可见动作钩子"}]
}`;
}

export function outlineChatSystemPrompt() {
  return `你是短剧/漫剧策划搭档，通过多轮对话帮用户打磨大纲（对齐 LocalMiniDrama 灵感对话）。
规则：
1. 只返回 JSON，不要 markdown。
2. reply：中文，简洁，像微信聊天，60～120 字；可追问缺口（主角、冲突、反转、集数）。
3. 根据本轮用户输入，更新 draft；保留已有合理设定，合并新信息。
4. 当信息够写完整大纲时，把 draft.synopsis 写满 800～2000 字可见情节；信息不够时 synopsis 可先短，并在 reply 追问。
5. ready=true 仅当 synopsis 已足够支撑后续扩写成剧本。
格式：
{
  "reply": "给用户看的话",
  "ready": false,
  "draft": {
    "title": "剧名",
    "logline": "一句话卖点",
    "synopsis": "大纲正文",
    "genre": "类型",
    "style": "画风",
    "suggested_episode_count": 3,
    "episode_hooks": [{"episode":1,"hook":"可见动作钩子"}]
  }
}`;
}

export function storyExpansionSystemPrompt(episodeCount) {
  const n = Math.max(1, Number(episodeCount) || 1);
  return `你是专业编剧，写的短剧正文将直接用于拆分镜、生成图片提示词与视频提示词（对齐 LocalMiniDrama）。

要求：
1. 用中文写作，叙事清晰，必须是「看得见的连续动作」，不是大纲摘要。
2. 场景、人物动作、眼神、微表情、对白与身体反应写全；不要分镜编号或「内景/外景」标记。
3. 每集约 1500～2200 字。多集必须前后衔接，每集从上一集结尾推进。
4. 每集有清晰起承转合，结尾留悬念或转折。

输出格式（必须严格遵守）：
返回一个 JSON 数组，必须恰好包含 ${n} 个对象：
[
  {
    "episode": 1,
    "title": "第一集标题（5-10字）",
    "content": "本集剧本正文（约1500-2200字）"
  }
]
必须只返回纯 JSON 数组，不要 markdown。直接以 [ 开头，以 ] 结尾。`;
}

export function characterExtractionSystemPrompt(style = '') {
  return `你是专业角色分析师，从剧本提取有名字角色（对齐 LocalMiniDrama）。

【语言】字段值用中文（role 固定 main/supporting/minor）。

要求：
1. 提取所有有名字角色，忽略无名路人。
2. 每条含：name, role, appearance, personality, voice_style, description, identity_anchors。
3. 多服装/多阶段拆成「姓名·日常」「姓名·训练」等独立对象，一条只写一套服装。
4. identity_anchors 至少填 3 项：species/face_shape/facial_features/unique_marks/hair_style/outfit/skin_texture/color_anchors。
5. 不同主名角色脸型/眉眼/发型至少拉开 2 项，禁止撞脸。
${style ? `- 风格要求：${style}` : ''}

只返回纯 JSON 数组，不要 markdown。直接以 [ 开头，以 ] 结尾。`;
}

export function sceneExtractionSystemPrompt(style = '') {
  return `【任务】从剧本中提取所有唯一的场景背景（对齐 LocalMiniDrama）。

要求：
1. 识别所有不同场景（地点 + 时间组合）。
2. 每个场景生成纯背景生图提示词，明确无人物、无人、空场景。
3. 字段：location（地点）, time（时间）, prompt（中文图片提示词）。
${style ? `4. 风格要求：${style}` : ''}

只返回纯 JSON 数组，不要 markdown。直接以 [ 开头，以 ] 结尾。`;
}

export function propExtractionSystemPrompt(style = '') {
  return `你是剧本道具分析师，提取值得单独出参考图的道具（对齐 LocalMiniDrama）。

要求：
1. 提取关键独立物件；普通无剧情杯子/笔可不提。
2. 禁止：正穿在身上的衣服、鞋、人体部位/手势（应写进角色形态）。
3. 允许：脱下扔在一旁的衣物、礼物鞋、信物等。
4. 字段：name, type, description（中文 80-150 字）, image_prompt（中文单道具棚拍提示词，无人物无场景）。
${style ? `5. 风格要求：${style}` : ''}

只返回纯 JSON 数组，不要 markdown。直接以 [ 开头，以 ] 结尾。`;
}

export function buildOutlineUserPrompt({ idea, title, genre, styleGuide, episodeCount }) {
  return [
    idea ? `用户想法：\n${idea}` : '',
    title ? `现有标题：${title}` : '',
    genre ? `类型：${genre}` : '',
    styleGuide ? `画风：${styleGuide}` : '',
    `希望集数：${Math.max(1, Number(episodeCount) || 3)}`,
    '请输出完整大纲 JSON。',
  ].filter(Boolean).join('\n');
}

export function buildStoryUserPrompt({ project, outline, hooks, episodeCount }) {
  const hookText = Array.isArray(hooks) && hooks.length
    ? hooks.map((h) => `第${h.episode || '?'}集钩子：${h.hook || h}`).join('\n')
    : '（无分集钩子）';
  return [
    `剧名：${project?.title || ''}`,
    `类型：${project?.genre || ''}`,
    `画风：${project?.style_guide || ''}`,
    `一句话：${project?.logline || ''}`,
    `大纲：\n${outline || project?.outline || project?.synopsis || ''}`,
    `分集钩子：\n${hookText}`,
    `请扩写成恰好 ${Math.max(1, Number(episodeCount) || 1)} 集完整剧本 JSON 数组。`,
  ].join('\n');
}

export function collectScriptText(episodes = [], project = null) {
  const parts = (episodes || [])
    .slice()
    .sort((a, b) => Number(a.episode_no) - Number(b.episode_no))
    .map((ep) => {
      const body = String(ep.script_content || ep.synopsis || '').trim();
      if (!body) return '';
      return `【第${ep.episode_no}集 ${ep.title || ''}】\n${body}`;
    })
    .filter(Boolean);
  if (parts.length) return parts.join('\n\n');
  return String(project?.outline || project?.synopsis || '').trim();
}

export function normalizeEpisodeScripts(parsed, episodeCount) {
  const n = Math.max(1, Number(episodeCount) || 1);
  let list = [];
  if (Array.isArray(parsed)) list = parsed;
  else if (Array.isArray(parsed?.episodes)) list = parsed.episodes;
  else if (Array.isArray(parsed?.data)) list = parsed.data;
  return list.slice(0, n).map((item, index) => ({
    episode: Number(item.episode || item.episode_number || index + 1) || index + 1,
    title: String(item.title || `第${index + 1}集`).trim(),
    content: String(item.content || item.script || item.text || item.body || '').trim(),
  })).filter((item) => item.content);
}

export function normalizeCharacters(parsed) {
  const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.characters) ? parsed.characters : []);
  return list.map((item, index) => {
    const anchors = item.identity_anchors && typeof item.identity_anchors === 'object' ? item.identity_anchors : {};
    const appearance = String(item.appearance || '').trim()
      || [anchors.hair_style, anchors.outfit, anchors.facial_features].filter(Boolean).join('；');
    return {
      name: String(item.name || `角色${index + 1}`).trim(),
      role: ['main', 'supporting', 'minor'].includes(String(item.role || '').trim()) ? String(item.role).trim() : 'supporting',
      appearance,
      personality: String(item.personality || item.description || '').trim(),
      voice_note: String(item.voice_style || item.voice_note || '').trim(),
      ref_prompt: String(item.ref_prompt || appearance || '').trim(),
      description: String(item.description || '').trim(),
      identity_anchors: anchors,
    };
  }).filter((item) => item.name);
}

export function normalizeScenes(parsed) {
  const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.scenes) ? parsed.scenes : []);
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const location = String(item.location || item.name || '').trim();
    const time = String(item.time || item.period || '日').trim() || '日';
    const prompt = String(item.prompt || item.image_prompt || '').trim();
    if (!location) continue;
    const key = `${location}|${time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ location, time, prompt: prompt || `${location}，${time}，空场景，无人物` });
  }
  return out;
}

export function normalizeProps(parsed) {
  const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.props) ? parsed.props : []);
  return list.map((item, index) => ({
    name: String(item.name || `道具${index + 1}`).trim(),
    type: String(item.type || '关键道具').trim() || '关键道具',
    description: String(item.description || '').trim(),
    prompt: String(item.image_prompt || item.prompt || '').trim(),
  })).filter((item) => item.name);
}

export function buildLmdProjectJson({ project, characters = [], scenes = [], props = [], episodes = [] }) {
  let hooks = project?.episode_hooks;
  if (typeof hooks === 'string') {
    try { hooks = JSON.parse(hooks); } catch (_) { hooks = []; }
  }
  if (!Array.isArray(hooks)) hooks = [];

  return {
    version: LMD_EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    drama: {
      title: project?.title || '未命名漫剧',
      description: project?.outline || project?.synopsis || '',
      genre: project?.genre || null,
      style: project?.style_guide || 'anime style',
      status: project?.status || 'draft',
      tags: '[]',
      metadata: {
        aspect_ratio: '9:16',
        story_style: project?.style_guide || '',
        video_clip_duration: 5,
        inspire_hooks: hooks,
        logline: project?.logline || '',
        style_prompt_zh: project?.style_guide || '',
        exported_from: 'ai-key-hub',
      },
    },
    characters: characters.map((c) => ({
      name: c.name,
      role: c.role || c.mbti || 'supporting',
      description: c.description || '',
      personality: c.personality || '',
      appearance: c.appearance || '',
      voice_style: c.voice_note || '',
      polished_prompt: c.ref_prompt || null,
      image_file: null,
      extra_image_files: [],
    })),
    scenes: scenes.map((s, index) => ({
      location: s.location,
      time: s.time || '日',
      prompt: s.prompt || '',
      polished_prompt: null,
      episode_index: Number.isFinite(Number(s.episode_index)) ? Number(s.episode_index) : 0,
      image_file: null,
      extra_image_files: [],
      _sort: index,
    })),
    props: props.map((p, index) => ({
      name: p.name,
      type: p.type || '关键道具',
      description: p.description || '',
      prompt: p.prompt || '',
      episode_index: Number.isFinite(Number(p.episode_index)) ? Number(p.episode_index) : 0,
      image_file: null,
      extra_image_files: [],
      _sort: index,
    })),
    episodes: episodes
      .slice()
      .sort((a, b) => Number(a.episode_no) - Number(b.episode_no))
      .map((ep) => ({
        episode_number: Number(ep.episode_no) || 1,
        title: ep.title || `第${ep.episode_no}集`,
        description: ep.synopsis || '',
        script_content: ep.script_content || ep.synopsis || '',
        duration: 0,
        storyboards: [],
      })),
  };
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j += 1) {
      const bit = crc & 1;
      crc = (crc >>> 1) ^ (bit ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Minimal ZIP (store or deflate) for a few text/binary files — no external dep. */
export function buildZipBuffer(files = []) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(String(file.name || 'file'), 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data || ''), 'utf8');
    const compressed = zlib.deflateRawSync(data);
    const useDeflate = compressed.length < data.length;
    const payload = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    localParts.push(localHeader, name, payload);
    centralParts.push(central, name);
    offset += localHeader.length + name.length + payload.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDir, end]);
}

export function safeZipFilename(title = 'drama') {
  const base = String(title || 'drama').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'drama';
  return `${base}_lmd_${crypto.randomBytes(3).toString('hex')}.zip`;
}
