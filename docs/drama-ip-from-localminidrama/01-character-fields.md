# 角色卡字段对照

来源：LocalMiniDrama `characters` 表 + 前端角色编辑；Hub：`drama_characters`。

## 总表

| LocalMiniDrama | 中文含义 | Hub 现状 | 接到 Hub？ | 说明 |
|----------------|----------|----------|------------|------|
| `name` | 角色名 | ✅ `name` | 已有 | 主键语义 |
| `role` | 主角/配角/次要 | ❌ | **要接** | `main` / `supporting` / `minor` |
| `description` | 简介/关系背景 | ❌ | **要接** | 写分镜叙事用 |
| `personality` | 性格 | ✅ `personality` | 已有 | LMD 有字段但拆镜几乎不用；Hub 应强制注入 |
| — | MBTI | ✅ `mbti` | **保留加强** | LMD 没有；你的 IP 核心 |
| `appearance` | 外貌描述 | ✅ `appearance` | 已有 | 视觉 IP 主字段 |
| `voice_style` | 音色/说话方式 | ≈ `voice_note` | 已有（改名对齐） | Hub 可继续叫 `voice_note` |
| `identity_anchors` | 视觉锚点 JSON | ❌ | **要接** | 脸型/五官/标志/发色服装色等 |
| `polished_prompt` | 定妆/图生提示词 | ≈ `ref_prompt` | 已有 | 对齐为定妆提示 |
| `image_url` / `ref_image` / `four_view_image_url` | 定妆图 | ❌ | 后期 | 先文本，图上传第二期 |
| `stages` | 多阶段造型 | ❌ | 可选 | 按集换装时再接 |
| `negative_prompt` | 负面提示 | ❌ | 可选 | 出图时才有用 |
| `style_tokens` / `color_palette` | 风格/色板 | ❌ | 暂缓 | 可由锚点推导 |
| `seedance2_asset` | 豆包资产认证 | ❌ | 暂缓 | 出片期再接 |

## LocalMiniDrama `identity_anchors` 结构（建议原样接到 Hub）

```json
{
  "face_shape": "鹅蛋脸",
  "facial_features": "杏眼、高鼻梁",
  "unique_marks": "左耳小痣",
  "color_anchors": {
    "hair": "#2b1d14",
    "eyes": "#3a2a1a",
    "skin": "#f3d5c0",
    "primary_outfit": "#e8b4b8"
  },
  "skin_texture": "细腻",
  "hair_style": "齐肩微卷"
}
```

## Hub 角色卡 · 推荐 v2 字段（人物 IP 长期记住）

```text
# 身份
name                 角色名*
role                 main|supporting|minor
mbti                 如 ENFP                 ← Hub 独有优势，保留

# 叙事 IP（写分镜必注入）
description          背景/关系/动机
personality          性格/决策习惯
voice_note           说话方式/口头禅/禁忌
catchphrases         口头禅列表（可选，TEXT/JSON）
relationships        与其他角色关系（可选）

# 视觉 IP（导出豆包/定妆）
appearance           外貌长描述
identity_anchors     JSON 六层锚点
ref_prompt           定妆/一致性提示词

# 组织
project_id           所属项目（现有）
library_id           全局人物库 ID（新增，可跨项目复用）
sort_order
```

## 拆分镜时必须喂给模型的角色片段

LocalMiniDrama 当前拆镜只喂 `{id, name}` —— 这是它的短板。  
Hub 应对齐成：

```text
- 林晓（ENFP / 主角）
  性格：热情外向，冲突时先共情再说观点；口头禅「等等让我想想」
  背景：合租室友，喜欢临时起意
  外貌：短发、米色针织衫、左耳小痣
  定妆提示：...
```

## 优先级

1. **P0**：`role` + `description` + 拆镜注入完整卡（含 mbti/personality/appearance）
2. **P1**：全局人物库（跨项目复用同一 IP）
3. **P2**：`identity_anchors` JSON
4. **P3**：定妆图上传 / stages / Seedance 资产
