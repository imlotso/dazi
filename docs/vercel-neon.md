# Vercel + Neon 操作说明

本分支提供部署代码和本地验证，不代表已经部署。请先在隔离的 Preview 环境完成验证；本文不授权迁移正式数据、变更域名或上线。Vercel Hobby 仅适用于个人、非商业用途，具体以 [Vercel 条款](https://vercel.com/legal/terms) 为准。

## 隔离与密钥

1. 在现有 Neon Free 项目内准备独立的测试分支或数据库，确认它不是将来用于正式服务的分支。保持 Free 计划，不启用付费或绑定银行卡。Preview 与生产使用不同的数据库分支、账号/连接串和密钥。
2. 在 Vercel 项目中分别配置 Preview 和 Production 环境变量。服务端 `DATABASE_URL` 使用各自 Neon 分支的**连接池**地址，并保留 Neon 提供的 TLS 参数（如 `sslmode=require`）；`CODE_SECRET` 至少 32 字符。Preview 使用单独的测试密钥；未来若迁入原有数据，Production 必须继续使用原先稳定的 `CODE_SECRET`，否则已保存的 SMTP 密码无法解密，PostgreSQL 实例会拒绝启动。
3. 可按需要配置 `ADMIN_EMAIL`、`SMTP_HOST`、`SMTP_PORT`、`SMTP_SECURE`、`SMTP_USER`、`SMTP_PASSWORD` 和 `SMTP_FROM`。后台设置优先于部署 SMTP 设置，部署设置是回退。Vercel 不支持 SMTP 出站 25 端口；使用服务商支持的 465（`SMTP_SECURE=true`）、587 或 2525（STARTTLS）。后台测试连接不等于邮件成功送达。
4. 在 Vercel 构建设置中使用仓库的 `vercel.json` 和 Node.js 22。函数区域设置为 `sin1`，与 Neon 项目所在 AWS 新加坡区域相邻；实际延迟必须从 Preview 另行测量。仅在通过 Preview 验证后再讨论生产切换。

为维持原 SQLite 的跨操作一致性，PostgreSQL 写事务目前跨实例串行化；流量增大时可能增加等待时间，应在 Preview 中测量同步、登录和成绩提交的延迟，再评估是否需要更细粒度的锁。

连接串、数据库密码、`CODE_SECRET` 和 SMTP 密码只放在 Vercel 服务端环境变量或本机私密环境中，不放在聊天、前端、Git、命令参数或日志。不要将 Preview 密钥复用于生产。

## 操作前确认

迁移、导入、导出和首位管理员命令必须在可信的操作机器上执行。使用 Neon **直连**地址进行维护，避免连接池的会话状态限制；应用运行时可使用池化地址。`DAZI_DATABASE_HOST`、数据库名和 schema 必须与 URL 指向的目标一致，确认值包含端点，可区分同名数据库的不同 Neon 分支。

在交互式 shell 安全输入连接串（输入不会回显，也不要把连接串写进命令历史）：

```bash
read -r -s -p 'Neon 直连 DATABASE_URL: ' DATABASE_URL; printf '\n'
export DATABASE_URL
export DAZI_DATABASE_HOST='这里填预览分支的直连主机名'
export DAZI_DATABASE_NAME='这里填预览数据库名'
export DAZI_DATABASE_SCHEMA='public'
export DAZI_CONFIRM_TARGET="$DAZI_DATABASE_HOST/$DAZI_DATABASE_NAME/$DAZI_DATABASE_SCHEMA"
```

检查 `DAZI_DATABASE_HOST` 是否为预期的**测试分支端点**。不要输出 `DATABASE_URL`。以下命令不会在应用冷启动时自动执行：

```bash
npm run db:postgres -- migrate
# 全新空库二选一：载入内置文章，或导入经过核验的 SQLite 快照。
npm run db:postgres -- seed
# npm run db:postgres -- import /安全路径/源快照.sqlite
```

`migrate` 只接受明确确认的空 schema 或相同版本的已初始化 schema；`seed` 要求文章表为空。`import` 要求整个目标及限流表为空，在事务中核验源库完整性、表结构、逐表内容和审计序列，不支持的源结构会拒绝导入。先停止指向目标库的应用，包括健康检查：任何访问都可能生成限流记录，使导入拒绝继续。中途连接中断时提交状态可能未知，先核查目标库，再决定是否在一个全新的空目标上重试。不要删除或覆盖原库。

没有 SMTP 可用于新空库时，可在明确确认目标后创建**首位**管理员。该命令仅接受标准输入的一行密码，且数据库中已有管理员时拒绝执行；它会写审计记录：

```bash
export ADMIN_USERNAME='管理员用户名'
export ADMIN_EMAIL='管理员邮箱'
read -r -s -p '首位管理员密码: ' DAZI_ADMIN_PASSWORD; printf '\n'
printf '%s\n' "$DAZI_ADMIN_PASSWORD" | npm run db:postgres -- bootstrap
unset DAZI_ADMIN_PASSWORD
```

随后可通过共享登录入口进入后台配置 SMTP。不要把密码写入命令行参数、脚本或环境文件。

## 备份、验证与恢复

- SQLite：沿用 `scripts/backup.mjs` 的在线备份接口，备份数据库时也要在独立安全位置保存原 `CODE_SECRET`。导入前保留原始文件和备份，停止写入并核验备份；不要直接复制运行中 SQLite 主文件而忽略 WAL。
- PostgreSQL：使用与服务器主版本兼容的 `pg_dump` / `pg_restore`。在私密环境设置 `PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER`、`PGSSLMODE=require` 和权限为 `0600` 的 `PGPASSFILE`；勿把带密码的 URL 放进命令参数。先确认环境指向预期分支，再执行：

```bash
umask 077
pg_dump --format=custom --no-owner --no-acl --file=./dazi-backup.pgdump
pg_restore --list ./dazi-backup.pgdump > ./dazi-backup-manifest.txt
```

备份和清单都含敏感业务信息，应加密、限制访问并另存。定期在**另一个空的隔离数据库**中恢复演练，确认目标的 `PGHOST` 和 `PGDATABASE` 后执行：

```bash
pg_restore --exit-on-error --single-transaction --no-owner --no-acl \
  --dbname="$PGDATABASE" ./dazi-backup.pgdump
```

恢复后核对文章、账号、历史、私人空间、SMTP 密文及审计记录，并以原 `CODE_SECRET` 验证 SMTP 配置能否解密。恢复仅证明数据可读取；真实邮件送达仍须实际发信确认。

## 回滚

切换前保留已验证的 SQLite 快照和旧应用版本。若 PostgreSQL 从未接受新写入，可停写后切回原 SQLite 快照；若已经接受写入，不能直接切回旧快照，否则会丢失切换后的数据。先进入维护状态并停止所有写入，备份 PostgreSQL，再将当前数据导出到**不存在的新文件**：

```bash
npm run db:postgres -- export /安全路径/新回滚快照.sqlite
```

导出使用 PostgreSQL 一致性快照，逐表核对内容并保留审计序列，拒绝覆盖已有文件。核验新 SQLite 文件、与原 `CODE_SECRET` 配套的 SMTP 密文以及关键账号/练习/排行数据后，才可在用户另行授权的维护窗口里切换回旧应用。导出开始后到停写完成之间的任何新写入都不在快照中，因此必须先停写；验证失败时保留 PostgreSQL 和备份，不执行切换。

## 当前验证范围

本地隔离 PostgreSQL 覆盖注册和验证码并发、权限撤销、配置冲突、成绩去重、恢复练习、多实例限流、32 MiB 配额并发、超过 4.5 MB 的分页、SQLite 往返迁移、备份恢复、冷启动和连接恢复；现有浏览器用例也分别在 SQLite 和 PostgreSQL 上运行。本机 SMTP 测试使用临时服务验证 TLS 和 STARTTLS 握手、接收验证码以及连接测试不发信。实际 Neon、Vercel Preview、Vercel 至 Neon 延迟、公网 SMTP 连接/送达和实体设备输入法仍需在隔离环境验证。运行 `npm run test:vercel-esm` 可检查 Node 22 对函数入口和其模块图的原生导入；这不能替代真实 Preview。
