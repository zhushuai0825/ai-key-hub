# 企业微信自建应用接入

## 1. 企业微信后台准备

进入企业微信管理后台，创建一个自建应用，例如 `AI助手`。

需要记录：

- `CorpID`：企业 ID
- `AgentId`：应用 ID
- `Secret`：应用 Secret
- `Token`：消息回调 Token，可自己填写
- `EncodingAESKey`：消息加解密 Key，可后台随机生成

## 2. 服务端环境变量

启动服务前配置：

```bash
export WECHAT_WORK_CORP_ID="你的 CorpID"
export WECHAT_WORK_TOKEN="你的回调 Token"
export WECHAT_WORK_ENCODING_AES_KEY="你的 EncodingAESKey"
export WECHAT_WORK_SECRET="你的自建应用 Secret"
export WECHAT_WORK_AGENT_ID="你的自建应用 AgentId"
```

如果要让图片消息自动识别文字，可配置 OpenAI 兼容的视觉大模型 OCR：

```bash
export OCR_API_KEY="视觉模型 API Key"
export OCR_BASE_URL="https://你的视觉模型服务/v1"
export OCR_MODEL="视觉模型名称"
```

配置后，图片消息没有 `OCRText` 时，系统会下载企业微信图片并调用视觉模型识别文字，再进入记账、健康、知识库和提醒处理链路。

`Secret` 用于下载企业微信文件素材、获取 access_token 并**主动推送提醒消息**。`AgentId` 是应用详情页上的 AgentId 数字。

若不配置 `WECHAT_WORK_AGENT_ID`，提醒任务仍会创建，但不会主动推送到企微。

## 3. 企业微信回调 URL

在自建应用的“接收消息”里配置：

```text
https://你的域名/api/wechat/work-webhook
```

如果本地调试，需要先用内网穿透把 `127.0.0.1:8899` 暴露成公网 HTTPS 地址。

## 4. 可选：默认知识库

聊天时会自动检索知识库。若只想搜某一个库，可配置：

```bash
export WECHAT_DEFAULT_KB_ID=1
```

不配置时会搜索全部知识库。

## 5. 消息能力

### 自动记录（陈述句 + 明确数据）

- `今天体重72.5kg` -> 健身/体重
- `买咖啡 18` -> 账本/支出
- `收入工资 5000` -> 账本/收入
- `跑步 30 分钟` -> 健身/运动
- `睡了 7 小时` -> 健身/睡眠
- `吃了鸡胸肉米饭` -> 健身/饮食

### 智能聊天（查询 + 闲聊）

以下会结合你的记录和知识库回答，不会误记为账单/体重：

- `我这个月花了多少钱`
- `最近体重怎么样`
- `昨天跑了多久`
- `我买了什么`
- `知识库里 XXX 是什么`
- `你好`、`帮我分析一下睡眠`

带「多少」「吗」「查」「统计」等问句，会优先走聊天而不是记录。

### 提醒任务（主动推送）

对企业微信说：

- `明天早上9点提醒我开会`
- `每周一提醒我看体重`
- `每天晚上10点提醒睡觉`

服务会每分钟检查到期任务，并通过企业微信**主动发消息**提醒你。

重复规则支持：`none`（一次）、`daily`、`weekly`、`monthly`。

需要配置：

```bash
export WECHAT_WORK_SECRET="你的自建应用 Secret"
export WECHAT_WORK_AGENT_ID="你的 AgentId"
```

### 文件上传到知识库

在企业微信里给 `AI助手` 发送文件，系统会自动下载并写入默认知识库。

也可以先发一句话指定下一个文件的目标知识库，系统会记住 5 分钟：

- `下一个文件保存到小说知识库`
- `这份资料上传到健身知识库`

如果目标知识库不存在，会自动创建，例如 `小说知识库`。

文件入库后，后台「知识库」页面会显示来源、上传人和企业微信文件名。

支持格式：

- TXT / MD
- PDF
- DOCX
- JSON
- CSV

需要配置：

```bash
export WECHAT_WORK_SECRET="你的自建应用 Secret"
```

如果配置了 `WECHAT_DEFAULT_KB_ID`，默认文件会进入指定知识库；否则会自动创建/使用 `微信上传资料` 知识库。临时指定的目标知识库优先级更高。

### 语音和图片识别

- 语音消息：如果企业微信回调包含 `Recognition`，系统会当成文本继续处理。
- 图片消息：如果企业微信回调包含 `OCRText/Text`，系统会当成文本继续处理。
- 图片无 OCR 文本：配置 `OCR_API_KEY`、`OCR_BASE_URL`、`OCR_MODEL` 后，系统会调用视觉大模型识别图片文字。

## 6. 本地测试

不经过企业微信，直接模拟消息：

```bash
# 记录
curl -X POST http://127.0.0.1:8899/api/wechat/test-message \
  -H 'Content-Type: application/json' \
  -d '{"content":"今天体重72.5kg"}'

# 查询
curl -X POST http://127.0.0.1:8899/api/wechat/test-message \
  -H 'Content-Type: application/json' \
  -d '{"content":"我这个月花了多少钱"}'
```
