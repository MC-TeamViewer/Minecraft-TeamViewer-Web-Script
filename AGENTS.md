# Repository Guidelines

## Protocol Dependency

- 共享协议源来自 `third_party/TeamViewRelay-Protocol`
- 本仓库不能重新创建、复制或手改 `.proto`
- submodule 是被当前仓库 commit 锁定的依赖，不会自动跟随协议仓库远端更新

## Protocol Upgrade Workflow

1. `git -C third_party/TeamViewRelay-Protocol fetch --tags`
2. `git -C third_party/TeamViewRelay-Protocol checkout proto/vX.Y.Z`
3. `git add third_party/TeamViewRelay-Protocol`
4. `pnpm proto:generate`
5. `pnpm build`

如果协议变更影响字段或结构，必须同步检查 `src/network/messageCodec.ts`、`src/network/networkSchemas.ts` 和 README。
如果只是改前端业务逻辑，不要顺手升级协议 submodule。

## AI Guidance

- 默认把 `third_party/TeamViewRelay-Protocol` 当作只读依赖。
- 遇到协议相关故障，先检查 submodule 初始化、锁定 commit 和生成代码是否同步。
- 不要把“同步最新协议 main”当作修复手段。
