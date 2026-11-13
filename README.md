# 云打字练习

一个轻松的中英文打字练习网站。内置中文和英文各 21 篇原创练习文章，分别覆盖入门、进阶和挑战三个阶段；测试默认 5 分钟，可手动设置 1–60 分钟，并支持日间和夜间模式。打完当前文章或时间到时立即展示结果。

游客可练习、保存本机记录并提交排行榜；注册用户可用用户名或邮箱加密码、或邮箱验证码登录，成绩保存在服务器。练习可暂停，未完成的进度可在同一浏览器中恢复；暂停时间不计入速度。也可输入自己的文字进行本地练习。排行榜按语言、难度和时长分组，每个账号或浏览器游客身份保留一项最佳成绩。游客成绩不会自动合并到账号，自定义文字不参与在线排行。

## 本地开发

推荐 Node.js 26 LTS（本地开发至少需要 Node.js 22.13）和 npm：

```bash
npm ci
MAIL_DEV_MODE=console npm run dev:api
```

另开一个终端运行：

```bash
npm run dev
```

打开终端显示的本地地址。`MAIL_DEV_MODE=console` 仅用于开发，验证码会打印在后端终端，不会发送真实邮件。也可以配置下方 SMTP 环境变量发送真实邮件。

```bash
npm run typecheck
npm test
npm run build
npm run test:sites
```

## Docker Compose 部署

准备一台已安装 Docker 和 Compose 的服务器，并将域名解析到服务器，开放 80 和 443 端口。内地服务器请按服务商要求完成备案。Caddy 在域名和端口可用时自动申请 HTTPS 证书。

```bash
cp .env.example .env
openssl rand -hex 32
```

将生成的随机值填入 `.env` 的 `CODE_SECRET`，填写 `SITE_DOMAIN`，然后按需填写 SMTP 和管理员邮箱。切勿提交 `.env` 或泄露密钥。

```bash
docker compose up -d --build
docker compose logs -f app
```

邮件服务未配置时，游客练习和排行榜仍可使用，已注册用户仍可用密码登录；注册、邮箱验证码登录和找回密码需要可用的 SMTP 服务。SMTP 服务通常要求验证发信域名，使用前请确认供应商的账号资格和费用。

`ADMIN_EMAIL` 指定一个已验证邮箱；用该邮箱注册账号后，会出现“审核”入口，可通过或拒绝异常成绩，管理员也可在排行榜中下架成绩。请妥善控制该邮箱及其账号。

## 数据备份与恢复

数据库保存在 `typing_data` Docker 卷里。在线备份使用 SQLite 的备份接口，而不是直接复制运行中的数据库：

```bash
docker compose exec app node scripts/backup.mjs /app/data/backup.sqlite
docker compose cp app:/app/data/backup.sqlite ./backup.sqlite
```

恢复前先备份当前数据，确认恢复文件无误，再停止应用。以下命令会用备份覆盖当前数据库，并移除原数据库的 WAL 辅助文件：

```bash
docker compose stop app
docker compose cp ./backup.sqlite app:/app/data/dazi.sqlite
docker compose run --rm --no-deps --user root --entrypoint sh app -c 'chown node:node /app/data/dazi.sqlite && rm -f /app/data/dazi.sqlite-wal /app/data/dazi.sqlite-shm'
docker compose up -d app
```

请定期将备份复制到服务器之外。`docker compose down -v` 会删除数据卷，普通重启无需使用 `-v`。

## 计分说明

已确认上屏的字符逐个与题目比较；字符包含空格和标点。中文成绩为每分钟正确字符数（CPM），英文成绩为正确字符数除以 5 后的每分钟词数（WPM）；准确率按最终输入内容计算。中文输入法候选尚未上屏时不计入成绩，编辑候选词使用的退格也不计入文章退格次数。页面同时展示文章字数、已打字数、当前错误字数和退格次数。在线挑战由服务端复算并检查时间、练习进度、重复提交及异常数据；暂停过的成绩、中文超过 220 CPM 或英文超过 180 WPM 的成绩会进入人工复核。浏览器环境无法彻底杜绝自动化作弊。
