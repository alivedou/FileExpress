# ADR 001: 可替换存储适配器

- 状态：Accepted
- 决策：以 `StorageBackend` 隔离领域逻辑；外部 SDK 通过适配器注入。
- 原因：统一路由、健康检查、迁移与故障转移，同时允许 MinIO/AWS/Azure/PostgreSQL/IPFS 在集成环境使用真实客户端。
- 后果：每个适配器必须验证流式上传、校验和、预签名与失败清理；云凭据不得进入仓库。
