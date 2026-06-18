# ClawDrop

ClawDrop 是一个部署在云电脑本机的私有文件投递箱。OpenClaw 可以通过命令行或 PowerShell 把生成文件上传到 ClawDrop；管理员可以在 Mac、iPhone、iPad 等设备的浏览器中查看、预览、下载和删除文件。

它刻意保持简单：单实例、单管理员、原生前端、本地 SQLite 元数据和本地文件存储。它不是网盘，也不提供多用户、目录同步或公开分享功能。

## 功能

- 单文件上传、文件列表、详情、预览、下载和软删除 API
- `UPLOAD_TOKEN` 与 `ADMIN_TOKEN` 分权鉴权
- SQLite 保存文件元数据、SHA-256 和下载次数
- 文件实际内容保存在 `storage/`，运行时自动创建 `storage/` 与 `data/`
- 图片、文本和 PDF 安全预览；HTML 始终按纯文本返回
- 桌面与移动端自适应的原生 HTML/CSS/JavaScript 管理页
- Windows PowerShell 与跨平台 Node 上传脚本
- 默认 200 MB 文件大小限制，可通过环境变量调整

## 要求

- Node.js 20 或更高版本
- npm
- Windows PowerShell 上传脚本还需要系统可用的 `curl.exe`

## 本地运行

```bash
git clone <your-repository-url>
cd clawdrop
npm install
cp .env.example .env
```

编辑 `.env`，务必把两个示例 token 换成不同的强随机值。可用以下命令生成：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

然后启动：

```bash
npm run check
npm test
npm start
```

浏览器打开 `http://localhost:3010`，输入 `.env` 中的 `ADMIN_TOKEN`。

没有 `.env` 时服务仍会启动，但受保护接口会全部拒绝请求，并在启动时提醒配置 token。示例 token、过短 token 或两个 token 相同时也会出现明显安全警告；日志不会打印 token 内容。

## 环境变量

| 变量 | 默认值/示例 | 说明 |
| --- | --- | --- |
| `PORT` | `3010` | HTTP 端口 |
| `HOST` | `0.0.0.0` | 监听地址；仅本机测试可改为 `127.0.0.1` |
| `UPLOAD_TOKEN` | 无 | 只允许访问上传 API |
| `ADMIN_TOKEN` | 无 | 允许列表、详情、预览、下载和删除 |
| `MAX_FILE_SIZE_MB` | `200` | 单个上传文件大小上限（MB） |
| `STORAGE_DIR` | `storage` | 文件存储目录；相对路径以项目目录为基准 |
| `DATABASE_PATH` | `data/clawdrop.sqlite` | SQLite 路径；相对路径以项目目录为基准 |
| `PUBLIC_BASE_URL` | `http://localhost:3010` | 部署后的公开基础地址，供运维和脚本配置参考 |

`.env`、`data/`、`storage/` 均被 Git 忽略。首次运行会自动创建数据和存储目录。

## Mac 本地测试

启动服务后，新开一个终端：

```bash
export CLAWDROP_SERVER=http://127.0.0.1:3010
export CLAWDROP_UPLOAD_TOKEN='<你的 UPLOAD_TOKEN>'
printf 'hello from OpenClaw\n' > /tmp/clawdrop-test.txt
node scripts/upload.js /tmp/clawdrop-test.txt
```

也可以直接使用 curl：

```bash
curl -H "Authorization: Bearer $CLAWDROP_UPLOAD_TOKEN" \
  -F "file=@/tmp/clawdrop-test.txt" \
  "$CLAWDROP_SERVER/api/upload"
```

验证匿名请求被拒绝：

```bash
curl -i http://127.0.0.1:3010/api/files
```

验证健康检查：

```bash
curl http://127.0.0.1:3010/api/health
```

管理 API 需要 `Authorization: Bearer <ADMIN_TOKEN>`。完整集成测试可执行 `npm test`，覆盖双 token 隔离、上传、列表、详情、HTML 纯文本预览、下载计数、删除、大小限制和安全响应头。

## Windows 云电脑部署提示

1. 安装 Node.js 20 LTS 或更新版本，并确认 `node --version`、`npm --version`、`curl.exe --version` 可用。
2. 克隆仓库，执行 `npm install`。
3. 复制 `.env.example` 为 `.env`，设置不同的强 `UPLOAD_TOKEN` 和 `ADMIN_TOKEN`。
4. 首次以前台方式运行 `npm start` 并检查 `http://127.0.0.1:3010/api/health`。
5. 按实际访问范围配置 Windows 防火墙。若需要跨公网访问，先配置 HTTPS 反向代理，不要直接裸露 HTTP 端口。
6. 稳定运行后可使用 PM2、NSSM 或 Windows 任务计划程序守护进程。

本仓库不会自动修改防火墙、安装服务或执行云电脑部署。

## OpenClaw 上传方式

为 OpenClaw 运行环境设置：

```powershell
$env:CLAWDROP_SERVER = "http://127.0.0.1:3010"
$env:CLAWDROP_UPLOAD_TOKEN = "<UPLOAD_TOKEN>"
```

只把 `UPLOAD_TOKEN` 提供给 OpenClaw。它不能查看列表、预览、下载或删除文件。`ADMIN_TOKEN` 只应配置在管理员浏览器和受信任的管理环境中。

### PowerShell 脚本

```powershell
.\scripts\upload.ps1 "C:\path\to\file.zip"
```

脚本显式调用 `curl.exe`，兼容 Windows PowerShell，成功时打印文件名、ID、字节数、受保护下载地址和预览地址。地址本身不包含 token，访问仍需 `ADMIN_TOKEN`。

### Node 脚本

```powershell
node .\scripts\upload.js "C:\path\to\file.zip"
```

Node 脚本以流式 multipart 上传文件，不会把整个大文件一次性读入内存。

## API 简述

| 方法 | 路径 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| `GET` | `/api/health` | 无 | 健康检查 |
| `POST` | `/api/upload` | `UPLOAD_TOKEN` | multipart 单文件上传，字段名 `file` |
| `GET` | `/api/files` | `ADMIN_TOKEN` | 文件列表 |
| `GET` | `/api/files/:id` | `ADMIN_TOKEN` | 文件详情 |
| `GET` | `/api/files/:id/download` | `ADMIN_TOKEN` | 附件下载并增加下载次数 |
| `GET` | `/api/files/:id/preview` | `ADMIN_TOKEN` | 图片、文本或 PDF 预览 |
| `DELETE` | `/api/files/:id` | `ADMIN_TOKEN` | 删除实际文件并软删除元数据 |

鉴权头格式：

```text
Authorization: Bearer <TOKEN>
```

## 安全注意事项

- 使用两个不同的、至少 32 字符的随机 token，并定期轮换。
- Token 不写入源码、URL 或日志；网页管理 token 仅存于浏览器 localStorage。
- 上传文件使用随机 UUID 存储名，原始文件名只用于显示和下载响应。
- `storage/` 不作为静态目录暴露，所有下载与预览都经过管理鉴权。
- HTML、JavaScript、CSS 等文本预览统一以 `text/plain` 返回，并启用 `nosniff` 与严格 CSP。
- 文本预览最多 2 MB，单文件上传默认最多 200 MB。
- 应用层 token 不是传输加密。如果服务暴露到公网，务必使用强 token、HTTPS、严格防火墙规则，并优先增加 Caddy/Nginx 反向代理鉴权或网络层访问控制。
- 复制的下载链接仍是受保护接口，不包含 token，不能作为公开分享链接使用。
- localStorage 中的 token 会暴露给同源脚本；不要在该域名下托管不受信任的页面，并保持依赖和运行时更新。

## 后续可选优化

- 使用 HTTPS
- Caddy/Nginx 反向代理
- PM2/NSSM 进程守护
- 自动清理旧文件
- 有时效、可撤销的分享链接
- MinIO/S3 对象存储

## 开发命令

```bash
npm run check  # JavaScript 语法检查
npm test       # API 集成测试
npm start      # 启动服务
```
