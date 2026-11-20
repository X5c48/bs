# 物映 Wuying — 面向产品造型推敲的智能草图生成平台

> 毕业设计《面向产品造型推敲的智能草图生成平台交互设计研究》配套平台。
> 面向产品/工业设计师的网页工作台：概念造型起稿 → 改稿 → 实时渲染 → 3D 体块。

## 核心立论

把生成从"像素空间"搬到"结构空间"——以**部件-约束图 JSON** 为唯一真实数据源，锁定参数 = 冻结变量。这是对标 Vizcom 的核心差异。

## 功能地图

| 模块 | 说明 |
| --- | --- |
| 工作台 `dist/workbench.html` | 概念造型推敲主界面，部件-约束图驱动 |
| 图像工作室 `dist/image-studio.html` | Krea 式并排实时渲染 + Krita 式叠加视图，边画边出图；三档画质（速度/均衡/质量）、高清增强、暂停/历史帧、面板内切模型自动重渲、选区重绘、四方向扩图、方案主题（内部提示词锁定主体） |
| 造型工作室 `dist/shape-studio.html` | 草图 → 3D 体块（Three.js） |
| 文件台 `dist/files.html` | 项目与资产管理 |
| 后台管理 `dist/admin.html` | 出图服务配置（兼容 OpenAI Images API / apilio.ai 中转 / ComfyUI） |
| 服务端 `server/` | 概念 API、图像 API、RunningHub 适配、工作区存储 |

## 快速开始

```bash
# 1. 启动静态服务（8881）与出图后台（8882）
./打开物映.cmd          # 或 ./启动出图后台.cmd
# 2. 运行测试
node --test *.cjs
```

## 渲染后端

- **本机 ComfyUI**（推荐）：SD1.5 / CyberRealistic + Scribble/Lineart/Canny ControlNet 实时渲染；Qwen-Image-2.1 高质量出图（模型放 `D:\毕设\models`，挂载配置见 `comfy-extra-model-paths.yaml`）
- **Images API 兼容**：OpenAI 官方 / apilio.ai 中转，支持 `image` 与 `image[]` 两种字段格式
- **RunningHub**：云端工作流

## 技术要点

- 零构建静态站点，直接改 `dist/`
- 画布：自研（Perfect Freehand 笔刷 + fflate 打包 .ora）
- 3D：Three.js 0.180
- 实时渲染：`createLatestPreview` 保序出帧（`keepRunning` 模式）+ `liveSnapshot` 未落笔笔触合并，旧预览不覆盖新笔触
- 主题：`themeDirective` 把中文主题编译为英文内部提示词，恒定锁定主体结构

## 目录结构

```
dist/           前端（零构建静态站）
server/         Node 服务端（8881/8882）
tools/          工具脚本
test-*.cjs      单元测试（node --test）
comfy-extra-model-paths.yaml  ComfyUI 模型挂载配置
legacy-backup-2026-11-17/  旧版备份
```
