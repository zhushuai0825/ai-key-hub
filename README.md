# AI 模型 Key 管理中枢

用于集中管理 DeepSeek、通义千问、豆包、智谱等模型厂商的 API Key、余额、模型目录和复制格式。

## 功能

- 厂商余额看板
- API Key 新增、编辑、删除
- Key 默认脱敏展示
- 支持复制：API Key、Base URL + Key、curl 示例、环境变量
- 模型目录展示
- 低余额和异常 Key 提醒
- PostgreSQL 数据库存储

## 本地启动

1. 启动 PostgreSQL：

```bash
docker compose up -d postgres
```

2. 安装依赖：

```bash
npm install
```

3. 启动服务：

```bash
npm run dev
```

4. 打开：

```text
http://127.0.0.1:8899
```

## 数据库连接

默认连接：

```text
postgres://ai_admin:ai_admin_123@127.0.0.1:5432/ai_key_hub
```

可用环境变量覆盖：

```bash
export DATABASE_URL="postgres://user:password@host:5432/dbname"
export PORT=8899
```

## 注意

第一版已经使用 PostgreSQL，但没有登录和加密。真实部署时必须增加：

- 登录认证
- HTTPS
- API Key 加密存储
- 操作审计
