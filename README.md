# TeamViewRelay 网页地图脚本

一个基于 Vue 3 + Vite 构建的 Tampermonkey 脚本，用于把 TeamViewRelay 后端中的远程玩家、路标和战局信息投影到 squaremap 网页地图。

相关组件：

- [Minecraft-TeamViewer-Backend](https://github.com/MC-TeamViewer/Minecraft-TeamViewer-Backend)：提供 `/web-map/ws` 数据通道
- [Minecraft_TeamViewer](https://github.com/MC-TeamViewer/Minecraft_TeamViewer)：负责从 Minecraft 客户端上报团队状态
- [map-nodemc-plugin-blocker](https://github.com/MC-TeamViewer/map-nodemc-plugin-blocker)：可选的 NodeMC 页面屏蔽脚本

## 项目简介

这个脚本运行在浏览器中，连接 TeamViewRelay 后端后，会把同一房间号（`roomCode`）下的状态渲染到 squaremap 页面。

当前主要用途：

- 显示远程玩家投影
- 显示共享路标、战术标记和战局区块
- 提供浏览器侧的配置面板、配置导入导出和连接控制

## 适用场景 / 与其他项目关系

- 需要配合 `Minecraft-TeamViewer-Backend` 使用，单独安装脚本不会产生远程投影数据。
- 一般由 `Minecraft_TeamViewer` 上报状态，网页地图脚本负责可视化。
- `map-nodemc-plugin-blocker` 是可选附加脚本，只用于屏蔽 NodeMC 页面上的某些问题扩展。

## 快速开始

1. 安装 Tampermonkey。
2. 安装本脚本。
3. 启动后端 `Minecraft-TeamViewer-Backend`。
4. 打开受支持的 squaremap 页面。
5. 在脚本设置中填写后端地址和房间号（`roomCode`）。
6. 验证地图上是否出现远程玩家、路标或战局区块。

## 安装 / 运行

需要：

- Tampermonkey
- 一个可访问的 TeamViewRelay 后端

当前脚本支持的站点：

- `https://map.nodemc.cc/*`
- `http://map.nodemc.cc/*`
- `https://map.fltown.cn/*`
- `http://map.fltown.cn/*`

安装方式有两种。

### 方式一：直接安装现成脚本

仓库内可直接导入的脚本产物：

- `build-artifacts/team-view-relay-web-script-v0.4.9-proto0.6.1.user.js`

也可以自行构建后，导入 `dist/*.user.js`。

### 方式二：本地开发构建

```bash
pnpm install
pnpm dev
pnpm build
```

构建产物位于：

- `dist/*.user.js`

## 配置或使用说明

### 首次接入流程

1. 安装脚本后打开受支持的 squaremap 页面。
2. 打开脚本设置面板。
3. 填写后端地址，例如 `ws://127.0.0.1:8765/web-map/ws`。
4. 设置房间号（`roomCode`），默认是 `default`。
5. 应用连接设置并等待连接成功。
6. 如果对应房间里已有 Mod 客户端上报状态，应能看到地图投影出现。

当前默认连接地址：

- `ws://127.0.0.1:8765/web-map/ws`

### 配置面板说明

- 开关类选项通常即时生效，不需要再次点击保存
- 输入框类选项采用手动确认，避免边输入边触发重连
- 连接设置分组使用“应用连接设置”，保存后会触发重连

### 配置导入 / 导出

- 支持导出当前配置为 JSON 文件
- 导入时会校验兼容版本
- 导入后的配置会统一经过归一化处理，缺失字段自动回落默认值，冗余字段自动忽略

## 常见问题

### 页面上没有任何投影

- 先确认后端已启动，并且脚本连接的是 `/web-map/ws`
- 再确认 Minecraft Mod 也连接到了同一个后端
- 最后确认双方 `roomCode` 一致

### 安装脚本后页面还是受 NodeMC 扩展影响

- 这个脚本不负责屏蔽 `nodes` 扩展
- 如果你是在 `map.nodemc.cc` 使用，可额外安装 [map-nodemc-plugin-blocker](https://github.com/MC-TeamViewer/map-nodemc-plugin-blocker)

### 连接上了但看不到特定玩家或标记

- 先检查对应玩家是否真的在上报
- 再检查房间号和后端是否一致
- 必要时用后端的 `/snapshot` 接口确认服务端当前状态

## 开发与构建

常用命令：

```bash
pnpm install
pnpm dev
pnpm build
pnpm proto:generate
```

构建前置依赖：

- `buf` CLI 用于从 `third_party/TeamViewRelay-Protocol` 生成 TypeScript 协议代码
- 如果本机没有 `buf`，可执行：

```bash
mkdir -p /tmp/buf/bin && GOBIN=/tmp/buf/bin go install github.com/bufbuild/buf/cmd/buf@v1.46.0
```

- 脚本会优先使用 `/tmp/buf/bin/buf`，也可以自行设置 `BUF_BIN=/your/path/to/buf`

关键目录：

- `src/index.ts`：脚本主入口
- `src/network/`：WebSocket 与协议编解码
- `src/ui/`：设置面板与页面交互
- `src/meta.ts`：userscript 与协议元信息
- `src/constants.ts`：默认配置与运行时常量

## 协议 / 版本兼容

当前版本基线：

- userscript：`0.4.9`
- 协议版本：`0.6.1`
- 最低兼容协议版本：`0.6.1`

共享 ProtoBuf 协议源位于：

- `third_party/TeamViewRelay-Protocol/proto/teamviewer/v1/teamviewer.proto`

本地 TS 协议代码生成命令：

```bash
pnpm proto:generate
```

子模块与协议版本：

- 推荐使用 `git clone --recursive`
- 已有仓库可执行 `git submodule update --init --recursive`
- 当前依赖锁定在 `third_party/TeamViewRelay-Protocol` 的指定 commit，不会自动跟随远端更新

升级协议版本的常规流程：

```bash
git -C third_party/TeamViewRelay-Protocol fetch --tags
git -C third_party/TeamViewRelay-Protocol checkout proto/v0.6.1
git add third_party/TeamViewRelay-Protocol
pnpm proto:generate
pnpm build
```
