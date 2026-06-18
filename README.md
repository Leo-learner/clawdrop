# ClawDrop

ClawDrop 是一个部署在云电脑本机的轻量私有文件投递箱。OpenClaw 使用上传专用 token 提交文件；管理员在 Mac、iPhone、iPad 等设备的浏览器中搜索、预览、下载、删除文件，并可按需创建有时效、可限次、可撤销的临时分享链接。

项目保持单实例、单管理员：原生 HTML/CSS/JavaScript 前端，Node.js + Express 后端，SQLite 元数据和本地 `storage/` 文件存储。它不是复杂网盘，也不提供多用户或目录同步。

## v2 功能

- 保留 v1 文件上传、列表、详情、安全预览、下载和软删除 API
- `UPLOAD_TOKEN` 与 `ADMIN_TOKEN` 严格分权
- 临时分享链接：有效期 1–168 小时、可限制 1–100 次下载、可随时撤销
- 分享页面无需管理 token，只展示并下载一个指定文件
- 管理页按文件名/MIME 搜索，并按图片、文本、PDF、压缩包、其他筛选
- 图片、文本和 PDF 预览优化；HTML 始终按纯文本返回
- 可选的定时旧文件清理，以及支持 dry-run 的管理员手动清理 API
- Windows PowerShell、跨平台 Node 上传脚本和 Windows 部署检查脚本
- SQLite 运行时自动迁移，v1 数据库可直接升级

## 运行要求

- Node.js 20 或更高版本
- npm
- Windows PowerShell 上传脚本需要系统可用的 `curl.exe`

## 本地运行

```bash
git clone https://github.com/Leo-learner/clawdrop.git
cd clawdrop
npm install
cp .env.example .env
```

编辑 `.env`，把两个示例 token 替换为不同的强随机值。可分别运行两次：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

然后执行：

```bash
npm run check
npm test
npm start
```

浏览器打开 `http://localhost:3010`，输入 `.env` 中的 `ADMIN_TOKEN`。首次运行会自动创建 `data/`、`storage/` 和数据库表。

没有 `.env` 时服务仍可启动，但受保护接口会拒绝请求。示例 token、短 token 或两个 token 相同时，启动日志会显示安全警告，但不会打印 token 内容。

## 环境变量

| 变量 | 默认值/示例 | 说明 |
| --- | --- | --- |
| `PORT` | `3010` | HTTP 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址；仅本机使用可改为 `127.0.0.1` |
| `UPLOAD_TOKEN` | 无 | 只允许上传文件 |
| `ADMIN_TOKEN` | 无 | 允许文件和分享链接管理 |
| `MAX_FILE_SIZE_MB` | `200` | 单文件上限（MB） |
| `STORAGE_DIR` | `storage` | 文件目录；相对路径以项目目录为基准 |
| `DATABASE_PATH` | `data/clawdrop.sqlite` | SQLite 路径 |
| `PUBLIC_BASE_URL` | `http://localhost:3010` | 分享链接的外部基础地址；留空时使用当前请求的 host |
| `AUTO_CLEANUP_ENABLED` | `false` | 是否启用定时旧文件清理 |
| `AUTO_CLEANUP_DAYS` | `30` | 清理早于多少天的文件 |
| `AUTO_CLEANUP_INTERVAL_HOURS` | `12` | 定时扫描间隔（小时） |

`.env`、`data/`、`storage/` 均被 Git 忽略，不会上传到 GitHub。

## Mac 本地测试

启动服务后，在另一个终端执行：

```bash
export CLAWDROP_SERVER=http://127.0.0.1:3010
export CLAWDROP_UPLOAD_TOKEN='<你的 UPLOAD_TOKEN>'
printf 'hello from OpenClaw\n' > /tmp/clawdrop-test.txt
node scripts/upload.js /tmp/clawdrop-test.txt
```

也可用 curl：

```bash
curl -H "Authorization: Bearer $CLAWDROP_UPLOAD_TOKEN" \
  -F "file=@/tmp/clawdrop-test.txt" \
  "$CLAWDROP_SERVER/api/upload"

curl http://127.0.0.1:3010/api/health
curl -i http://127.0.0.1:3010/api/files  # 应返回 401
```

`npm test` 使用 Node 内置 test runner，覆盖双 token 隔离、分享链接正常/过期/限次/撤销、HTML 纯文本预览、删除联动失效和自动清理。

## 临时分享链接

管理员在文件操作区点击“创建分享”，设置有效期和可选下载次数，随后复制完整分享链接。公开访问者无需 `ADMIN_TOKEN`，但只能看到该链接对应的单个文件；链接不能列出、预览或删除其他文件，也不能调用管理 API。

分享链接满足以下任一条件后不可下载：

- 管理员撤销链接
- 链接超过有效期
- 已达到下载次数上限
- 文件已被管理员删除或自动清理

`PUBLIC_BASE_URL` 应设置为浏览器实际访问 ClawDrop 的 HTTPS 地址，否则完整分享链接可能仍显示为本机地址。

也可通过管理员 API 创建：

```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"expiresInHours":24,"maxDownloads":5}' \
  "$CLAWDROP_SERVER/api/files/<FILE_ID>/share"
```

## 自动清理

自动清理默认关闭。启用后，服务按配置间隔扫描 `uploaded_at` 早于 `AUTO_CLEANUP_DAYS` 的活跃文件，删除实际文件、软删除 `files` 记录，并撤销关联分享链接。服务启动时不会立刻执行清理，首次扫描在一个完整间隔后发生。

建议先使用管理员 API 试运行：

```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"olderThanDays":30,"dryRun":true}' \
  "$CLAWDROP_SERVER/api/admin/cleanup"
```

确认匹配数量后，把 `dryRun` 改为 `false`。每次清理只记录 matched、deleted、failed 计数，不记录 token 或服务器绝对路径。

## Windows 云电脑部署与更新

首次部署：

```powershell
git clone https://github.com/Leo-learner/clawdrop.git
Set-Location .\clawdrop
Copy-Item .env.example .env
notepad .env
.\scripts\deploy-windows.ps1
npm start
```

部署脚本会检查 Node.js 版本、`.env` 和双 token，随后运行 `npm install`、`npm run check`、`npm test`。它不会修改防火墙、暴露公网端口或自动安装 PM2。若已安装 PM2，脚本仅提示：

```powershell
pm2 start server.js --name clawdrop
pm2 save
```

从 v1 更新到 v2 前先备份 `.env`、`data/`、`storage/`，然后：

```powershell
git pull --ff-only
.\scripts\deploy-windows.ps1
# 重启现有 ClawDrop 进程
```

启动时会自动创建 `share_links` 表和索引，不修改已有 `files` 数据。仓库不会自动配置 Windows 防火墙；跨设备或公网访问应由管理员明确配置 HTTPS 反向代理和最小化网络规则。

## OpenClaw 上传

只给 OpenClaw 配置上传权限：

```powershell
$env:CLAWDROP_SERVER = "http://127.0.0.1:3010"
$env:CLAWDROP_UPLOAD_TOKEN = "<UPLOAD_TOKEN>"
.\scripts\upload.ps1 "C:\path\to\file.zip"
```

或使用 Node 脚本：

```powershell
node .\scripts\upload.js "C:\path\to\file.zip"
```

v1 上传脚本返回的是受 `ADMIN_TOKEN` 保护的下载/预览地址，不是公开链接。v2 分享链接需要管理员在网页端创建；不要为了自动创建分享而把 `ADMIN_TOKEN` 提供给 OpenClaw。后续版本可设计权限更窄的分享专用 token。

## API

| 方法 | 路径 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| `GET` | `/api/health` | 无 | 健康检查 |
| `POST` | `/api/upload` | `UPLOAD_TOKEN` | multipart 单文件上传，字段名 `file` |
| `GET` | `/api/files` | `ADMIN_TOKEN` | 文件列表 |
| `GET` | `/api/files/:id` | `ADMIN_TOKEN` | 文件详情 |
| `GET` | `/api/files/:id/download` | `ADMIN_TOKEN` | 管理员附件下载 |
| `GET` | `/api/files/:id/preview` | `ADMIN_TOKEN` | 图片、文本或 PDF 预览 |
| `DELETE` | `/api/files/:id` | `ADMIN_TOKEN` | 删除实际文件并软删除元数据 |
| `POST` | `/api/files/:id/share` | `ADMIN_TOKEN` | 创建临时分享链接 |
| `GET` | `/api/files/:id/shares` | `ADMIN_TOKEN` | 查看文件的未撤销分享链接 |
| `DELETE` | `/api/shares/:id` | `ADMIN_TOKEN` | 撤销分享链接 |
| `GET` | `/s/:token` | 无 | 单文件公开分享页 |
| `GET` | `/s/:token/download` | 无 | 受时效/次数限制的公开下载 |
| `POST` | `/api/admin/cleanup` | `ADMIN_TOKEN` | 手动清理或 dry-run |

受保护 API 使用：

```text
Authorization: Bearer <TOKEN>
```

## 安全注意事项

- `UPLOAD_TOKEN` 与 `ADMIN_TOKEN` 应使用不同的至少 32 字符随机值；不要把 `ADMIN_TOKEN` 给 OpenClaw，也不要公开 `UPLOAD_TOKEN`。
- Token 不写入源码、URL 或日志。管理 token 仅存于浏览器 localStorage；分享 token 只存在于分享 URL，不存入 localStorage。
- 分享 token 使用至少 32 字节密码学随机数，不能由文件 ID 推导，适合短期交付，不应代替长期访问控制。
- 上传文件使用随机 UUID 存储名；下载、预览、删除均校验安全存储路径。
- `storage/` 不作为静态目录暴露；所有管理下载经过鉴权，公开分享只定位一个文件。
- HTML、JavaScript、CSS 按 `text/plain` 预览，并保留 CSP、Referrer-Policy、nosniff 和 X-Frame-Options。
- 文本预览最多 2 MB，单文件上传默认最多 200 MB。
- 如果暴露公网，务必使用强 token、HTTPS、严格防火墙规则，并建议使用 Caddy/Nginx 反向代理鉴权或网络层访问控制。

## 后续可选优化

- Caddy/Nginx HTTPS 反向代理模板
- PM2/NSSM 服务化和健康监控
- 分享专用低权限自动化 token
- 更细粒度的清理保留策略和审计记录
- 带密码的分享链接
- MinIO/S3 对象存储

## 开发命令

```bash
npm run check  # JavaScript 语法检查
npm test       # API 集成测试
npm start      # 启动服务
```
