# 节点结果表格视觉验收

**Source visual truth**

- 用户在当前对话附带的第 1 张测速表截图：原始尺寸 2048 × 1462 px。
- 用户在当前对话附带的第 2 张 AI / 流媒体截图：原始尺寸 2048 × 1280 px。

**Implementation captures**

- 测速表：[src-tauri/target/table-update/design-qa-speed.png](src-tauri/target/table-update/design-qa-speed.png)
- AI / 流媒体表：[src-tauri/target/table-update/design-qa-unlock.png](src-tauri/target/table-update/design-qa-unlock.png)
- 使用 Chrome DevTools 打开本机预览 `http://127.0.0.1:4173/` 截图。浏览器设备像素比为 1。

**Viewport and state**

- 测速表：2048 × 1309 CSS px / 截图像素。浏览器将窗口高度限制在 1309 CSS px；与源图按可见表格区域比较。
- AI / 流媒体表：2048 × 1280 CSS px / 截图像素，与第 2 张源图同尺寸。
- 两张实现图均使用 20 行 DOM 临时样例数据，专用于视觉比较；没有运行节点测试、发起外部测试请求或改写应用数据。
- 截图包含 all2uri 原有输入区、输出区和底部日志区；参考图只展示结果表，因此全屏边框布局不作一比一比较。

**Full-view comparison**

- 两个视图保留序号、节点名、协议、RTT 与 HTTP 延迟等共用字段。测速视图显示平均 / 峰值速度、逐秒柱状图与链路类型；解锁视图把 Netflix、YouTube、Disney+、TikTok、OpenAI、Gemini、Claude 放在前面，其他启用的服务接在右侧并可横向滚动。
- 结果区采用细网格线、浅色表头、约 40 px 行高和浅色状态填充，表格密度与参考图接近。参考图上的品牌水印没有带入应用界面。
- app 的左右分栏及底部日志区会减少首屏可见行数；表格区域仍可纵向滚动。解锁检测保留比参考图更多的服务列，所以需要横向滚动查看后续列。

**Focused region comparison**

- 测速表头、RTT / HTTP 延迟青绿色热度、平均 / 最大速度蓝色热度和逐秒柱状图均在 `design-qa-speed.png` 中核对。
- 解锁表的服务列顺序、成功绿 / 失败红 / 未知青 / 未测灰状态色和底部解锁率在 `design-qa-unlock.png` 中核对。
- 两张结果图使用同一应用字体栈；表格文字为 16 px、表头 16 px，列标题将 YouTube Premium、ChatGPT / OpenAI、Google Gemini 缩短为 YouTube、OpenAI、Gemini，以匹配参考图并减少横向占宽。

**Fidelity surfaces**

- **字体与排版：** 使用项目现有系统无衬线字体；16 px 单行正文与表头在 40 px 行内居中，节点名保持较高字重。无额外截断或文字换行问题。
- **间距与节奏：** 使用固定列宽、约 40 px 行高、单像素网格线和紧凑表头；长表由表格容器滚动，不遮挡底部测试操作区。
- **颜色与状态：** 延迟使用青绿色渐变、吞吐量使用蓝色渐变，解锁 / 失败 / 未知 / 未测分别使用绿 / 红 / 青 / 灰，语义与参考图一致。
- **图像与资产：** 参考图没有需要复用的产品图片或图标；速度柱状图由真实测试采样数据生成，不以装饰图替代图像资产。
- **应用文案：** 节点地区和链路类型保留项目实际测出的含义。参考图的 UDP 类型（FullCone / Unknown）不是当前链路类型探测的输出，因此没有把直连 / 中转伪装成 UDP 类型。

**Findings**

- 没有剩余的 P0 / P1 / P2 视觉问题。
- 保留的产品语义差异：参考图包含 UDP 类型，当前应用表格显示链路类型；追加真正的 UDP NAT 类型结果需要另行增加相应探测。

**Open Questions**

- 无阻塞问题。

**Comparison history**

1. 初次浏览器对照发现表格正文 / 表头偏小，且服务名比参考图长。将字体由 14 / 13 px 调整为 16 / 16 px，行高定为 40 px，并缩短三个主服务列名。
2. 在相同 AI / 流媒体视口和相同测速视口重新渲染并保存两张截图。复核状态颜色、列顺序、表头、热度格和柱状图后，没有剩余 P0 / P1 / P2 项。

**Implementation Checklist**

- [x] 测速结果表格与热度 / 逐秒图表
- [x] AI / 流媒体分栏与状态色
- [x] 同视口浏览器截图和焦点区域复核
- [x] 检查浏览器控制台：无消息

**Follow-up Polish**

- 可在后续加入独立 UDP NAT 类型探测，再显示 FullCone 等状态。

final result: passed
