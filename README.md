# dsh-code-diff-viewer

让 DeepSeek Harness（dsh）Web 界面的 `edit` / `write` 工具调用，以**可折叠的「修改前 / 修改后」左右对照代码面板**呈现——带语法高亮、绝对行号、变更行红/绿底色，纯视觉注入对话流，不新建模式、不落盘任何文件。

> **母仓库声明**：本项目是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`，`@deepseek-ai/dsh`）的**第三方插件**，通过 dsh 的 profile bundle 机制（`dsh.bundle.patch` + `dsh.client` 双面插件）扩展其 Web 界面，并非 dsh 官方组件。

## 特性

- **左右对照**：同时有增有删 → 双列「修改前 / 修改后」；纯新增 → 单列绿色「新增」；纯删除 → 单列红色「删除」
- **绝对行号**：原厂 diff hunk 自带 3 行上下文，本插件通过 Host 端 `/cdv-locate` 读取文件反推每个 hunk 在文件中的真实起始行，文件中部（如第 20~30 行）的修改也能精确定位
- **语法高亮**：内置轻量分词器（JS/TS、Python、CSS、HTML、Shell、JSON、YAML 等），关键字蓝、字符串绿、数字浅蓝、类型紫、属性白
- **可折叠**：点击卡片头部展开/收起；最新一次修改自动展开，旧卡片保持收起
- **纯视觉**：只注册 `tool.call.toolview` 槽位的 `edit` / `write` 键，替换原厂卡片；Host 半仅提供一个只读定位接口
- **进程级自动启用**：作为静态 bundle 层挂载，dsh 启动即生效，无需审批

## 效果示意

```
▸ Edit · src/config.ts                    [+11 −11]  完成
  ┌───────────────┬─────────────────────┐
  │ 修改前        │ 修改后              │
  │ 17  const c…  │ 17  const c…        │
  │ 20− key20…    │ 20+ key20-updated…  │
  │ 21− key21…    │ 21+ key21-updated…  │
  │ …             │ …                   │
  └───────────────┴─────────────────────┘
```

## 安装

要求：已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh` CLI）与 `pnpm`，使用 `web` profile。

### 方式一：从 GitHub 安装（推荐）

```bash
dsh plugin --profile web add github:kelai141/dsh-code-diff-viewer
# 或
dsh plugin --profile web add https://github.com/kelai141/dsh-code-diff-viewer.git
```

`dsh plugin` 会执行 pnpm 安装，并自动把 `dsh-code-diff-viewer` 加入 profile 的 `dsh.profile.bundles` 层（包内的 `cordis.patch.yml` 声明了组合行 `code-diff-viewer`）。

> git 托管的插件若被 pnpm 拦截构建脚本（本项目无构建脚本，一般不会触发），按 pnpm 提示在 `profiles/web/pnpm-workspace.yaml` 的 `allowBuilds` 中加入对应 key 后重试。

### 方式二：本地开发 / 源码安装

```bash
git clone https://github.com/kelai141/dsh-code-diff-viewer.git
dsh plugin --profile web add file:D:/coding/dsh-code-diff-viewer   # 改成你的实际路径
```

### 方式三：手动补丁（不经过 pnpm）

把包放到任意可被 profile 解析的位置（例如 `profiles/web/node_modules/dsh-code-diff-viewer`），然后在 profile 的用户补丁 `profiles/web/cordis.patch.yml` 中追加：

```yaml
- insert:
    - id: code-diff-viewer
      name: 'dsh-code-diff-viewer'
```

并在 `profiles/web/package.json` 的 `dsh.profile.bundles` 中加入 `dsh-code-diff-viewer`。

## 启用

安装后**重启 dsh web 进程**（组合行在启动时加载，无热更新）：

```bash
# 停止旧的 web 进程后
dsh web
```

刷新浏览器后即可生效：对话流中所有 `edit` / `write` 工具卡片都会渲染为可折叠的对照面板。无需任何授权/审批（静态组合行是受信代码）。

## 验证

- 组合树包含新行：`dsh --profile web --dump-config | grep code-diff-viewer`
- 客户端包可访问：`http://127.0.0.1:3080/plugins/dsh-code-diff-viewer/client.js`
- 定位接口（Host）：`POST /cdv-locate`，请求体 `{ "path": "<文件绝对路径>", "needle": "<hunk newText>" }`，返回 `{ "start": <1-based 起始行> | null }`

## 卸载

```bash
dsh plugin --profile web remove dsh-code-diff-viewer
```

重启 dsh web 后界面恢复原厂卡片。

## 工作原理

1. dsh 的 `edit` / `write` 工具在结果中携带真实 diff hunk（`oldText` / `newText`，jsdiff `structuredPatch(context: 3)`，每个 hunk 带 3 行上下文）
2. 客户端插件读取工具调用块（`ToolCallBlock`）的 `callView` / `resultView`，取 `card: 'diff'` 的 `diffs`
3. 行级 LCS 对齐两侧内容，纯增/纯删/混合自动选择单列或双列
4. 通过 Host 半的 `/cdv-locate` 在磁盘文件（修改后状态）中反推 hunk 绝对起始行，渲染真实行号
5. 轻量正则分词器做语法高亮；卡片头部可折叠，最新调用自动展开

## 仓库结构

```
dsh-code-diff-viewer/
├── cordis.patch.yml     # bundle 层补丁：insert 组合行
├── package.json         # 双面插件声明（dsh.bundle.patch / dsh.client）
└── lib/
    ├── index.js         # Host 半：POST /cdv-locate 只读定位服务
    └── client.js        # Client 半：__ModuleLoader__ 浏览器包（编辑/写入工具卡片）
```

## 兼容性

- dsh（DeepSeek Harness）`web` profile，Node.js ≥ 22
- 无第三方运行时依赖；客户端仅依赖 dsh 自带的 `react` seed 模块与 `slots` 服务

## License

[MIT](./LICENSE) © 2026 kelai141

第三方项目声明：DeepSeek Harness（[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)）是其开发者们的作品，本项目仅作为其生态插件独立开源，与官方无隶属关系。
