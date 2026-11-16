# PDF 全能工具台 · DSH 插件

DeepSeek Harness（DSH）里的本地 PDF 工作台：左侧导航 + 中央操作区 + 右侧结果预览，
4 大模块 **29 项功能**，全部处理在本机完成；文件处理完 24 小时自动清除。

| 模块 | 功能 |
|---|---|
| 格式转换 | PDF ⇄ Word / Excel / PPT / 图片 / 文本；Word、Excel、PPT、图片、TXT 批量转 PDF |
| 文档编辑 | 合并、拆分、压缩、加密/解密、旋转、删除、提取、插入空白页、添加页码 |
| 页面排版 | 单文档页面尺寸调整、多文档批量统一尺寸、白边智能裁剪 |
| 内容提取 | OCR（中英）、图片批量提取、目录结构提取、水印添加 |
| AI 智能处理 | 摘要、基于原文的问答、全文翻译、纠错润色、信息结构化提取 |

- PDF 引擎：PyMuPDF（矢量优先，改纸张不糊字），23 个操作
- AI：走 DSH 当前选中的模型（设置 → 模型），无需另填 API Key
- 限制：单文件 ≤ 100 MB，单次 ≤ 20 个文件，单次总量 ≤ 300 MB，结果保留 24 小时

## 目录结构

```
.
├── index.js               Host 插件：/api/pdf-workbench/* 路由、任务队列、AI 管线
├── catalog.js             29 项功能的单一事实来源（前端据此渲染，Host 据此校验）
├── client.js              浏览器端工作台（window.__ModuleLoader__ 模块，手写 React）
├── client.selftest.mjs    客户端自测（64 项，纯 Node，可在 CI 跑）
├── engine/
│   ├── pdf_engine.py      PDF 引擎（子进程运行）
│   ├── selftest.py        引擎自测（43 项，覆盖 23 个操作）
│   └── runtime/           ← 不入库，由 scripts/bootstrap.sh 生成
├── tests/                 Host 集成（48 项）与 AI 管线（31 项）测试
├── scripts/               bootstrap.sh / verify.sh
├── docs/                  USAGE.md（使用说明）、DETAIL.md（插件详情页）
├── locale/                en / zh 展示元数据
└── requirements.txt       Python 侧依赖（固定版本）
```

**仓库里只有源码**。Python 依赖（约 490 MB）和重签名解释器不提交，用脚本生成 ——
GitHub 上 clone 下来不到 1 MB。

## 安装

### 方式 A：从 GitHub 直接安装（推荐给"只使用"）

1. DSH 打开 **设置 → 插件 → 添加插件**
2. 填 GitHub 规格，任选其一：
   ```
   github:你的用户名/pdf-workbench
   https://github.com/你的用户名/pdf-workbench
   ```
3. 安装成功后，初始化 Python 侧（只做一次）：
   ```bash
   git clone https://github.com/你的用户名/pdf-workbench.git   # 任意位置
   cd pdf-workbench
   bash scripts/bootstrap.sh
   ```
   > 从 GitHub 装的包目录是只读的安装产物，依赖会装到
   > `~/.dsh/pdf-workbench-runtime/`；插件会优先读取同目录的 `engine/runtime/`，
   > 不存在时回退到这个位置。

### 方式 B：本地开发（推荐给"改代码"）

```bash
git clone https://github.com/你的用户名/pdf-workbench.git
cd pdf-workbench
bash scripts/bootstrap.sh          # 装 Python 依赖 + 生成 engine/runtime
```

然后在 DSH：**设置 → 插件 → 添加插件**，填这个目录的**绝对路径**，例如
`/Users/你/Documents/pdf-workbench`。安装后是 `link:` 关系，之后改文件不用重装。

### `bootstrap.sh` 做了什么

1. 找到 DSH 自带的 CPython（`$DSH_HOME/dsh-runtimes/*/dependencies/python`）
2. 复制 `python3.12` 到 `engine/runtime/python/`，并 `codesign --force --sign -` 重签
3. `pip install -r requirements.txt --target engine/runtime/pylib`
4. 跑一次 engineself-check

**第 2 步为什么必要**：DSH 的解释器带 hardened runtime，macOS 的库校验会拒绝加载
pip 装的原生扩展（`pymupdf/_mupdf.so`、onnxruntime）。重签后去掉 hardened runtime
即可加载，同时用 `PYTHONHOME` 复用原标准库和站点包，不额外占空间。

可用环境变量：`PDFW_RUNTIME_DIR`（依赖目录）、`PDFW_PYTHON_ROOT`（DSH 解释器根）、
`PDFW_PIP_INDEX`（默认清华镜像）。

## 日常更新

```bash
cd pdf-workbench
git pull
bash scripts/bootstrap.sh     # 只有 requirements.txt 变了才需要
```

然后：

- **改了 `index.js` / 引擎** → 退出并重开 DeepSeek Harness（Host 侧 JS 只在启动时加载）
- **只改了 `client.js`** → 刷新页面即可（⌘R；没变化用 ⌘⇧R）

判断当前页面跑的是哪一版：看左栏品牌名下方，形如 `PDF 工具台 · v1.1.2`。

## 本地开发工作流

| 改了什么 | 如何生效 |
|---|---|
| `client.js`（界面） | 刷新页面。该模块在页面加载时执行一次，Host 重装不会热替换它 |
| `index.js`（路由/任务/AI） | 重开应用 |
| `engine/pdf_engine.py` | 下一次任务自动生效（每次任务起一个新进程） |
| `catalog.js` | 加/改功能时同步改；它同时驱动前端表单与 Host 校验 |
| `locale/*`、`icon.svg`、`docs/*` | 重开应用后在插件详情页看到 |

**加一个新功能**：在 `catalog.js` 加一条 op（分组、字段、默认值）→ 在
`engine/pdf_engine.py` 的 `OPS` 表注册同名 `engine` 处理函数 → 跑 `verify.sh`。
前端不需要改，参数面板按字段声明自动渲染。

## 验证

```bash
bash scripts/verify.sh          # 全部四套（需要先 bootstrap）
bash scripts/verify.sh --quick  # 只跑语法 + 客户端自测（不需要 Python）
```

| 套件 | 内容 |
|---|---|
| `client.selftest.mjs` | 64 项：槽位注册、29 个 op × 中英双语离线渲染、传输层、CSS 分词防回归 |
| `engine/selftest.py` | 43 项：23 个操作的真实文件处理（含加解密正反例、批量失败隔离、OCR） |
| `tests/host-smoke.mjs --engine` | 48 项：multipart 上传 → 引擎 → 下载 → 预览全链路，含三项排版功能 |
| `tests/ai-smoke.mjs` | 31 项：用桩模型验证摘要/多轮问答/翻译/表格提取/长文分段/失败路径 |

GitHub Actions 只跑不需要 Python 的部分（语法、清单、客户端自测）。

## 版本约定

- 改客户端行为时**同时**递增 `package.json` 的 `version` 与 `client.js` 的 `CLIENT_BUILD`
- 在 `CHANGELOG.md` 记一笔
- 准备发布时：`git tag v1.1.2 && git push --tags`

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 插件图标没有出现 | 插件未启用，或安装后没重开应用 |
| 面板显示"接口返回错误状态 404" | Host 路由没注册成功：看 `<tmp>/dsh-pdf-workbench/diag.log`，通常是路由冲突或引擎加载失败 |
| 提示 "PDF 引擎组件 PyMuPDF 未安装" | 没跑 `scripts/bootstrap.sh`，或 DSH 升级换了 Python 版本 → 重跑 bootstrap |
| OCR 提示不可用 | 同上；OCR 用 rapidocr（中英），不需要额外系统组件 |
| Office 转 PDF 失败 | 需要本机安装 LibreOffice；`/Applications/LibreOffice.app` 会被自动发现 |
| 界面没样式、按钮是系统原生样式 | 客户端模块是旧的：⌘⇧R 强制刷新；仍不行看 Console 是否有 CSS 解析报错 |

## 许可

未声明许可证 = 保留所有权利。要开源请自行添加 `LICENSE`（MIT 常用）。
注意项目内含的第三方依赖遵循各自许可（PyMuPDF 为 AGPL-3.0，商用前请确认）。
