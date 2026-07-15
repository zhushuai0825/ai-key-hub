# 分镜字段对照

来源：LocalMiniDrama `storyboards`；Hub：`drama_shots`。

## 总表

| LocalMiniDrama | 中文 | Hub 现状 | 接到 Hub？ | 说明 |
|----------------|------|----------|------------|------|
| `storyboard_number` | 镜号 | ✅ `shot_no` | 已有 | |
| `title` | 镜头标题 | ❌ | 可选 | 列表可读性 |
| `shot_type` | 景别 | ✅ `shot_size` | 已有 | 远景/全景/中景/近景/特写 |
| `movement` | 运镜 | ≈ `camera_note` | **拆开加强** | 固定/推/拉/摇/跟… |
| `angle` / `angle_h/v/s` | 机位 | ❌ | 可选 | 先并入 `camera_note` |
| `duration` | 时长秒 | ✅ `duration_sec` | 已有 | |
| `dialogue` | 对白 | ✅ `dialogue` | 已有 | |
| `narration` | 旁白 | ❌ | **要接** | 和对话分开 |
| `action` | 动作 | ❌ | **要接** | 写分镜最重要 |
| `result` | 画面结果 | ❌ | **要接** | 「这镜结束时画面变成啥」 |
| `atmosphere` | 氛围 | ❌ | **要接** | 暖/压抑/荒诞… |
| `emotion` | 情绪 | ❌ | **要接** | 角色情绪 |
| `emotion_intensity` | 情绪强度 | ❌ | 可选 | 3~-1 |
| `layout_description` | 空间布局 | ❌ | 可选 | 站位/景深连续性 |
| `location` / `time` | 地点时间 | ❌ | 可选 | 可先放 visual |
| `description` | 镜头描述 | ≈ `visual_prompt` | 已有 | Hub 用 visual_prompt |
| `image_prompt` / `polished_prompt` | 生图提示 | ≈ 拼进 `doubao_prompt` | 已有思路 | |
| `video_prompt` | 视频提示 | ≈ `doubao_prompt` | 已有 | |
| `universal_segment_text` | 全能片段 | ❌ | 后期 | Seedance omni |
| `characters` | 出场角色 ID | ≈ `characters` 文本名 | **改成引用 ID** | 长期绑定人物库 |
| `scene_id` / props | 场景道具 | ❌ | 后期 | IP 阶段可暂缓 |
| `status` | 状态 | ✅ `status` | 已有 | |

## Hub 分镜 · 推荐 v2 字段

```text
shot_no              镜号*
title                镜头短标题（可选）
shot_size            景别*
movement             运镜（从 camera_note 拆出或并存）
duration_sec         时长*
character_ids[]      出场角色（FK，长期记住）
characters_text      兼容显示名（可自动生成）

# 叙事层（写分镜核心）
action               动作：谁在做什么*
result               结果：这镜结束画面*
dialogue             对白
narration            旁白
atmosphere           氛围
emotion              情绪

# 画面 / 导出
visual_prompt        画面描述（可 AI 生成）
camera_note          机位补充
doubao_prompt        豆包完整提示词（自动拼角色卡）
layout_description   空间布局（可选）
status               draft|ready|generated|done
```

## 豆包提示词拼接顺序（建议）

```text
1. 全局画风（project.style_guide）
2. 出场角色卡（外貌 + identity_anchors + 定妆提示 + 性格一句）
3. 景别 + 运镜 + 时长
4. action + result
5. atmosphere / emotion
6. dialogue（口型参考，勿烧字幕）
7. visual_prompt / layout（补充）
```

## 优先级

1. **P0**：`action` / `result` / `narration` / `atmosphere` / `emotion`；拆镜输出这些字段
2. **P1**：`characters` 改为角色 ID 引用（不再只存逗号名）
3. **P2**：`movement` 结构化；`title`；`layout_description`
4. **P3**：场景/道具表、全能片段、首尾帧
