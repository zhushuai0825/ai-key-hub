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
```

`AgentId` 和 `Secret` 后续用于主动发消息、菜单、通讯录等能力；当前消息接收和自动记录暂时不需要。

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
