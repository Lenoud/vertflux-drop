# Vertflux Drop · 浏览器文件快传

基于 [PairDrop](https://github.com/schlagmichdoch/PairDrop) 的个人快传应用，网站为 https://drop.vertflux.com 。

创建者通过 Vertflux SSO 登录，创建临时房间后把邀请链接发给另一台设备。接收者无需注册。双方保持页面打开，点击对方设备即可发送文件，右键或长按设备可以发送文字。

## 部署架构

- Cloudflare Pages：静态资源及认证网关，正式域名为 `drop.vertflux.com`。
- 私有 Worker `vertflux-drop-api`：仅通过 Pages 的 `DROP_API` Service Binding 调用，没有公网 Worker 入口。
- SQLite Durable Objects：每个房间独立管理邀请、双方连接和到期清理；每位主持人有独立房间目录。
- WebRTC DataChannel：沿用 PairDrop 的文件传输逻辑，优先设备直传；跨网络无法直连时使用 Cloudflare TURN。
- 现有 `auth.vertflux.com`：提供 SSO，主持人权限由认证网关管理。
- Spaceship：继续托管 DNS，`drop` CNAME 指向 `vertflux-drop.pages.dev`。

文件内容和聊天文字均不经过信令 Worker，也不上传到对象存储。TURN 只中继经过 WebRTC 加密的流量。服务端会保存房间名称、时间和短期连接凭据；关闭后清理凭据，房间对象随后清理。主持人目录最多留最近 30 间的名称和时间。

## 访问和使用限制

每间房间最多两台设备（创建者和一位来宾），有效时间为 30 或 60 分钟。每位主持人同时最多保留三间房间，每日最多创建二十间（UTC 零点重置）。同一房间最多签发十二个设备身份的 TURN 配置，刷新页面会复用当前设备的凭据。

邀请密钥放在 URL fragment 中，不会随 HTTP 请求进入访问 URL。首次进入后存到当前标签页的 sessionStorage 并移除地址栏 fragment。邀请属于持有即授权的链接，请只发送给预期接收者。清除浏览器数据后需要重新打开完整邀请链接。

主持人关闭房间或房间到期时，服务端关闭信令连接并撤销临时 TURN 凭据，客户端同时关闭 WebRTC。已经下载的文件无法撤回。收到文件时仍需接收者确认。双方离线后不能继续传输，也不提供异步网盘功能。

## 免费额度和成本边界

Pages、Workers 和 Durable Objects 使用当前账号的套餐额度，TURN 流量与账号其他 Realtime 应用共同计算。Cloudflare 当前 TURN 免费量及超额价格以[官方定价](https://developers.cloudflare.com/realtime/turn/pricing/)为准。

本应用限制房间数量、人数、有效时间和凭据签发量以控制滥用，**没有实现按流量自动停机的账单硬上限**。客户端显示“设备直传”时不消耗 TURN 中继流量；显示“加密中继传输”时会使用 TURN。不能把到期机制理解为绝不会产生费用的保证。

## 本地开发与验证

需要 Node.js 22。

```sh
npm ci
npm test
npm run build
```

测试覆盖匿名和 SSO 权限边界、伪造身份头、同源要求、邀请及连接票据、真实 Worker 运行时的 WebSocket 信令、并发房间与来宾限制，以及 TURN 凭据复用和到期撤销重试。浏览器文件传输应另用两个独立会话实际验收。

## 首次部署

1. 使用 `wrangler.backend.jsonc` 创建私有 Worker 和 SQLite Durable Objects。
2. 在 Worker 中设置 `DROP_SECRET`、`TURN_KEY_ID`、`TURN_KEY_TOKEN` 三个加密 Secret。
3. 创建 Pages 项目 `vertflux-drop`，生产分支为 `main`，绑定服务 `DROP_API -> vertflux-drop-api`，认证失败时关闭访问（`fail_open=false`）。
4. 在现有认证网关中添加 `drop.vertflux.com` 的 edge 应用、SSO 回调和允许创建房间的用户。
5. 构建并发布 Pages，绑定正式域名，再添加 Spaceship CNAME。

```sh
npm run deploy:backend
npm run build
npm run deploy:web
```

长期凭据只存 Cloudflare 加密 Secrets、GitHub Actions Secret 和 root 私有备份，不进入 Git 或构建产物。

## 自动更新与发布

`main` 推送后由 GitHub Actions 执行测试、构建、发布私有 Worker 和 Pages；普通 PR 仅执行检查。部署使用仓库的 `CLOUDFLARE_API_TOKEN` 加密 Secret。

每天检查 PairDrop 上游 `master`，有更新时创建或更新 `updates/upstream` PR，保留 Vertflux 的认证、部署与品牌配置。检查通过后仍需仓库所有者手动合并，合并才触发生产发布。有冲突时流水线停止，由人工处理。

## 上游和许可证

保留 PairDrop 的文件分块、收发和传输界面代码，替换了原 Node.js 服务端及浏览器 `ServerConnection`；原前端源文件保留，适配由构建脚本生成到 `dist/`。原 Node.js 后端仅作上游参考，不再作为本项目的运行入口。

本项目沿用 GPL-3.0-only，许可证见 [LICENSE](LICENSE)。上游说明保存在 [README.upstream.md](README.upstream.md)。
