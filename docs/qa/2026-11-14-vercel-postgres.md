# Vercel / PostgreSQL 本地验证记录

基线：`0fa93ee17948e6edfb4570eea5db5bd40df2d365`。本次验证使用临时的本机 PostgreSQL 18、独立测试 schema、虚构账号及 SMTP 服务，没有连接 Neon 或现有生产数据库。

- `npm test`：43 个测试文件、316 项通过；设置了仅指向本机临时数据库的 `DAZI_TEST_DATABASE_URL`，因此包含真实 PostgreSQL 集成测试。
- `npm run test:e2e`：SQLite 22 项通过；设置 `DAZI_E2E_POSTGRES_URL` 后，同一组浏览器用例在隔离 PostgreSQL 上 22 项通过。
- `npm run typecheck`、`npm run build`、`npm run test:vercel-esm` 均通过；`npm run test:sites` 4 项通过。构建输出保留 `dist/client/index.html`、`dist/server/index.js`、`dist/.openai/hosting.json`。
- Docker：使用临时构建的镜像通过主页、API、所有权、暂停/继续、容器替换、数据卷持久化及 SQLite 备份恢复烟测。
- 本机真实 PostgreSQL 事务测试覆盖验证码和注册并发、成绩去重、站点/SMTP 修订冲突、权限撤销竞态、审核阈值竞态、跨实例限流及过期清理竞态；32 MiB 配额边界并发和超过 4.5 MB 的同步、文章库及历史分页均有覆盖。
- SQLite → PostgreSQL → 新 SQLite 往返覆盖账号、验证码、历史输入中的零字节、私有删除标记、文章、SMTP 密文、审计与序列；另以 `pg_dump` / `pg_restore` 在两个本机临时数据库间恢复，核对文章、账号、审计、SMTP 密文及审计序列。
- 本机临时 SMTP 服务覆盖证书验证的 TLS、STARTTLS、接收验证码和后台连接测试不发信；它不是公网 SMTP 或真实收件人投递测试。
- 独立审查发现并修复了 PostgreSQL 暂停语法、Vercel 多段路由、Node ESM 导入、目标端点核验、会话撤销与阈值竞态、限流清理竞态、连接池 schema 隔离及零字节迁移问题。回归测试覆盖这些场景。

未验证：真实 Neon 分支、Vercel Preview、Vercel 到 Neon 的实测延迟、真实 SMTP 服务商连接和最终收件人送达、实体设备 IME 候选窗口。没有运行 GitHub Actions、推送分支、创建 PR、迁移生产数据或上线。
