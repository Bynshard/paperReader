# 内置 BabelDOC：Windows 便携版零安装全文翻译

## 背景

全文 PDF 原位翻译依赖 BabelDOC（Python CLI + 版式模型）。此前 Windows 便携包只带
了 rclone/Codex 等二进制，用户必须自己安装 Python、`pip install babeldoc` 并在设置里
选择 `babeldoc.exe`；否则第一次点“翻译全文”只会看到 `program not found`。这是“别人
电脑上没有环境”的硬缺口。

现在 Windows 包内置一套独立的 BabelDOC 运行时，用户无需安装 Python 或任何依赖。

## 做法

CI 在 Windows 打包机上执行 `scripts/prepare_babeldoc.py`，生成：

```
tools/windows/babeldoc/
  babeldoc.exe                 Rust 小启动器（转发参数给内嵌 Python）
  babeldoc_cli.py              调用 babeldoc.main.cli()
  runtime/
    python.exe                CPython 3.13.5 embeddable
    python313._pth            指向 Lib\site-packages
    Lib/site-packages/         BabelDOC 0.6.2 的 Windows/Python 3.13 依赖闭包
    *.dll                     VC++ 运行库（app-local）
  THIRD_PARTY_NOTICES.txt
  MANIFEST.json               tree_sha256 / 文件数 / 版本
```

打包时整个目录被复制到 `resources/bin/babeldoc/`，与 rclone、Codex 并列。

### 版本与来源

- BabelDOC `0.6.2`：与仓库验证过的 CLI 参数一致。
- CPython `3.13.5` embeddable（python.org，SHA-256 固定在脚本里）。
- 依赖闭包固定为官方 PDFMathTranslate-next v2.9.0（BabelDOC 0.6.2）Windows 便携版
  使用的版本，见 `scripts/babeldoc/requirements-win-py313.txt`；由 `uv` 以
  `--python-platform windows --python-version 3.13 --only-binary=:all:` 安装，确保
  全部是 cp313-win_amd64 wheel。

### 运行时查找顺序

`core/src/engine.rs`：

1. `MOONLIGHT_BABELDOC_BIN`（用户在设置里指定/环境变量）
2. 打包资源：`<resources>/bin/babeldoc/babeldoc.exe`
3. 仓库构建产物：`<root>/tools/windows/babeldoc/babeldoc.exe`
4. 开发环境：`.venv/Scripts/babeldoc.exe`（Windows）/ `.venv/bin/babeldoc`（Linux）
5. 系统 `PATH` 中的 `babeldoc`

因此正式包开箱即用；开发机仍可继续用 `.venv`；高级用户仍可在设置里覆盖外部版本。

### 首次翻译的模型/字体资源

内置的是**引擎与依赖**，不含 BabelDOC 的布局模型/字体资源包（约 100–200MB）。
第一次翻译时 BabelDOC 会自动下载并缓存；这一步本来就需要联网（翻译要调用模型
API），所以不影响“无需装 Python”的目标。若要完全离线首启，可在后续版本把官方
`offline_assets_*.zip` 一并内置（体积 +约 175MB 压缩）。

## 为什么内置运行时，而不是首次用 uv 安装

BabelDOC 官方推荐终端用户用 `uv tool install --python 3.12 BabelDOC`，应用只带一个
`uv.exe`（约 30MB），首次使用再下载 Python 与依赖。这个方案安装包小，但要求首次
翻译时能访问 PyPI/GitHub、耗时几分钟，并在用户目录多占约 700MB。

Moonlight 选择**内置运行时**，是为了“下载即用、别人电脑没有 Python 也不出现
`program not found`”。代价是 ZIP 增加约 215MB。若以后更在意安装包体积，可以改为
“内置 uv + 首次自动配置”，或做成“内置优先，缺失时 uv 兜底”的混合模式；引擎的
查找顺序已经预留了这两种扩展点。

## 构建与验证

CI（`.github/workflows/validate.yml`）：

1. `Download verified Windows runtimes`（rclone/Codex）
2. `Prepare bundled BabelDOC runtime` → `python scripts/prepare_babeldoc.py`
3. 打包：`app/electron/package.mjs` 复制 `tools/windows/babeldoc` 到 `resources/bin/babeldoc`
4. `scripts/verify_windows_package.py` 检查必需文件并实际执行
   `resources/bin/babeldoc/babeldoc.exe --version`，必须输出 `babeldoc 0.6.2`
5. `app/e2e/windows.mjs` 在真实打包应用里调用 `check_babeldoc`，验证
   `ok:true`、路径位于 `resources/bin/babeldoc`、版本为 `0.6.2`

本地不打包时可单独跑：

```powershell
python scripts/prepare_babeldoc.py
```

构建产物目录已加入 `.gitignore`（不提交二进制）。

## 体积

- 内置运行时：约 646MB 解压 / 约 215MB 压缩进 ZIP。
- Windows 便携 ZIP 因此从约 325MB 增至约 540MB。

## 许可证

BabelDOC 0.6.2 使用 **AGPL-3.0**。包内 `THIRD_PARTY_NOTICES.txt` 与
`site-packages/babeldoc-0.6.2.dist-info/licenses/LICENSE` 保留许可证全文，并注明
源码地址。Moonlight 以独立进程方式调用 BabelDOC。分发前请确认你接受 AGPL 的
源码提供义务；若不希望随包分发，可删掉内置目录，回退到“用户自备 BabelDOC”。

CPython（PSF-2.0）、MSVC 运行库与各 Python wheel 的许可证文件均保留在
`site-packages/*.dist-info/licenses/`。

## 维护

- 升级 BabelDOC：更新 `requirements-win-py313.txt`、`prepare_babeldoc.py` 中的
  `BABELDOC_VERSION`，重新生成依赖闭包；确认 CLI 参数（`--openai*`、`--no-dual` 等）
  仍兼容后再发布。
- 升级 Python：同时更新 `PYTHON_VERSION`、URL 与 SHA-256，并保证依赖轮子有对应
  cp3xx-win_amd64 版本。
- 依赖闭包可用官方 Windows 便携包的 `site-packages/*.dist-info` 重新推导；不要直接
  把整套 PDFMathTranslate 依赖塞进来（会多出 GUI/云存储等无关包）。
