# Drama / Seedance Skills

项目级 Cursor Skills：在 **Cursor 对话**里用；不会被 Hub 网页自动调用。

## 装了什么

| Skill | 用途 | 何时用 |
|-------|------|--------|
| `short-drama` | 爆款剧本工坊：选题 → 角色 → 分集 → 分镜 | 写剧本、角色卡；`/角色开发` `/角色卡` `/分镜` |
| `short-drama-remake` | 已有成片/剧本翻拍改编 | 翻拍、改设定、出海重做 |
| `create-storyboard` | 导演级分镜生产包 | 要从剧本拆成可拍连镜包时 |
| `seedance-director` | 即梦导演（中文友好） | 定妆思路、运镜、按镜出即梦提示词 |
| `seedance-2.0` | Seedance 2.0 完整工包 | 润色/修片/续拍；子技能在 `seedance-2.0/skills/` |

未安装：`libtv-skills`、精简版 `short-drama`。

## 推荐流程（Hub + Skills + Local）

```text
① Cursor + short-drama → 角色卡 / 故事骨架
② 粘贴进 Hub「导入角色」或手填人物库（支持 ### 标题与性格关键词等别名）
③ Hub「AI 拆分镜」：只用 Key 管理里配置的模型
   或 Cursor 出分镜 JSON → Hub「导入分镜」（仅 {"shots":[]}；会顺序重排镜号）
④ Hub 手改 / 导出 MD+CSV
⑤ LocalMiniDrama：全局素材库入库 → 出图 → 分镜图 → 视频
⑥ 点「复制 Cursor 润色提示」+ seedance-director / seedance-2.0（可选）
⑦ 站外 Seedance / Local 出片 → OpenCut 精剪
```

## 导入契约（避免空导入）

**角色**：JSON `{"characters":[…]}` 或 Markdown 块。可识别字段：
`背景/简介/核心动机`、`性格/性格关键词`、`外貌/外貌特征`、`定妆/视觉提示词`、`说话`、`口头禅`、`stages`（多阶段造型）。

**分镜**：JSON `{"shots":[…]}`、create-storyboard 精简包（含 `shots` / `clip_plan.shots`）、或 Hub 导出 MD（`### 镜 N`）。
导入会顺序重排镜号。整包目录 MD 需先抽出 shots JSON。

**Hub → Local**：Hub 导出 MD/CSV 后，在 LocalMiniDrama 首页点「导入 Hub」。

## 边界

- Hub：**记人物、写分镜、导出提示词**；不出视频。
- LocalMiniDrama：渲染层（图/视频/本机库）；支持 Hub 导入、采用后再出片、连贯帧、剪辑包（shot_list + SRT）。
- Skills：创作与站外提示词润色；产物靠导入/粘贴进 Hub 或 Local。

## 源仓库（`.tmp-skills/` 仅本地缓存）

- [MarkQWu/drama-workshop-skills](https://github.com/MarkQWu/drama-workshop-skills)
- [crowscc/seedance-director](https://github.com/crowscc/seedance-director)
- [emily2040/seedance-2.0](https://github.com/emily2040/seedance-2.0)
- [TateZhouSiu/create-storyboard-skill](https://github.com/TateZhouSiu/create-storyboard-skill)
