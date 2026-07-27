/**
 * LocalMiniDrama-aligned drama workflow helpers:
 * outline → episode scripts → extract characters/scenes/props → ZIP v1.4 (LocalMiniDrama)
 */

import crypto from 'node:crypto';
import zlib from 'node:zlib';

/** 与 LocalMiniDrama dramaExportService.js 的 EXPORT_VERSION 对齐 */
export const LMD_EXPORT_VERSION = '1.4';

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
  return `你是微短剧/漫剧策划，目标是写出「能留住人、能拍成竖屏画面」的大纲。
要求：
1. 用中文。禁止破折号「——」。
2. synopsis（故事大纲）1500～2800 字，必须是「看得见的情节」：人物怎么做、冲突怎么爆、反转怎么落、结局怎么收。禁止空口号、鸡汤、主题宣言。
3. 写清核心关系、爽感引擎（观众为什么上瘾）、每段升级压力；关键道具/秘密必须落地到具体物件或事件。
4. episode_hooks 按集给「可见动作钩子」（下一秒会发生什么具体事件），数量与 suggested_episode_count 一致；禁止纯情绪钩（发呆、流泪、回忆）。
5. logline 一句话说清：谁 + 想要什么 + 最大阻碍 + 代价。
6. 只返回 JSON 对象，不要 markdown。
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
  return `你是微短剧/漫剧策划搭档，通过多轮对话帮用户打磨大纲（对齐 LocalMiniDrama 灵感对话）。
规则：
1. 只返回 JSON，不要 markdown。禁止破折号「——」。
2. reply：中文，简洁，像微信聊天，60～120 字；优先追问缺口（主角欲望、对手压力、第一次冲突、反转、集数、结局代价）。
3. 根据本轮用户输入更新 draft；保留已有合理设定，合并新信息。
4. 信息够时，draft.synopsis 写满 800～2000 字可见情节（动作、关系位移、升级节点）；不够时 synopsis 可先短，并在 reply 追问。
5. episode_hooks 必须是事件钩（新敌登场/威胁落地/身份将揭/道具易手/倒计时），不是情绪氛围。
6. ready=true 仅当 synopsis 已足够支撑后续扩写成可拍剧本。
7. 若提供了「知识库参考」：只吸收规则、设定细节、角色声线、节奏 checklist；禁止照搬其中的情节串、人名、对白、独特场景；禁止把不同项目写成同一种故事表皮。
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
  return `你是资深微短剧/漫剧编剧（工艺对齐 short-drama 工坊：竖屏完播 + 可拍性）。写出的正文会直接用于拆分镜、生图与视频，必须「可拍、可听、能钩住下一集」。

【写作目标】
1. 用中文。禁止破折号「——」「—」「--」。叙事全是「看得见的连续动作」与「听得见的对白」，不是大纲复述，也不是小说抒情。
2. 每集约 1500～2200 字。本剧共 ${total} 集；本轮只写第 ${episodeList} 集（共 ${n} 集），不要输出其他集。
3. 多集必须硬衔接：从上一集结尾的动作/威胁直接推进，禁止重述上一集剧情。

【单集节奏（微型三幕）】
4. 前约 1/4：钩子段——非第1集先用动作回应上集悬念（约一两段），立刻抛出本集新冲突；第1集则开篇前三段必须冲突或违和（秘密/威胁/欲望碰撞），禁止慢热空铺、旁白介绍、流水账日常。
5. 中间约 1/2：冲突升级——至少两层递进（压力加大 / 新信息 / 关系位移 / 第三方介入），中段禁止信息真空。
6. 末约 1/4：兑现或半兑现本集钩子，并以「事件钩」截断——下一秒会发生什么具体事（新敌登场、揭秘将破、威胁落地、倒计时、道具易手、被迫二选一）。禁用发呆、沉思、空泪、纯回忆作结。
7. 每集至少 2 个清晰剧情节点；标题 5-10 字且带冲突感。

【竖屏血肉 / 反 AI 水】
8. 信息密度：每个小段至少推进其一——压力、信息、关系、阻碍、道具、介入。连续三段原地互骂/同义重复 = 不合格。
9. 可拍性（可见性测试）：写物件、动作、表情、光线、声音、身体反应。禁止「他感到/意识到/气氛凝重/空气绷紧/内心五味杂陈」。禁止空洞评价词：电影感、氛围感、高级感、震撼、绝美、充满张力——必须改成具体画面因果。
10. 对白：口语短句；遮住名字也听得出是谁；可有潜台词；情绪失控时可打断、改口、只说关键词。禁用「因此/毫无疑问/我认为/这意味着/从某种角度」等书面腔；禁止解释观众已看见的画面。
11. 关系靠互动与称呼呈现，不用「多年好友」标签旁白。情绪转折至少有一个中间过渡状态，不能一步到位。
12. 不要写分镜编号、景别标签；用连贯正文，但镜头感要强（特写物件、对峙站位、动作因果清楚）。
13. 换场景时用场景头（推荐格式）：【场景】地点 · 日/夜 · 内/外；下一行「人物：A、B」。同地点连续戏可省略，换时空必须重写。
14. 若提供了「知识库参考」：只借工艺规则、设定考据、声线习惯、可拍写法；严禁照搬参考剧情、人名、对白、独特桥段；本集故事必须服务当前大纲与钩子，不能套成固定套路。

【输出格式（严格）】
只返回纯 JSON 数组，恰好 ${n} 个对象，episode 为 ${episodeList}。不要 markdown。直接以 [ 开头，以 ] 结尾：
[
  {
    "episode": ${from},
    "title": "本集标题（5-10字，含冲突感）",
    "content": "本集剧本正文（约1500-2200字）"
  }
]`;
}

export function buildStoryUserPrompt({
  project,
  outline,
  hooks,
  episodeCount,
  fromEpisode = 1,
  batchCount = null,
  previousEnding = '',
  knowledgeContext = '',
}) {
  const total = Math.max(1, Number(episodeCount) || 1);
  const from = Math.max(1, Number(fromEpisode) || 1);
  const batch = Math.max(1, Number(batchCount) || total);
  const to = Math.min(total, from + batch - 1);
  const relevantHooks = Array.isArray(hooks)
    ? hooks.filter((h) => {
      const ep = Number(h.episode || h.episode_no || 0);
      return !ep || (ep >= from && ep <= to);
    })
    : [];
  const hookText = relevantHooks.length
    ? relevantHooks.map((h) => `第${h.episode || '?'}集钩子（本集结尾必须兑现或升级）：${h.hook || h}`).join('\n')
    : (Array.isArray(hooks) && hooks.length
      ? hooks.map((h) => `第${h.episode || '?'}集钩子：${h.hook || h}`).join('\n')
      : '（无分集钩子——请自行设计强事件钩）');
  const prev = String(previousEnding || '').trim();
  return [
    `剧名：${project?.title || ''}`,
    `类型：${project?.genre || ''}`,
    `画风：${project?.style_guide || ''}`,
    `一句话卖点：${project?.logline || ''}`,
    `大纲（只取与本批相关的情节推进，勿整段复述）：\n${outline || project?.outline || project?.synopsis || ''}`,
    `本批分集钩子：\n${hookText}`,
    `全剧共 ${total} 集。本轮只扩写第 ${from} 集到第 ${to} 集（共 ${to - from + 1} 集）。`,
    prev ? `上一集结尾（必须承接其动作/威胁，立刻往前推）：\n${prev}` : (from > 1 ? '上一集正文暂缺，请按大纲合理衔接，并尽快进入新冲突。' : '这是开篇：前三段建立冲突或秘密，不要慢热；可用身份反差/秘密将破/直接冲突开场。'),
    '写作提醒：按「钩子→升级→事件钩」单集节奏；对白有人味；动作可拍；禁用破折号与电影感/氛围感等空词。',
    knowledgeContext ? String(knowledgeContext).trim() : '',
    `请输出恰好 ${to - from + 1} 集完整剧本 JSON 数组，episode 从 ${from} 到 ${to}。`,
  ].filter(Boolean).join('\n');
}

/** short-drama-remake：拆功能骨架 + 换皮方向（不照搬表达） */
export function remakeAnalyzeSystemPrompt() {
  return `你是微短剧「同构换皮」策划（对齐 short-drama-remake）。
任务：读参考剧本/梗概，只提取可复用的故事功能骨架，再给出 3 个不同赛道的换皮方向。

硬规则：
1. 只返回 JSON，不要 markdown。禁止破折号。
2. 禁止照搬原作人名、对白金句、独特场景专名、受保护的表面事件串。
3. skeleton 只锁「功能」：冲突职责、情绪节点、钩子职责、爽点节奏；不锁具体职业/场景/道具表达。
4. concepts 必须是 3 个方向，核心情节驱动力彼此不同（禁止三个都是「隐藏身份打脸」变体）；每个含完整可拍 synopsis（800～1800 字）与 episode_hooks（事件钩）。
5. suggested_episode_count 建议 6～12。

格式：
{
  "skeleton": {
    "story_promise": "观众期待什么兑现",
    "main_conflict": "主角要什么 vs 最大阻碍",
    "emotional_engine": "上瘾情绪引擎",
    "must_replace": ["必须换掉的表面元素1", "2"],
    "episode_functions": [{"episode":1,"function":"本集戏剧职责","hook_function":"尾钩职责"}]
  },
  "concepts": [
    {
      "id": 1,
      "title": "新剧名",
      "genre": "类型",
      "style": "画风/气质",
      "logline": "一句话卖点",
      "synopsis": "换皮后完整大纲",
      "suggested_episode_count": 8,
      "episode_hooks": [{"episode":1,"hook":"可见事件钩"}],
      "remake_note": "相对原作拉开了哪些距离"
    }
  ]
}`;
}

export function buildRemakeAnalyzeUserPrompt(sourceText = '', hint = '') {
  const raw = String(sourceText || '').trim();
  const max = 24000;
  const clipped = raw.length > max
    ? `${raw.slice(0, max)}\n\n…（原文过长已截断，请基于已给部分拆骨架）`
    : raw;
  return [
    hint ? `用户补充意向：${hint}` : '',
    '参考剧本/梗概如下（只借功能，不借表达）：',
    clipped || '（空）',
    '请输出 skeleton + 3 个换皮 concepts。',
  ].filter(Boolean).join('\n\n');
}

export function normalizeRemakeConcepts(parsed) {
  const skeleton = parsed?.skeleton && typeof parsed.skeleton === 'object' ? parsed.skeleton : {};
  const list = Array.isArray(parsed?.concepts) ? parsed.concepts : [];
  const concepts = list.slice(0, 3).map((item, index) => {
    const hooks = Array.isArray(item.episode_hooks) ? item.episode_hooks : [];
    return {
      id: Number(item.id) || index + 1,
      title: String(item.title || `换皮方向${index + 1}`).trim(),
      genre: String(item.genre || '').trim(),
      style: String(item.style || item.style_guide || '').trim(),
      logline: String(item.logline || '').trim(),
      synopsis: String(item.synopsis || item.outline || '').trim(),
      suggested_episode_count: Math.min(12, Math.max(3, Number(item.suggested_episode_count) || hooks.length || 8)),
      episode_hooks: hooks.map((h, i) => ({
        episode: Number(h.episode || i + 1) || i + 1,
        hook: String(h.hook || h || '').trim(),
      })).filter((h) => h.hook),
      remake_note: String(item.remake_note || item.note || '').trim(),
    };
  }).filter((c) => c.synopsis || c.logline);
  return {
    skeleton: {
      story_promise: String(skeleton.story_promise || '').trim(),
      main_conflict: String(skeleton.main_conflict || '').trim(),
      emotional_engine: String(skeleton.emotional_engine || '').trim(),
      must_replace: Array.isArray(skeleton.must_replace)
        ? skeleton.must_replace.map((x) => String(x || '').trim()).filter(Boolean)
        : [],
      episode_functions: Array.isArray(skeleton.episode_functions)
        ? skeleton.episode_functions.map((row, i) => ({
          episode: Number(row.episode || i + 1) || i + 1,
          function: String(row.function || '').trim(),
          hook_function: String(row.hook_function || row.hook || '').trim(),
        }))
        : [],
    },
    concepts,
  };
}

/** 单集剧本对话改稿 */
export function scriptChatSystemPrompt() {
  return `你是资深微短剧/漫剧编剧，按用户指令改写「当前这一集」正文。

硬规则：
1. 只返回 JSON，不要 markdown。禁止破折号「——」「—」「--」。
2. 默认输出完整修订后的 script_content（不是片段补丁），除非用户明确只要局部建议且 apply=false。
3. 保持本集可拍：可见动作 + 可听对白；禁止小说抒情、空洞评价词、信息真空互骂。
4. 不擅自改人物姓名与核心设定，除非用户要求；与前后集衔接尽量保留。
5. 标题可选微调；字数尽量维持在 1200～2200。
6. 若提供了「知识库参考」：只借规则与细节，禁止照搬情节表皮；改稿必须响应本轮用户指令，不能把每集改成同一套路。

格式：
{
  "reply": "用一两句说明改了什么",
  "apply": true,
  "title": "本集标题（可不改则回原文标题）",
  "script_content": "完整修订后的本集正文"
}`;
}

export function buildScriptChatUserPrompt({
  project,
  episode,
  scriptContent,
  message,
  history = [],
  knowledgeContext = '',
}) {
  const historyText = (Array.isArray(history) ? history : [])
    .slice(-8)
    .map((item) => `${item.role === 'assistant' ? '助手' : '用户'}：${item.content}`)
    .join('\n');
  const body = String(scriptContent || episode?.script_content || '').trim();
  return [
    '【项目】',
    `标题：${project?.title || ''}`,
    `类型：${project?.genre || ''}`,
    `一句话：${project?.logline || ''}`,
    `大纲摘要：${String(project?.outline || project?.synopsis || '').slice(0, 1200)}`,
    '【本集】',
    `第${episode?.episode_no || '?'}集`,
    `标题：${episode?.title || ''}`,
    `当前正文：\n${body || '（空）'}`,
    knowledgeContext ? String(knowledgeContext).trim() : '',
    `【最近改稿对话】\n${historyText || '暂无'}`,
    `【用户本轮指令】\n${String(message || '').trim()}`,
    '请按指令修订本集，返回 JSON。',
  ].filter(Boolean).join('\n');
}

/** 漫剧知识库：排除非创作文档 */
export const DRAMA_KB_EXCLUDE_RE = /保密|协议|合同|nda|简历|发票|工资单|考勤|股权|劳动合同|隐私政策/i;

/** 按步骤分域的标题关键词（默认只匹配标题；有 drama_tags 时严格按标签） */
export const DRAMA_KB_SCOPE_KEYWORDS = {
  script: /剧本|对白|钩子|开场|口语|声线|改稿|写法规范|题材冲突|母题|仿写|换皮|爽点|事件钩/,
  storyboard: /分镜|Seedance|seedance|运镜|景别|提示词|即梦|镜头|一动|视频提示/,
};

/** 从 source_note 解析 drama_tags:script,storyboard */
export function parseDramaKbTags(sourceNote = '') {
  const match = String(sourceNote || '').match(/drama_tags\s*:\s*([a-z_,\s]+)/i);
  if (!match) return [];
  return match[1].split(/[,，\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function dramaKnowledgeRowMatchesScope(row, scope = 'script') {
  const title = String(row?.document_title || row?.filename || '').trim();
  const note = String(row?.source_note || '').trim();
  if (DRAMA_KB_EXCLUDE_RE.test(title) || DRAMA_KB_EXCLUDE_RE.test(note)) return false;

  const tags = parseDramaKbTags(note);
  const normalizedScope = scope === 'storyboard' ? 'storyboard' : (scope === 'all' ? 'all' : 'script');

  if (normalizedScope === 'all') {
    if (tags.some((t) => t === 'script' || t === 'storyboard' || t === 'drama' || t === 'both')) return true;
    return DRAMA_KB_SCOPE_KEYWORDS.script.test(title) || DRAMA_KB_SCOPE_KEYWORDS.storyboard.test(title);
  }

  if (tags.length) {
    return tags.includes(normalizedScope) || tags.includes('both') || tags.includes('drama');
  }

  const re = DRAMA_KB_SCOPE_KEYWORDS[normalizedScope];
  return Boolean(re && re.test(title));
}

/** 过滤并截断漫剧知识检索结果（保持原排序） */
export function filterDramaKnowledgeRows(rows = [], { scope = 'script', topK = 4 } = {}) {
  const filtered = (Array.isArray(rows) ? rows : []).filter((row) => dramaKnowledgeRowMatchesScope(row, scope));
  return filtered.slice(0, Math.max(1, Number(topK) || 4));
}

/** 把检索到的知识片段格式化成「只借规则不借情节」的上下文 */
export function formatDramaKnowledgeContext(rows = []) {
  const list = Array.isArray(rows) ? rows.filter((row) => String(row?.content || '').trim()) : [];
  if (!list.length) return '';
  const body = list.slice(0, 4).map((row, index) => {
    const title = String(row.document_title || row.filename || `资料${index + 1}`).trim();
    const content = String(row.content || '').trim().slice(0, 700);
    return `【资料${index + 1}《${title}》】\n${content}`;
  }).join('\n\n');
  return [
    '【知识库参考（可选）】',
    '用途：只借写作规则、设定细节、角色声线、分镜/提示词写法。',
    '严禁：照搬资料里的具体情节串、人名、对白、独特场景专名；禁止让不同项目写成同一种故事表皮。',
    '若与当前大纲冲突，以当前大纲与用户指令为准。',
    body,
  ].join('\n');
}

export function normalizeScriptChatResult(parsed, fallback = {}) {
  const src = parsed && typeof parsed === 'object' ? parsed : {};
  const script = String(src.script_content || src.content || src.script || '').trim();
  const apply = src.apply === false ? false : Boolean(script);
  return {
    reply: String(src.reply || (apply ? '已按你的要求改好本集。' : '已给出建议。')).trim(),
    apply,
    title: String(src.title || fallback.title || '').trim(),
    script_content: script || String(fallback.script_content || '').trim(),
  };
}

/** 剧本快速规则扫描（不调模型） */
export const SCRIPT_QUALITY_PHRASE_CHECKS = [
  { re: /——|—{1,2}|--/g, code: 'dash', severity: 'error', label: '破折号' },
  { re: /(他|她|他们|众人)(感到|意识到|心想|明白|察觉|觉得|认为)/g, code: 'inner', severity: 'warn', label: '心理描写' },
  { re: /(氛围感|电影感|高级感|震撼|绝美|充满张力|极具张力)/g, code: 'slop', severity: 'warn', label: '空洞评价词' },
  { re: /(毫无疑问|因此|我认为|这意味着|从某种角度|不得不说)/g, code: 'written', severity: 'warn', label: '书面腔对白' },
  { re: /(聊了很久|经过一番|不知不觉|时间过去|许久之后)/g, code: 'summary', severity: 'warn', label: '不可拍时间摘要' },
  { re: /(发呆|沉思|五味杂陈|空气凝固|气氛凝重|陷入回忆|望向远方)/g, code: 'mood_end', severity: 'error', label: '弱结尾情绪词' },
];

export function scanScriptQualityHeuristics(scriptContent = '', { hook = '' } = {}) {
  const content = String(scriptContent || '').trim();
  const issues = [];
  const len = content.length;
  if (!content) {
    return { score: 0, grade: '未写', issues: [{ severity: 'error', code: 'empty', message: '本集正文为空' }], word_count: 0, dialogue_ratio: 0 };
  }
  if (len < 1000) {
    issues.push({ severity: 'error', code: 'short', message: `字数偏短（${len} 字），竖屏单集建议 1200～2200` });
  } else if (len < 1200) {
    issues.push({ severity: 'warn', code: 'short', message: `字数略短（${len} 字），可再补一场冲突或对白` });
  }
  if (len > 2800) {
    issues.push({ severity: 'warn', code: 'long', message: `字数偏长（${len} 字），建议压缩中段重复` });
  }

  const dialogueMatches = content.match(/[「『""][^」』""\n]+[」』""]/g) || [];
  const dialogueChars = dialogueMatches.reduce((sum, line) => sum + line.length, 0);
  const dialogueRatio = len ? dialogueChars / len : 0;
  if (dialogueRatio < 0.12 && len > 700) {
    issues.push({ severity: 'warn', code: 'low_dialogue', message: '对白占比偏低，建议增加可听口语对白' });
  }

  const sceneHeaders = (content.match(/【场景】/g) || []).length;
  if (sceneHeaders === 0 && len > 900) {
    issues.push({ severity: 'warn', code: 'no_scene_header', message: '未见【场景】头，换场时建议标明地点·时间' });
  }

  const tail = content.slice(-350);
  if (/发呆|沉思|五味杂陈|空气凝固|气氛凝重|陷入回忆|望向远方|沉默良久/.test(tail)) {
    issues.push({ severity: 'error', code: 'weak_hook', message: '结尾疑似情绪钩/回忆收束，应换成可见事件钩' });
  }

  const hookText = String(hook || '').trim();
  if (hookText && len > 600 && !/(门|电话|短信|信封|刀|枪|警|抓|跑|喊|摔|亮|掏|倒计时|爆炸|闯入)/.test(tail)) {
    issues.push({ severity: 'warn', code: 'hook_mismatch', message: '结尾画面感偏弱，建议对照本集钩子补一个落地事件' });
  }

  for (const check of SCRIPT_QUALITY_PHRASE_CHECKS) {
    const hits = content.match(check.re);
    if (hits?.length) {
      issues.push({
        severity: check.severity,
        code: check.code,
        message: `含「${check.label}」类表述（约 ${hits.length} 处）`,
      });
    }
  }

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warnCount = issues.filter((i) => i.severity === 'warn').length;
  const score = Math.max(0, Math.min(100, 92 - errorCount * 14 - warnCount * 5));
  const grade = score >= 85 ? '优秀' : score >= 70 ? '可用' : score >= 55 ? '需改' : '较差';
  return {
    score,
    grade,
    issues,
    word_count: len,
    dialogue_ratio: Math.round(dialogueRatio * 100),
    scene_headers: sceneHeaders,
  };
}

export function scriptReviewSystemPrompt() {
  return `你是微短剧剧本质检编辑（对齐竖屏完播 + 可拍性 + 反 AI 腔）。
任务：审读本集正文，给出结构化质检报告，不改正文。

评分维度（每项 0～20，合计 score 0～100）：
1. 钩子与节奏：开篇是否冲突/违和；中段是否升级；结尾是否事件钩
2. 可拍性：是否可见动作/物件/表情；是否心理旁白或空洞形容词过多
3. 对白质量：是否口语、有潜台词、遮住名字能辨人；是否书面腔/解释画面
4. 信息密度：是否推进压力/信息/关系/道具；是否原地互骂或同义重复
5. 竖屏血肉：是否有特写物件、身体反应、声音线索；是否适合拆分镜

硬规则：
1. 只返回 JSON，不要 markdown。禁止破折号。
2. issues 按严重度排序，最多 8 条；每条含 severity（error/warn/info）、message、fix_hint（一句可执行改法）。
3. priority_fixes 给 3 条最值得先改的点（短句）。
4. 若提供了「规则扫描结果」，与之交叉验证，不要重复空话。

格式：
{
  "score": 78,
  "grade": "可用",
  "summary": "一两句总评",
  "strengths": ["亮点1", "亮点2"],
  "issues": [
    { "severity": "warn", "code": "dialogue", "message": "问题描述", "fix_hint": "怎么改" }
  ],
  "priority_fixes": ["先改1", "先改2", "先改3"]
}`;
}

export function buildScriptReviewUserPrompt({
  project,
  episode,
  scriptContent,
  hook = '',
  heuristics = null,
  knowledgeContext = '',
}) {
  const body = String(scriptContent || '').trim();
  const heuristicText = heuristics?.issues?.length
    ? `【规则扫描】得分 ${heuristics.score}（${heuristics.grade}）\n${heuristics.issues.map((i) => `- [${i.severity}] ${i.message}`).join('\n')}`
    : '';
  return [
    '【项目】',
    `剧名：${project?.title || ''}`,
    `类型：${project?.genre || ''}`,
    `一句话：${project?.logline || ''}`,
    '【本集】',
    `第 ${episode?.episode_no || '?'} 集 · ${episode?.title || ''}`,
    hook ? `本集结尾钩子（应兑现或升级）：${hook}` : '',
    heuristicText,
    knowledgeContext ? String(knowledgeContext).trim() : '',
    '【正文】',
    body || '（空）',
    '请输出质检 JSON。',
  ].filter(Boolean).join('\n');
}

export function normalizeScriptReview(parsed, heuristics = null) {
  const src = parsed && typeof parsed === 'object' ? parsed : {};
  const aiIssues = Array.isArray(src.issues)
    ? src.issues.map((item, index) => ({
      severity: ['error', 'warn', 'info'].includes(item?.severity) ? item.severity : 'warn',
      code: String(item?.code || `ai_${index}`).trim(),
      message: String(item?.message || '').trim(),
      fix_hint: String(item?.fix_hint || item?.hint || '').trim(),
    })).filter((item) => item.message)
    : [];
  const heuristicIssues = (heuristics?.issues || []).map((item) => ({ ...item, fix_hint: item.fix_hint || '' }));
  const merged = [];
  const seen = new Set();
  for (const item of [...heuristicIssues, ...aiIssues]) {
    const key = `${item.code}:${item.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  const score = Number.isFinite(Number(src.score))
    ? Math.max(0, Math.min(100, Math.round(Number(src.score))))
    : (heuristics?.score ?? 70);
  const grade = String(src.grade || heuristics?.grade || (score >= 85 ? '优秀' : score >= 70 ? '可用' : score >= 55 ? '需改' : '较差')).trim();
  return {
    score,
    grade,
    summary: String(src.summary || '').trim(),
    strengths: Array.isArray(src.strengths) ? src.strengths.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 5) : [],
    issues: merged.slice(0, 12),
    priority_fixes: Array.isArray(src.priority_fixes)
      ? src.priority_fixes.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 5)
      : [],
    heuristics: heuristics || null,
  };
}

export function scriptPolishSystemPrompt() {
  return `你是资深微短剧/漫剧编剧，按质检报告「润色修订」当前这一集正文。

目标（按优先级）：
1. 修掉质检指出的 error/warn：反 AI 腔、可拍性、对白口语、结尾事件钩
2. 保持剧情走向、人物姓名、核心设定不变
3. 字数维持 1200～2200；禁止破折号「——」「—」「--」
4. 换场景时保留/补全【场景】地点 · 日/夜 · 内/外 与「人物：」行
5. 输出完整正文，不是片段补丁

硬规则：只返回 JSON，不要 markdown。

格式：
{
  "reply": "用一两句说明主要改了什么",
  "apply": true,
  "title": "本集标题（可微调）",
  "script_content": "完整润色后的正文",
  "changes": ["改动点1", "改动点2"]
}`;
}

export function buildScriptPolishUserPrompt({
  project,
  episode,
  scriptContent,
  review = {},
  knowledgeContext = '',
}) {
  const body = String(scriptContent || '').trim();
  const issueText = (review.issues || [])
    .slice(0, 10)
    .map((item) => `- [${item.severity}] ${item.message}${item.fix_hint ? ` → ${item.fix_hint}` : ''}`)
    .join('\n');
  const fixes = (review.priority_fixes || []).map((s) => `- ${s}`).join('\n');
  return [
    '【项目】',
    `剧名：${project?.title || ''}`,
    `类型：${project?.genre || ''}`,
    `大纲摘要：${String(project?.outline || project?.synopsis || '').slice(0, 1000)}`,
    '【本集】',
    `第 ${episode?.episode_no || '?'} 集 · ${episode?.title || ''}`,
    review.summary ? `质检总评：${review.summary}` : '',
    review.score != null ? `当前得分：${review.score}（${review.grade || ''}）` : '',
    fixes ? `优先修改：\n${fixes}` : '',
    issueText ? `问题清单：\n${issueText}` : '',
    knowledgeContext ? String(knowledgeContext).trim() : '',
    '【当前正文】',
    body || '（空）',
    '请润色并返回完整 JSON。',
  ].filter(Boolean).join('\n');
}

export function normalizeScriptPolishResult(parsed, fallback = {}) {
  const base = normalizeScriptChatResult(parsed, fallback);
  const changes = Array.isArray(parsed?.changes)
    ? parsed.changes.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 8)
    : [];
  return { ...base, changes };
}

/** LocalMiniDrama 对齐：按集拆分镜 + Seedance/即梦可用 prompt */
export function storyboardSplitSystemPrompt() {
  return `你是竖屏微短剧/漫剧分镜导演（对齐 LocalMiniDrama 分镜台 + Seedance 2.0 写法）。
任务：把「本集剧本」拆成可拍分镜，每镜适合 3～8 秒视频生成。

硬规则：
1. 只返回 JSON，不要 markdown。禁止破折号。
2. 每镜只一个核心动作（One-Move）；镜头运动与人物动作分开写。
3. visual_prompt：可见画面（主体动作、场景、光影），情绪必须物理化（「心痛」→「指甲掐进掌心」）。
4. camera_note：只写一个主运镜（固定/缓推/拉远/跟拍/横摇/环绕/手持/升降）。
5. seedance_prompt：可直接粘贴到即梦/Seedance 的完整中文 prompt，结构为：
   主体动作 + 场景光影 + 景别 + 单一运镜 + 竖屏9:16 + 电影质感4K + 面部清晰不变形
   含角色时可用「@图片1 作为角色参考」占位（不写真实文件名）。
6. dialogue 只写该镜对白，可空；characters 用角色名逗号分隔，必须来自给定角色卡。
7. shot_size：远景/全景/中景/近景/特写。竖屏以近景+特写为主。
8. 通常 6～14 镜，覆盖开场钩→升级→尾钩；末镜必须是可见事件钩画面。
9. 若提供了「知识库参考」：只借分镜/运镜/提示词规则，禁止照搬资料里的具体剧情。

格式：
{
  "shots": [
    {
      "shot_no": 1,
      "shot_size": "近景",
      "visual_prompt": "可见画面描述",
      "dialogue": "",
      "characters": "角色A",
      "duration_sec": 4,
      "camera_note": "缓推",
      "seedance_prompt": "完整视频提示词"
    }
  ]
}`;
}

export function buildStoryboardSplitUserPrompt({
  project,
  episode,
  characters = [],
  scenes = [],
  props = [],
  knowledgeContext = '',
}) {
  const synopsis = String(episode?.script_content || episode?.synopsis || '').trim();
  const charText = (characters || []).map((c) => (
    `- ${c.name}${c.role ? `（${c.role}）` : ''}：外貌 ${c.appearance || '未填'}；性格 ${c.personality || '未填'}；定妆词 ${c.ref_prompt || '无'}`
  )).join('\n') || '（暂无角色卡）';
  const sceneText = (scenes || []).slice(0, 12).map((s) => (
    `- ${s.location || ''}·${s.time_label || s.time || '日'}：${String(s.prompt || '').slice(0, 120)}`
  )).join('\n') || '（暂无场景库）';
  const propText = (props || []).slice(0, 12).map((p) => (
    `- ${p.name}：${String(p.description || p.prompt || '').slice(0, 80)}`
  )).join('\n') || '（暂无道具库）';
  return [
    `项目：${project?.title || ''}`,
    `类型：${project?.genre || ''}`,
    `画风：${project?.style_guide || ''}`,
    `一句话：${project?.logline || ''}`,
    `分集：第 ${episode?.episode_no || 1} 集 ${episode?.title || ''}`,
    `本集剧本：\n${synopsis || '（空）'}`,
    `角色卡：\n${charText}`,
    `场景库：\n${sceneText}`,
    `道具库：\n${propText}`,
    knowledgeContext ? String(knowledgeContext).trim() : '',
    '请输出本集 shots JSON。',
  ].filter(Boolean).join('\n');
}

export function normalizeStoryboardShots(parsed) {
  const list = Array.isArray(parsed?.shots) ? parsed.shots
    : (Array.isArray(parsed) ? parsed : []);
  return list.map((shot, index) => {
    const visual = String(shot.visual_prompt || shot.prompt || '').trim();
    const camera = String(shot.camera_note || shot.camera || '固定').trim() || '固定';
    const size = String(shot.shot_size || '中景').trim() || '中景';
    const seedance = String(shot.seedance_prompt || shot.doubao_prompt || '').trim()
      || [
        visual,
        size ? `景别${size}` : '',
        camera ? `运镜${camera}` : '',
        '竖屏9:16，电影质感，4K，画面稳定，面部清晰不变形',
      ].filter(Boolean).join('，');
    return {
      shot_no: Number(shot.shot_no) || index + 1,
      shot_size: size,
      visual_prompt: visual,
      dialogue: String(shot.dialogue || '').trim(),
      characters: String(shot.characters || '').trim(),
      duration_sec: Math.min(12, Math.max(2, Number(shot.duration_sec) || 4)),
      camera_note: camera,
      seedance_prompt: seedance,
    };
  }).filter((s) => s.visual_prompt || s.seedance_prompt);
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

/** Split episodes into batches so long scripts do not blow nginx / LLM timeouts. */
export function chunkEpisodesForExtract(episodes = [], batchSize = 4) {
  const sorted = [...(episodes || [])].sort((a, b) => Number(a.episode_no) - Number(b.episode_no));
  const size = Math.max(1, Number(batchSize) || 4);
  const batches = [];
  for (let i = 0; i < sorted.length; i += size) batches.push(sorted.slice(i, i + size));
  return batches.length ? batches : [[]];
}

export function mergeNormalizedCharacters(lists = []) {
  const roleRank = { main: 3, supporting: 2, minor: 1 };
  const byName = new Map();
  for (const list of lists) {
    for (const item of list || []) {
      const key = String(item.name || '').trim();
      if (!key) continue;
      const prev = byName.get(key);
      if (!prev) {
        byName.set(key, item);
        continue;
      }
      const betterRole = (roleRank[item.role] || 0) > (roleRank[prev.role] || 0);
      const longerLook = String(item.appearance || '').length > String(prev.appearance || '').length;
      const longerDesc = String(item.description || '').length > String(prev.description || '').length;
      byName.set(key, {
        ...prev,
        ...item,
        role: betterRole ? item.role : prev.role,
        appearance: longerLook ? item.appearance : prev.appearance,
        personality: String(item.personality || '').length > String(prev.personality || '').length
          ? item.personality
          : prev.personality,
        voice_note: item.voice_note || prev.voice_note,
        ref_prompt: longerLook ? (item.ref_prompt || item.appearance) : (prev.ref_prompt || prev.appearance),
        description: longerDesc ? item.description : prev.description,
      });
    }
  }
  return [...byName.values()];
}

export function mergeNormalizedScenes(lists = []) {
  return normalizeScenes((lists || []).flat());
}

export function mergeNormalizedProps(lists = []) {
  const byName = new Map();
  for (const list of lists) {
    for (const item of list || []) {
      const key = String(item.name || '').trim();
      if (!key) continue;
      const prev = byName.get(key);
      if (!prev || String(item.description || '').length > String(prev.description || '').length) {
        byName.set(key, item);
      }
    }
  }
  return [...byName.values()];
}

export function buildLmdProjectJson({
  project,
  characters = [],
  scenes = [],
  props = [],
  episodes = [],
  shots = [],
}) {
  let hooks = project?.episode_hooks;
  if (typeof hooks === 'string') {
    try { hooks = JSON.parse(hooks); } catch (_) { hooks = []; }
  }
  if (!Array.isArray(hooks)) hooks = [];

  const shotsByEpisode = new Map();
  for (const shot of (Array.isArray(shots) ? shots : [])) {
    const epId = Number(shot.episode_id);
    if (!Number.isFinite(epId)) continue;
    if (!shotsByEpisode.has(epId)) shotsByEpisode.set(epId, []);
    shotsByEpisode.get(epId).push(shot);
  }

  const charIndexMap = buildCharacterIndexMap(characters);

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
    characters: characters.map((c) => mapLmdCharacter(c)),
    scenes: scenes.map((s, index) => mapLmdScene(s, episodes, index)),
    props: props.map((p, index) => mapLmdProp(p, episodes, index)),
    episodes: episodes
      .slice()
      .sort((a, b) => Number(a.episode_no) - Number(b.episode_no))
      .map((ep) => {
        const epShots = (shotsByEpisode.get(Number(ep.id)) || [])
          .slice()
          .sort((a, b) => Number(a.shot_no) - Number(b.shot_no) || Number(a.id) - Number(b.id));
        return {
          episode_number: Number(ep.episode_no) || 1,
          title: ep.title || `第${ep.episode_no}集`,
          description: ep.synopsis || null,
          script_content: ep.script_content || ep.synopsis || null,
          duration: epShots.reduce((sum, s) => sum + (Number(s.duration_sec) || 4), 0),
          storyboards: epShots.map((s) => mapLmdStoryboard(s, characters, charIndexMap)),
        };
      }),
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

/** 角色名 → characters 数组下标（LocalMiniDrama 用 character_indices 还原绑定） */
export function buildCharacterIndexMap(characters = []) {
  const map = new Map();
  (characters || []).forEach((c, index) => {
    const name = String(c?.name || '').trim();
    if (name) map.set(name, index);
  });
  return map;
}

export function resolveCharacterIndices(charactersText = '', charIndexMap = new Map(), characters = []) {
  const names = String(charactersText || '')
    .split(/[,，、/|]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const indices = [];
  for (const name of names) {
    if (charIndexMap.has(name)) {
      const idx = charIndexMap.get(name);
      if (!indices.includes(idx)) indices.push(idx);
      continue;
    }
    const fuzzy = (characters || []).findIndex((c) => {
      const n = String(c?.name || '').trim();
      return n && (n === name || n.includes(name) || name.includes(n));
    });
    if (fuzzy >= 0 && !indices.includes(fuzzy)) indices.push(fuzzy);
  }
  return indices;
}

/** 校验 project.json 是否满足 LocalMiniDrama 导入最低要求 */
export function validateLmdProjectJson(data = {}) {
  const issues = [];
  const warnings = [];
  if (!data?.drama?.title) issues.push('缺少 drama.title（导入会失败）');
  if (!Array.isArray(data.episodes)) issues.push('episodes 必须是数组');
  if (!Array.isArray(data.characters)) warnings.push('characters 建议为数组');
  if (!Array.isArray(data.scenes)) warnings.push('scenes 建议为数组');

  const meta = data?.drama?.metadata;
  if (meta != null && typeof meta !== 'object' && typeof meta !== 'string') {
    issues.push('drama.metadata 必须是对象或 JSON 字符串');
  }

  for (const [i, ep] of (data.episodes || []).entries()) {
    if (ep.episode_number == null) issues.push(`episodes[${i}] 缺少 episode_number`);
    if (!String(ep.script_content || '').trim() && !String(ep.description || '').trim()) {
      warnings.push(`第 ${ep.episode_number || i + 1} 集无 script_content`);
    }
    for (const [j, sb] of (ep.storyboards || []).entries()) {
      if (sb.storyboard_number == null) {
        issues.push(`episodes[${i}].storyboards[${j}] 缺少 storyboard_number`);
      }
      if (!String(sb.image_prompt || '').trim() && !String(sb.video_prompt || '').trim()) {
        warnings.push(`第 ${ep.episode_number} 集镜 ${sb.storyboard_number} 无 image/video prompt`);
      }
      if (String(sb.characters || '').trim() && !(sb.character_indices || []).length) {
        warnings.push(`第 ${ep.episode_number} 集镜 ${sb.storyboard_number} 有角色名但未映射 character_indices`);
      }
      if (sb.creation_mode === 'universal' && !String(sb.universal_segment_text || '').trim()) {
        warnings.push(`第 ${ep.episode_number} 集镜 ${sb.storyboard_number} universal 模式缺 universal_segment_text`);
      }
    }
  }

  for (const [i, c] of (data.characters || []).entries()) {
    if (!String(c.name || '').trim()) issues.push(`characters[${i}] 缺少 name`);
    if (!String(c.polished_prompt || c.appearance || '').trim()) {
      warnings.push(`角色「${c.name || i}」无 polished_prompt/appearance（LMD 出图需补）`);
    }
  }

  if (String(data.version || '') !== LMD_EXPORT_VERSION) {
    warnings.push(`version=${data.version || '无'}，LMD 官方导出为 ${LMD_EXPORT_VERSION}（导入不校验，可忽略）`);
  }

  return { ok: !issues.length, issues, warnings };
}

function lmdMediaFile(path) {
  return path ? path : null;
}

function episodeIndexFromEpisodes(episodes = [], episodeIndex = 0, episodeId = null) {
  if (episodeId != null) {
    const idx = episodes.findIndex((ep) => Number(ep.id) === Number(episodeId));
    if (idx >= 0) return idx;
  }
  const n = Number(episodeIndex);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function mapLmdCharacter(c = {}) {
  const polished = characterImagePrompt(c);
  return {
    name: c.name,
    role: c.role || c.mbti || 'supporting',
    description: c.description || null,
    personality: c.personality || null,
    appearance: c.appearance || null,
    voice_style: c.voice_note || null,
    polished_prompt: polished || null,
    image_file: lmdMediaFile(c.image_file),
    extra_image_files: Array.isArray(c.extra_image_files) ? c.extra_image_files : [],
  };
}

function mapLmdScene(s = {}, episodes = [], index = 0) {
  return {
    location: s.location || '',
    time: s.time || s.time_label || '日',
    prompt: s.prompt || '',
    polished_prompt: s.prompt || null,
    episode_index: episodeIndexFromEpisodes(episodes, s.episode_index, s.episode_id),
    image_file: lmdMediaFile(s.image_file),
    extra_image_files: Array.isArray(s.extra_image_files) ? s.extra_image_files : [],
  };
}

function mapLmdProp(p = {}, episodes = [], index = 0) {
  return {
    name: p.name,
    type: p.type || '关键道具',
    description: p.description || null,
    prompt: p.prompt || '',
    episode_index: episodeIndexFromEpisodes(episodes, p.episode_index, p.episode_id),
    image_file: lmdMediaFile(p.image_file),
    extra_image_files: Array.isArray(p.extra_image_files) ? p.extra_image_files : [],
  };
}

function mapLmdStoryboard(s = {}, characters = [], charIndexMap = new Map()) {
  const videoPrompt = String(s.doubao_prompt || s.seedance_prompt || '').trim();
  const imagePrompt = String(s.visual_prompt || '').trim();
  const charIndices = resolveCharacterIndices(s.characters, charIndexMap, characters);
  const hasVideo = Boolean(videoPrompt);
  return {
    storyboard_number: Number(s.shot_no) || 1,
    title: `镜${s.shot_no || 1}`,
    description: imagePrompt || null,
    location: s.location || null,
    time: s.time || null,
    dialogue: s.dialogue || null,
    narration: null,
    action: imagePrompt || null,
    atmosphere: null,
    result: null,
    shot_type: s.shot_size || '中景',
    angle: null,
    angle_h: null,
    angle_v: null,
    angle_s: null,
    movement: s.camera_note || '固定',
    lighting_style: null,
    depth_of_field: null,
    image_prompt: imagePrompt || null,
    polished_prompt: videoPrompt || null,
    video_prompt: videoPrompt || null,
    duration: Number(s.duration_sec) || 4,
    emotion: null,
    emotion_intensity: null,
    segment_index: 0,
    segment_title: null,
    continuity_snapshot: null,
    creation_mode: hasVideo ? 'universal' : 'classic',
    universal_segment_text: videoPrompt || null,
    layout_description: null,
    first_frame_image_original_id: null,
    last_frame_image_original_id: null,
    last_frame_image_url: null,
    last_frame_local_path: null,
    character_indices: charIndices,
    scene_index: s.scene_index != null ? s.scene_index : null,
    prop_indices: Array.isArray(s.prop_indices) ? s.prop_indices : [],
    image_file: null,
    video_file: null,
    audio_file: null,
    narration_audio_file: null,
    image_generations: [],
    frame_prompts: [],
  };
}

function characterImagePrompt(c = {}) {
  return String(c.ref_prompt || c.appearance || c.description || '').trim();
}

/** 全集剧本 Markdown（人工阅读/归档） */
export function buildDramaScriptMarkdown({ project, episodes = [] } = {}) {
  const title = project?.title || '未命名漫剧';
  const lines = [
    `# ${title} · 剧本全集`,
    '',
    project?.logline ? `> ${project.logline}` : '',
    project?.outline || project?.synopsis ? `\n## 大纲\n\n${project.outline || project.synopsis}` : '',
    '',
  ].filter((line) => line !== undefined);
  for (const ep of [...episodes].sort((a, b) => Number(a.episode_no) - Number(b.episode_no))) {
    const body = String(ep.script_content || ep.synopsis || '').trim();
    if (!body) continue;
    lines.push(`## 第 ${ep.episode_no} 集 ${ep.title || ''}`.trim(), '', body, '');
  }
  return lines.join('\n');
}

/** 人物/场景/道具生图提示词 */
export function buildDramaImagePromptsMarkdown({ project, characters = [], scenes = [], props = [] } = {}) {
  const title = project?.title || '未命名漫剧';
  const style = project?.style_guide ? `画风：${project.style_guide}` : '';
  const lines = [
    `# ${title} · 生图提示词`,
    '',
    style,
    '',
    '## 人物定妆（导入 LocalMiniDrama 后用于「角色出图」）',
    '',
  ];
  if (characters.length) {
    for (const c of characters) {
      const prompt = characterImagePrompt(c);
      lines.push(
        `### ${c.name}${c.role ? `（${c.role}）` : ''}`,
        prompt || '（暂无定妆词，请补 appearance / ref_prompt）',
        '',
      );
    }
  } else {
    lines.push('（暂无，请先在「识别数据」抽出人物）', '');
  }
  lines.push('## 场景背景图', '');
  if (scenes.length) {
    for (const s of scenes) {
      lines.push(
        `### ${s.location || '未命名'} · ${s.time || s.time_label || '日'}`,
        String(s.prompt || '').trim() || '（暂无场景 prompt）',
        '',
      );
    }
  } else {
    lines.push('（暂无）', '');
  }
  lines.push('## 道具参考图', '');
  if (props.length) {
    for (const p of props) {
      lines.push(
        `### ${p.name}`,
        String(p.prompt || p.description || '').trim() || '（暂无）',
        '',
      );
    }
  } else {
    lines.push('（暂无）', '');
  }
  return lines.join('\n');
}

/** 全项目分镜视频提示词汇总 */
export function buildDramaStoryboardPromptsMarkdown({
  project,
  episodes = [],
  shots = [],
  characters = [],
} = {}) {
  const title = project?.title || '未命名漫剧';
  const shotsByEp = new Map();
  for (const shot of shots || []) {
    const epId = Number(shot.episode_id);
    if (!shotsByEp.has(epId)) shotsByEp.set(epId, []);
    shotsByEp.get(epId).push(shot);
  }
  const lines = [
    `# ${title} · 分镜视频提示词（Seedance / 即梦）`,
    '',
    '> 导入 LocalMiniDrama 后，各镜的 video_prompt / universal_segment_text 已写入 project.json',
    '',
  ];
  for (const ep of [...episodes].sort((a, b) => Number(a.episode_no) - Number(b.episode_no))) {
    const epShots = (shotsByEp.get(Number(ep.id)) || [])
      .sort((a, b) => Number(a.shot_no) - Number(b.shot_no));
    if (!epShots.length) continue;
    lines.push(`## 第 ${ep.episode_no} 集 ${ep.title || ''}`.trim(), '');
    for (const s of epShots) {
      const videoPrompt = String(s.doubao_prompt || s.seedance_prompt || '').trim()
        || [s.visual_prompt, s.shot_size, s.camera_note].filter(Boolean).join('，');
      lines.push(
        `### 镜 ${s.shot_no} · ${s.shot_size || '中景'} · ${s.duration_sec || 4}s`,
        s.characters ? `角色：${s.characters}` : '',
        s.dialogue ? `对白：${s.dialogue}` : '',
        `画面：${s.visual_prompt || ''}`,
        '',
        '```',
        videoPrompt,
        '```',
        '',
      );
    }
  }
  if (lines.length <= 4) lines.push('（暂无分镜，请先在「分镜提示词」步骤生成）', '');
  return lines.filter((line) => line !== undefined).join('\n');
}

export function buildLmdExportReadme({ project, episodes = [], characters = [], scenes = [], shots = [] } = {}) {
  const epCount = (episodes || []).filter((e) => String(e.script_content || '').trim().length > 20).length;
  const shotCount = (shots || []).length;
  return [
    'AI Key Hub → LocalMiniDrama 导入包',
    '================================',
    '',
    `项目：${project?.title || '未命名'}`,
    `剧本：${epCount} 集`,
    `人物：${(characters || []).length} · 场景：${(scenes || []).length} · 分镜：${shotCount} 镜`,
    '',
    '【导入步骤】',
    '1. 打开 LocalMiniDrama → 项目 → 导入 ZIP',
    '2. 选择本压缩包（含 project.json）',
    '3. 导入后检查：剧本、角色卡、场景、分镜台',
    '',
    '【文件说明】',
    '- project.json：LMD 标准工程（剧本 + 角色/场景/道具 + 分镜提示词）',
    '- 剧本全集.md：人工阅读用',
    '- 生图提示词.md：人物/场景/道具定妆与背景图 prompt',
    '- 分镜视频提示词.md：各镜 Seedance/即梦视频 prompt',
    '',
    '【在 LMD 里继续】',
    '- 角色/场景/道具：按 polished_prompt / prompt 批量出图',
    '- 分镜：classic 或 universal（全能）模式按镜出视频',
    '- 成片：LMD 内合成或导出片段后精剪',
    '',
  ].join('\n');
}
