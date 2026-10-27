# 迭代路线与交接说明

给接手的开发者（或 Agent）：先读 README 了解整体，再看这里的「已完成」和「下一步」。

## 已完成（2026-10-27）

- **交付页**：`apps/web/src/components/Delivery.tsx`
  - 状态：`useStore.deliveryGoal`
  - 接口：`GET /api/goals/:id/files`
  - 文件预览：`/preview/<key>/…`，key 见 `Snapshot.previewBase`
- **成本账本与预算**：`apps/server/src/usage.ts`
  - 在 `agent/runtime.ts` 的主循环和 `llm/index.ts` 的 `completeAs` 里记账
  - 推送 `ServerMsg { t: 'usage' }`
  - 预算请示是带 `budget` 字段的 `Approval`，在 `workflow.onApprovalDecided` 里处理
  - 超预算的目标：`factory.candidates` 和 `wf.takeJob` 跳过它，正在做的员工停在 `waitWhilePaused` 里
- **前端成本面板**：`apps/web/src/components/CostPanel.tsx`（顶栏 `CostChip` + `CostModal`）
- **任务耗时**：`Task.startedAt` / `finishedAt` 由 `store.updateTask` 自动维护

- **公司规则**：
  - 后端 `apps/server/src/settings.ts`，接口 `POST /api/settings`，推送 `ServerMsg { t: 'settings' }`。
  - 审批路由在 `agent/runtime.ts` 的 `execTool`，验收开关在 `workflow.finalizeGoal`。
  - 超时扫描 `settings.sweep()` 每 30 秒执行一次，自动决定的审批 `decidedBy='system'`、`autoDecided=true`。
- **批量审批**：`POST /api/approvals/batch`，只处理 `kind=tool`。前端在 `Inbox.tsx` 的 `BatchBar`。
- **消息推送**：`apps/server/src/notify.ts` 监听 bus 事件并去重推送；前端设置面板在 `components/Rules.tsx`。

- **钉钉机器人与 IM 通道注册表**：
  - 抽象通道层：`apps/server/src/im/index.ts`（`ImRegistry` + `ImAdapter` 接口），解耦通知与具体 IM 平台。
  - 指令层：`apps/server/src/im/commands.ts` 支持 `状态`、`待批`、`批准`、`驳回`、`验收`、`打回`、`追加预算`、`目标`、`详情`（含已决定审批和目标子任务）、`交付 [目标编号]`（直接在钉钉内返回 Markdown 成稿全文）、`暂停`/`继续`。
  - 钉钉适配器：`apps/server/src/im/dingtalk.ts` 基于 `dingtalk-stream` SDK 的 Stream 模式。

- **高可用、可靠与 PostgreSQL 持久化**：
  - Docker PostgreSQL：`docker-compose.yml`（`agent-factory-postgres`，端口 `5433:5432`）。
  - 数据库存储层：`apps/server/src/db.ts` 自动建表（`af_tasks`、`af_approvals`、`af_conversations`、`af_meetings`、`af_jobs`、`af_kv`、`af_events`），首次启动自动从 `data/*.json` 平滑迁移至 PostgreSQL，同时保留本地原子写（`.tmp` -> `renameSync`）双写备份。
  - 队列持久化与重启自愈：`workflow.jobs` 持久化至 `af_jobs`，服务重启时 `factory.rebuildJobs()` 自动恢复待处理作业并巡检 `in_progress` 目标的汇总状态。
  - LLM 护栏与超时熔断：`apps/server/src/llm/openai.ts` 增加单次流式总超时（180s）与分片空闲看门狗（45s），支持主模型失败自动切换 `LLM_FALLBACK_MODEL`；`agent/runtime.ts` 增加重复无效调用检测与末轮强制收敛总结。
  - 浏览器资源回收：`apps/server/src/tools/browser.ts` 跟踪最后活跃时间，空闲超过 3 分钟自动关闭 Playwright `BrowserContext` 释放内存。

- **交付体验与成本优化**：
  - 极速成稿快车道：单文件/短平快目标由经理一键派单直达执行岗，免除冗余评审轮次（实测 800 字小红书文案从 104 次调用/¥2.25 降至 5 次调用/¥0.057）。
  - 自动产物发现：`submit_for_review` 时通过 `git status --porcelain -uall` 自动补齐命令行/脚本生成的产物文件。
  - 交付页增强（`Delivery.tsx`）：支持一键 **打包下载 (ZIP)**（`GET /preview/<key>/__archive/:id.zip`）、对单文件发起 **✨ 局部微调**（`POST /api/goals/:id/revise` 直接唤醒原执行员工修改指定文件）、增强 Markdown 渲染（支持表格、相对路径图片、链接）与一键复制全文。
  - 成本面板增强（`CostPanel.tsx`）：`usage.ts` 新增 `byDayAgent` 与 `byModel` 统计，支持按「今日 / 近 7 天 / 累计」切换员工花费明细及展示多模型调用分布。

- **模块化架构**：
  - 工具插件注册表：`apps/server/src/tools/registry.ts` 统一管理内置工具与 `company/tools/*.json` 声明式自定义 HTTP/MCP 工具，支持按角色 `RoleDef.tools` 动态授权。
  - 岗位技能包（Role Skills）：`apps/server/src/skills.ts` 加载 `company/skills/<id>/SKILL.md`（内置 `xiaohongshu-copywriting`、`clean-web-dev`、`qa-verification`），按角色 `RoleDef.skills` 自动注入提示词。
  - 多模型路由：支持在 `RoleDef.model` 按岗位指定 `fast` / `strong` 或具体模型名。
  - 多公司模板：新增 `company/profiles/content-studio.json`（新媒体内容工作室），可与软件研发公司一键切换。

## 本地验证方法

```bash
# 演示模式后端（不消耗 token），用独立的数据目录
cd apps/server && LLM_PROVIDER=mock WORKSPACE_DIR=/tmp/af-ws DATA_DIR=/tmp/af-data PORT=8790 pnpm exec tsx src/index.ts
# 前端指向它
SERVER_PORT=8790 pnpm --filter @af/web exec vite --port 5174
# 类型检查
pnpm --filter @af/server exec tsc --noEmit -p . && pnpm --filter @af/web exec tsc --noEmit -p .
```
