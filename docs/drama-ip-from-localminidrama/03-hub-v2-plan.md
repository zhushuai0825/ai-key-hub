# Hub 漫剧 v2 · 接字段落地计划

对照 LocalMiniDrama 后的落地顺序：**先记住人物 IP，再写好分镜**。不出视频 API。

## 产品原则

1. 人物可跨项目复用（全局 IP 库）
2. 拆分镜必须吃完整角色卡（别只喂名字）
3. 分镜字段对齐「能拍」：动作 / 结果 / 对白 / 氛围
4. 豆包提示词由角色卡 + 分镜自动拼，可手改

## Schema 草案

### A. 全局人物库（新增）

```sql
CREATE TABLE IF NOT EXISTS drama_character_library (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'main',          -- main|supporting|minor
  mbti TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',       -- 背景关系
  personality TEXT NOT NULL DEFAULT '',
  voice_note TEXT NOT NULL DEFAULT '',
  catchphrases TEXT NOT NULL DEFAULT '',
  appearance TEXT NOT NULL DEFAULT '',
  identity_anchors JSONB NOT NULL DEFAULT '{}'::jsonb,
  ref_prompt TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',             -- 如 MBTI,合租,恋爱
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### B. 项目角色（扩展现有 `drama_characters`）

在现有表上增加：

```sql
ALTER TABLE drama_characters
  ADD COLUMN IF NOT EXISTS library_id INTEGER REFERENCES drama_character_library(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'main',
  ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS identity_anchors JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS catchphrases TEXT NOT NULL DEFAULT '';
-- personality / appearance / voice_note / mbti / ref_prompt 已有
```

### C. 分镜（扩展现有 `drama_shots`）

```sql
ALTER TABLE drama_shots
  ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS action TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS result TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS narration TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS atmosphere TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS emotion TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS movement TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS layout_description TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS character_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
```

## API 草案

| 方法 | 路径 | 作用 |
|------|------|------|
| GET/POST | `/api/drama/library` | 全局人物库 CRUD |
| POST | `/api/drama/projects/:id/characters/from-library` | 从库引入到项目 |
| POST | `/api/drama/episodes/:id/split` | 拆镜时注入完整角色卡 + 输出 action/result/… |
| PATCH | `/api/drama/shots/:id` | 保存时按 v2 字段重建 doubao_prompt |

## UI 草案（Hub `drama.html`）

1. **人物库** Tab（全局）→ 新建/编辑 IP → 「加入当前项目」
2. **角色卡** 表单加：定位、简介、视觉锚点（可先一个大 JSON/分段输入）
3. **分镜台** 每镜显示：动作 / 结果 / 对白 / 旁白 / 氛围 / 情绪
4. AI 拆镜结果直接填这些格，再手改

## 实施切片

| 切片 | 内容 | 预估 |
|------|------|------|
| S1 | 扩展 character + shot 字段 + 拆镜 prompt 注入完整卡 | 0.5–1 天 |
| S2 | 全局人物库 + 引入项目 | 0.5 天 |
| S3 | 分镜 UI 对齐新字段 + 导出 MD 更新 | 0.5 天 |
| S4 | identity_anchors 表单化（非纯 JSON） | 可选 |

## 和 LocalMiniDrama 的分工

| | LocalMiniDrama（本机） | Hub（线上） |
|--|------------------------|-------------|
| 定妆图 / 出图出视频 | 强 | 不做或后期 |
| 人物性格 / MBTI IP | 弱 | **主战场** |
| 跨设备长期记住 | SQLite 本机 | **Postgres 云端** |
| 导出豆包提示词 | 有 | 加强自动拼卡 |

## 下一步

确认后按 **S1 → S2 → S3** 改 Hub 代码并部署。  
本对照文档路径：`docs/drama-ip-from-localminidrama/`
