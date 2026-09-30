---
name: 有据团队后台
description: 面向连续工单处理的中性白灰界面
colors:
  surface: "#ffffff"
  canvas: "#f7f8fa"
  selected: "#f0f1f3"
  border: "#e5e8ec"
  input: "#c7ced6"
  ink: "#20252b"
  strong: "#454f5c"
  muted: "#626c78"
  primary: "#315f80"
  success: "#376744"
  success-background: "#edf6ee"
  warning: "#805e20"
  warning-background: "#fbf5e6"
  danger: "#a13e38"
  danger-background: "#fbefee"
typography:
  title:
    fontFamily: "Noto Sans SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: "Noto Sans SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "14px"
  label:
    fontSize: "12px"
  code:
    fontFamily: "Cascadia Code, Consolas, monospace"
    fontSize: "12px"
    lineHeight: 1.7
rounded:
  badge: "3px"
  control: "4px"
  container: "6px"
  navigation: "8px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
    height: "36px"
  input:
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "4px 12px"
    height: "36px"
  navigation-active:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.ink}"
    rounded: "{rounded.navigation}"
    padding: "12px"
  status-neutral:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.strong}"
    rounded: "{rounded.badge}"
    padding: "2px 8px"
  evidence-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "0px"
    padding: "10px 0"
---

# Design System: 有据团队后台

## Overview

员工后台使用中性白灰主题。客户角色和客户入口 `/workbench` 不应用该覆盖。工作台采用 Operate 模式，以查阅、切换和处理工单为主要任务。三栏组成仅属于工单工作台，其他后台页面保留既有布局。

**Key Characteristics:**

- 中性白灰与细线分区
- 紧凑排版和小圆角
- 真实状态与明确操作反馈

## Colors

### Primary

克制蓝用于链接与主按钮。

### Neutral

主面板白承载内容，浅灰画布承载次级背景和客户气泡，选中灰用于工单与导航。墨灰用于正文，中灰用于辅助文字。边框灰用于分区，输入灰用于控件边界。成功、等待和失败配合文字采用小面积语义色，处理中使用中性灰。

样式源为 src/app/staff-theme.css。通过根节点 data-theme 控制作用域，弹窗与页面共享令牌。旧客户主题作为默认值保留。

## Typography

字体与字号见 frontmatter。正文采用 Noto Sans SC，缺字由 Microsoft YaHei 与系统字体补齐。标题、正文和辅助标签保持清晰层级，时间线时间和状态另使用较小字号（11px）。代码采用等宽字体。

## Layout

工作台全局导航默认宽 64px，可展开。工单队列初始宽 280px，两处分隔线可拖动与键盘调整。中栏和右栏分配剩余空间，初始比例为 58 比 42。右栏可收起。

中栏固定顶部摘要和底部编辑区，对话独立滚动。右栏默认调试视图，参数与结果展开，业务视图保留订单与政策依据。历史浏览暂停自动跟随。

视口宽（761–1250px）时右栏放到会话下方，会话右侧分隔条隐藏，队列右侧分隔条跨两行。视口不超过（760px）时分步展示队列与详情，隐藏分隔条，导航横向排列。

## Elevation & Depth

优先使用细线和背景差异分区，不增加渐变或装饰性阴影。保留选中工单的内描边与可见焦点环；基础输入框和 outline 按钮仍继承既有轻微阴影。

## Shapes

圆角见 frontmatter。工作台主分区为直角，依据区域使用底部分隔线。导航保留既有圆角，主题令牌不代表覆盖其他页面所有硬编码圆角。

## Components

主按钮使用克制蓝，次按钮使用灰底，ghost 按钮保持透明默认态；悬停与焦点均有反馈。输入框采用细边界，保留错误、禁用与提交中状态。运行徽章使用文字、小圆角与浅底，状态不能仅靠颜色表达。导航选中使用灰底、深字和字重。工作台依据条目不叠加装饰卡片。分隔条可拖动与键盘调整，悬停和聚焦时加深。

保留加载、空态、请求错误、断线、权限禁用和结案阻塞。草稿仅在当前页面内按工单和用途保存，身份切换清空。真实页面验证记录及截图位于本次会话的 visualizations 目录。

## Do's and Don'ts

### Do:

- **Do** 用中性白灰、细线、字重和对齐建立层次。
- **Do** 为状态与选择提供文字或形状反馈。

### Don't:

- **Don't** 增加大面积蓝背景、橘色品牌色、棕色正文、渐变或装饰性阴影。
- **Don't** 将员工主题覆盖到客户角色或客户入口。
- **Don't** 用虚构数据填充界面或将工具成功表述为业务完成。
