# 漫剧字段对照 · LocalMiniDrama → Hub

对照本机 [LocalMiniDrama](http://127.0.0.1:3013/) 的角色卡 / 分镜字段，筛出适合接到 **ai-key-hub 漫剧工作室** 长期记住的一版。

## 你的目标

```
人物 IP（性格/外貌/说话方式）长期记住 → 写分镜时自动带上 → 导出豆包提示词
```

## 本机入口

| 服务 | 地址 |
|------|------|
| LocalMiniDrama 前端 | http://127.0.0.1:3013/ |
| LocalMiniDrama 后端 | http://127.0.0.1:5679/ |
| Hub 漫剧工作室 | http://8.146.206.64/drama.html |

## 本目录文件

| 文件 | 内容 |
|------|------|
| [01-character-fields.md](./01-character-fields.md) | 角色卡字段对照 + Hub 该接哪些 |
| [02-shot-fields.md](./02-shot-fields.md) | 分镜字段对照 + Hub 该接哪些 |
| [03-hub-v2-plan.md](./03-hub-v2-plan.md) | Hub 下一版 schema / 产品建议 |

## 结论摘要

- LocalMiniDrama **强在视觉一致性**（外貌、视觉锚点、定妆图），**弱在性格注入分镜**（有 `personality` 字段，但拆分镜时几乎不用）。
- Hub 已有 MBTI / 性格 / 外貌 / 定妆提示，方向更贴「人物 IP」；缺的是：跨项目人物库、视觉锚点、动作/结果/旁白等分镜字段。
- **下一版 Hub 优先接**：角色侧 `role` / `description` / `identity_anchors` / 跨项目库；分镜侧 `action` / `result` / `narration` / `atmosphere` / `emotion`，拆镜时强制注入完整角色卡。
