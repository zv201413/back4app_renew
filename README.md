# Back4app 多账号自动签到保活项目

基于 GitHub Actions 和 Playwright 的 Back4app Web Deployment 多账号自动化防休眠签到项目。支持高并发账号按批次灵活错峰执行，突破 6 小时硬性限制。

## 🌟 核心特色

- ✅ **批次错峰并发**：支持无限量账号，按批次串行，多批次之间延迟触发（真正节约 Actions 分钟数）。
- ✅ **智能防熔断断点续传**：安全运行 5.5 小时后自动挂起，并通过调用 GitHub CLI 自动触发下一波，实现无缝续传。
- ✅ **自适应应用名匹配**：智能解析 `APP_NAME_X` / `APP_NAME` 等多种 Secret 写法。
- ✅ **动态状态检测**：5秒短轮询探测 Redeploy 按钮，支持快速跳过已活跃的容器，不无脑干等。
- ⚠️ **GitHub Actions 限制**：由于 Actions 默认 `set -e`，脚本已修复 bash 陷阱，勿轻易更改 setup 中的算术运算。

---

## 前期准备

1. 准备好 Back4app 的注册邮箱 (`EML`) 和密码 (`PWD`)。
2. 确认你创建的 Web Deployment 应用名称（默认 `b4app`，如果不一致需记录下来）。

---

## 使用方法

### 第一步：Fork 本仓库
将本项目 Fork 到你的个人账号下。

### 第二步：配置 Secrets
进入仓库的 `Settings` -> `Secrets and variables` -> `Actions`，配置以下环境变量：

#### 单账号模式
| Secret 名称 | 必填 | 说明 |
|:---|:---:|:---|
| `EML` | ✅ | Back4app 登录邮箱 |
| `PWD` | ✅ | 登录密码 |
| `APP_NAME` | ❌ | 应用名称（默认为 `b4app`） |

#### 多账号模式（支持无限叠加）
| Secret 名称 | 必填 | 说明 |
|:---|:---:|:---|
| `EML_1`, `EML_2` ... | ✅ | 账号 1, 2... 的邮箱 |
| `PWD_1`, `PWD_2` ... | ✅ | 账号 1, 2... 的密码 |
| `APP_NAME_1`, `APP_NAME_2` | ❌ | 指定对应账号的应用名称。不填则使用全局 `APP_NAME`，再没有则用 `b4app` |
| `TG_TOKEN` | ❌ | Telegram Bot Token（用于接收成功/失败通知） |
| `TG_ID` | ❌ | Telegram 用户 ID |
| `PROXY_URL` | ❌ | Sing-box 支持的订阅链接（如遇到风控可开启代理） |

### 第三步：运行与参数配置
- **自动触发**：北京时间 06:00 自动执行（Cron: `0 22 * * *`）。
- **手动触发**：Actions → 选中工作流 → Run workflow，可配置以下参数：
  - `T`: 执行轮次（默认 12 轮）。
  - `batch_size`: 每台 Runner 并发处理的账号数量（默认 1）。
  - `batch_delay`: 批次间启动的间隔分钟数（默认 30 分钟）。
  - `start_round`: 起始轮次（1=全新开始并清理残留，0=从状态文件智能续接）。

---

## 运行逻辑

| 场景 | 行为 |
|:---|:---|
| **首轮启动** | 根据 `batch_delay` 错开各批次的启动时间，批次内账号无缝串行。 |
| **状态探测** | 点击进入应用面板后，5秒内探测是否有 `Redeploy App`。无则认为存活，跳过部署。 |
| **防超时续传** | 当运行超过 5.5 小时，脚本保存当前轮次至 `status_batch_X.json`。由 Batch 0 触发全新的 workflow，并携带 `start_round=0` 续传。 |
| **清理残留** | 当手动指定 `start_round=1` 时，会主动删除旧的 `status_batch_X.json` 防止脏数据干扰。 |

---

## Telegram 通知说明

| 图标 | 状态 | 说明 |
|:---:|:---|:---|
| ✅ | 成功 | 表示 Deploying 检测成功或应用本来就处于活跃状态。 |
| ❌ | 失败 | 发生错误（如密码错、UI 变更、超时），并附带错误截图。 |
| ⏳ | 提醒 | 系统日志中的状态，暂不发送 TG，仅在日志中呈现进度。 |

---

## 常见问题

### Q1: 为什么我的第二个账号没有找我配置的 APP_NAME？
A1: 请检查 Secrets 命名是否规范。脚本会自动探测 `APP_NAME_2`、`APPNAME_2` 或全局 `APP_NAME`。如果在 Action 日志开头看到 `🔑 检测到与 APP 相关的 Secrets: 无`，说明 GitHub 没有正确读取到你配置的 Secret 名称，请重新配置。

### Q2: 为什么日志中提示 `发现 N 个账号` 但 Action 马上就报错 `Exit code 1` 退出了？
A2: 请勿随意修改 `renew.yml` setup 阶段中的 bash `((batch++))` 等循环运算。GitHub Actions 默认开启 `set -e` 严格模式，算术运算为 0 会引发报错退出。

---

## 🌟 特别鸣谢

感谢 GitHub Actions 和 Playwright 提供的强大自动化运行环境。
