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

export function storyExpansionSystemPrompt(batchCount, { fromEpisode = 1, totalEpisodes = null } = {}) {
  const n = Math.max(1, Number(batchCount) || 1);
  const from = Math.max(1, Number(fromEpisode) || 1);
  const total = Math.max(from + n - 1, Number(totalEpisodes) || from + n - 1);
  const episodeList = Array.from({ length: n }, (_, i) => from + i).join('、');
  return `你是专业编剧，写的短剧正文将直接用于拆分镜、生成图片提示词与视频提示词（对齐 LocalMiniDrama）。

要求：
1. 用中文写作，叙事清晰，必须是「看得见的连续动作」，不是大纲摘要。
2. 场景、人物动作、眼神、微表情、对白与身体反应写全；不要分镜编号或「内景/外景」标记。
3. 每集约 1500～2200 字。多集必须前后衔接，每集从上一集结尾推进。
4. 每集有清晰起承转合，结尾留悬念或转折。
5. 本剧共 ${total} 集；本轮只写第 ${episodeList} 集（共 ${n} 集），不要输出其他集。

输出格式（必须严格遵守）：
返回一个 JSON 数组，必须恰好包含 ${n} 个对象，episode 字段分别为 ${episodeList}：
[
  {
    "episode": ${from},
    "title": "本集标题（5-10字）",
    "content": "本集剧本正文（约1500-2200字）"
  }
]
必须只返回纯 JSON 数组，不要 markdown。直接以 [ 开头，以 ] 结尾。`;
}

export function buildStoryUserPrompt({
  project,
  outline,
  hooks,
  episodeCount,
  fromEpisode = 1,
  batchCount = null,
  previousEnding = '',
}) {
  const total = Math.max(1, Number(episodeCount) || 1);
  const from = Math.max(1, Number(fromEpisode) || 1);
  const batch = Math.max(1, Number(batchCount) || total);
  const to = Math.min(total, from + batch - 1);
  const hookText = Array.isArray(hooks) && hooks.length
    ? hooks.map((h) => `第${h.episode || '?'}集钩子：${h.hook || h}`).join('\n')
    : '（无分集钩子）';
  const prev = String(previousEnding || '').trim();
  return [
    `剧名：${project?.title || ''}`,
    `类型：${project?.genre || ''}`,
    `画风：${project?.style_guide || ''}`,
    `一句话：${project?.logline || ''}`,
    `大纲：\n${outline || project?.outline || project?.synopsis || ''}`,
    `分集钩子：\n${hookText}`,
    `全剧共 ${total} 集。本轮只扩写第 ${from} 集到第 ${to} 集（共 ${to - from + 1} 集）。`,
    prev ? `上一集结尾（必须承接）：\n${prev}` : (from > 1 ? '上一集正文暂缺，请按大纲合理衔接。' : ''),
    `请输出恰好 ${to - from + 1} 集完整剧本 JSON 数组，episode 从 ${from} 到 ${to}。`,
  ].filter(Boolean).join('\n');
}

export function characterExtractionSystemPrompt(style = '') {
  const styleLine = style ? `- **风格要求**：${style}\n` : '';
  return `你是一个专业的角色分析师，擅长从剧本中提取和分析角色信息。

**【语言要求】所有字段的值必须使用中文，禁止出现英文内容（role字段的值除外，固定为 main/supporting/minor；identity_anchors 的键名用英文）。**

你的任务是根据提供的剧本内容，提取并整理剧中出现的所有有名字角色的设定。

要求：
1. 提取所有有名字的角色（忽略无名路人或背景角色）
2. 对每个角色，提取以下信息（全部用中文填写值）：
   - name: 角色名字（中文）。若有多服装/多阶段（体校/日常/训练/救援服/毕业/末章/对战/兽态），必须拆成多条独立对象，用间隔号命名：如「姓名·体校」「姓名·日常」「姓名·训练」「姓名·救援服」「姓名·毕业」「姓名·末章」。禁止把多形态揉成一条。
   - role: 角色类型，固定值之一：main / supporting / minor
   - appearance: 外貌描述（中文，100-200字，含性别、年龄、体型、五官、发型、**且只能写一套服装**；不含场景）。**一条=一套装，禁止**「体校阶段穿运动服；救援阶段穿作训服」这类混写——否则一张定妆图会乱成只画救援服或衣服混搭。不同形态须拆成不同 name，各自只写对应那一套。主角之间、配角与主角之间必须有**可画差异**（脸型/眉眼/肤色/发型/身高体型至少 2 项拉开），禁止多个男性都写成「短发精瘦年轻运动员」同款脸。
   - identity_anchors: **必填**结构化对象，至少填齐下列字段中的 3 项（键名英文、值中文）：
     species（物种）, face_shape（脸型）, facial_features（五官）, unique_marks（辨识标记）, hair_style（发型）, outfit（服饰/体态轮廓）, skin_texture, color_anchors
     对战/兽态/怪物形态必须含 species + unique_marks + outfit（或体态），且与日常态明显区分。
     **hair_style 铁律**：必须写清「发长 + 造型」（如「寸头，发长约1–3cm前后一致」或「齐肩黑直发中分」）。**禁止**近音错写「村头」「衬头」。**短发/寸头/板寸禁止写「贴额头」「贴着额头」「刘海贴额」**（会画成长刘海）；短发只写发长与干净发际线。
   - personality: 性格要点（中文，可短）
   - voice_style: 音色描述或厂商音色ID（用于 TTS / 视频音色锁）
   - description: 背景故事和角色关系（中文，50-100字）
3. 主要角色外貌要详细；配角可简化，但 identity_anchors 仍须达标，且五官/发型不得与主角撞脸
4. 【全局形态规则】只要剧情出现变身/对战/兽化，就拆条命名并分别给锚点——不限题材（都市/古风/山海均适用）。
5. 【同项目撞脸禁止·强制】同一返回数组内：主名不同（「·」前不同）的角色，脸型/眉眼/肤色/发型/下颌至少拉开 2 项；「姓名·日常」「姓名·训练」「姓名·救援服」可共用同一张脸只换装。配角禁止复刻主角五官，禁止多人同款「短发精瘦年轻运动员脸」。
6. 【单套服装·最高优先级，供生图用】同一 appearance **只能描述一套服装**。体校运动服、日常便服、救援作训服必须拆成「姓名·体校 / ·日常 / ·救援服」三条，禁止在一条里用分号罗列多阶段着装。
7. 【伤情与磨损消歧·最高优先级，供生图用】
   - 身体受伤 → 必须写在**皮肤/肌肤**上：如「左膝皮肤有新鲜擦伤与碎石刮痕，干血痂附着在膝盖骨皮肤上，裤面完整」
   - 衣物破损 → 必须写在**布料/裤面/衣料**上：如「浅灰作训裤膝部布料磨破露出内衬，不见皮肤伤口」
   - **禁止**歧义写法：「膝盖处有划痕」「手臂有伤」「腿上有血痕」——图片模型常会画成裤子/袖子破损而非皮肤伤
   - 泥污、汗渍同理：写清「皮肤上的汗」「衣料被汗浸透」
8. 【发型用词消歧·最高优先级】
   - 短寸发必须写「寸头」并注明发长约 1–3cm、前后左右一致；**严禁**写成「村头」「衬头」「存头」
   - **短发/寸头/板寸禁止写「贴额头」「贴着额头」「刘海贴额」**：这些词会把短发画成长刘海；短发只写发长与造型，不要写贴额
   - 仅当剧本明确是长发刘海造型时，才可写刘海；与短发/寸头互斥
   - appearance 与 identity_anchors.hair_style 必须可直接指导生图，禁止近音错字与过短歧义词
9. 【服装形态尽量拆全·强制，供视频参考图，宁可多不可少】剧本里只要出现明显不同着装/体态，就必须拆成独立「姓名·形态」行，**同一人光膀与穿衣同时出现时必须同时产出「·训练」和「·日常」**，禁止只提一条「日常」漏掉光膀。常见映射：
   - 光着上身 / 赤膊 / 训练后只穿短裤休息 →「姓名·训练」：appearance 与 outfit **必须写明光着上身、仅着短裤**，定妆图禁止画上衣/T恤/背心
   - 背心、外套、便服、日常穿衣 →「姓名·日常」
   - 救援作训服 / 消防服 / 应急救援装 →「姓名·救援服」
   - 体校/校队运动服（与日常明显不同时）→「姓名·体校」
   - 学士服/毕业装 →「姓名·毕业」
   - 末章明显不同（发长变化、胡茬、破皮卡等）→「姓名·末章」
   鞋靴、手表等穿戴物写进该形态的 outfit，不要指望用单独道具图替代。提取结束后自检：剧本有光膀句而结果无「·训练」=不合格，必须补上。
${styleLine}- **图片比例**：9:16
输出格式：
**重要：必须只返回纯JSON数组，不要包含任何markdown代码块、说明文字或其他内容。直接以 [ 开头，以 ] 结尾。**
每个元素是一个角色对象，包含上述字段。`;
}

export function buildCharacterExtractionUserPrompt(scriptText = '') {
  return `剧本内容：
${scriptText}

请提取剧本中所有有名字角色的设定。

【同项目撞脸禁止·强制】同一 JSON 数组内，主名不同（间隔号「·」前不同）的角色，脸型/眉眼/肤色/发型/下颌至少拉开 2 项；「姓名·日常」「姓名·训练」「姓名·救援服」可共用同一张脸只换装。配角禁止复刻任一主角五官。

【单套服装·强制】禁止在一条 appearance 里写「体校阶段穿…；救援阶段穿…」。体校/日常/救援/毕业/末章必须拆成「姓名·体校」「姓名·日常」「姓名·训练」「姓名·救援服」「姓名·毕业」「姓名·末章」等多条，每条只写一套装——一张定妆图只能画一套服装。

【形态尽量拆全·强制】剧本出现光膀/赤膊→必须有「·训练」（须写明光着上身仅短裤，禁止上衣）；背心外套→「·日常」；救援服→「·救援服」；学士服→「·毕业」；末章发长/胡茬/破皮卡→「·末章」。同一人既有光膀又有穿衣时，·训练与·日常必须同时产出。穿在脚上的鞋写进 outfit。

【短发禁贴额】寸头/短发禁止写「贴额头/刘海贴额」，只写发长约1–3cm前后一致。`;
}

export function sceneExtractionSystemPrompt(style = '') {
  const styleLine = style ? `5. **风格要求**：${style}\n` : '';
  return `【任务】从剧本中提取所有唯一的场景背景

【要求】
1. 识别剧本中所有不同的场景（地点+时间组合），尽量拆全，宁可多不可少
2. 为每个场景生成详细的**中文**图片生成提示词（Prompt）
3. **重要**：场景描述必须是**纯背景**，不能包含人物、角色、动作等元素
4. **重要**：prompt 字段必须为中文，不得使用英文（风格词如 realistic 可保留）
${styleLine}   - **图片比例**：9:16

【输出格式】
**重要：必须只返回纯JSON数组，不要包含任何markdown代码块。直接以 [ 开头，以 ] 结尾。**
每个元素包含：location（地点）, time（时间）, prompt（完整的中文图片生成提示词，纯背景，明确说明无人物）。`;
}

export function propExtractionSystemPrompt(style = '') {
  const styleLine = style ? `- **风格要求**：${style}\n` : '';
  return `你是一位专业的剧本道具分析师，擅长从剧本中提取具有视觉特征的关键道具。

你的任务是根据提供的剧本内容，提取并整理**值得单独出参考图**的道具（尽量覆盖后续视频会用到的独立物件，但禁止把「穿在人身上的东西」拆成伪道具）。

要求：
1. **积极提取**对剧情有用、或后续分镜/视频可能要单独锚定的独立物件（信物、礼物、脱下的衣物、标志性陈设、交通工具局部等）。宁可多提真正独立的道具，也不要漏掉关键信物。
2. 普通无剧情意义的杯子、笔等仍可不提。
3. **禁止提取（应写进角色形态 outfit，或人自带）**：
   - 正穿在脚上的鞋靴（运动鞋、跑鞋、靴子等）——鞋子画在角色定妆里
   - 人体部位与手势（小指、手指、手、拉钩/勾手指等）——人自带手，不必单独出图
   - 正穿在身上的训练服/校服/救援服/外套等——应拆成角色「·日常 / ·训练 / ·救援服」形态，不要当道具
4. **例外**：已脱下/扔在一旁的衣物可提；作为礼物/鞋盒展品的鞋可提。
5. 归属者、剧中人名等**只**写在 "description"，**不要**写进 "image_prompt"。
6. 字段：name, type, description（中文 80-150 字）, image_prompt（中文单道具棚拍提示词，无人物无场景）。
${styleLine}- **图片比例**：9:16

【输出格式】
**重要：必须只返回纯JSON数组，不要包含任何markdown代码块、说明文字或其他内容。直接以 [ 开头，以 ] 结尾。**
每个对象包含上述字段。`;
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

export function normalizeEpisodeScripts(parsed, episodeCount, fromEpisode = 1) {
  const n = Math.max(1, Number(episodeCount) || 1);
  const from = Math.max(1, Number(fromEpisode) || 1);
  let list = [];
  if (Array.isArray(parsed)) list = parsed;
  else if (Array.isArray(parsed?.episodes)) list = parsed.episodes;
  else if (Array.isArray(parsed?.data)) list = parsed.data;
  return list.slice(0, n).map((item, index) => ({
    episode: Number(item.episode || item.episode_number || from + index) || from + index,
    title: String(item.title || `第${from + index}集`).trim(),
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
