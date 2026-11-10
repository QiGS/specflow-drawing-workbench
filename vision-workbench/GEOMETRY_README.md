# 中文参数与图纸部位关联

`geometry.py` 直接读取原 PDF 或图片，使用模型识别标注对应的物理部位。原先六字段的 `geometry-1.0` 仍可校验，新调用使用 `geometry-2.0`。`parameter-catalog.json` 包含业务提供的 115 类中文参数定义；它是识别词表，不是已经识别成功的 115 个值，也不表示每个零件都具有这些特征。

## 使用

先在本机服务进程环境中配置模型凭据，再调用：

```sh
python geometry.py --document /path/drawing.pdf --page 1 --output /path/new-geometry-run
```

已有同文件同页的第一阶段标注可以加 `--stage-one /path/result.json`。省略时直接使用原图，不构造或伪装已校验的第一阶段结果，审计记录 `stage_one_used:false`。输出目录必须是新目录。

本机工作台：上传原文件 → **识别参数与部位（115 类）** → 点击结果定位 → 导出几何 JSON。上传后可直接运行，也可先提取/导入已有标注作为附加上下文。每次识别发送当前页给服务端配置的模型。浏览器不能覆盖本地路径、模型端点、凭据或附加提示。

默认提供整页及四张重叠的局部细节图；局部图从原页面确定性裁出，覆盖范围分别是左右、上下的 60%，保留实际裁剪区域、图像散列和像素尺寸。返回位置始终使用完整原页的归一化坐标。`Config.max_images=1` 可只发送整页；所有图片总量受 `max_image_payload_bytes` 限制，超限直接报错。局部图没有补画或生成不存在的细节。

## 结果约定

- 中文类别来自固定词表；每个实例具有独立 `id` 和中文 `instance_label`，同类尺寸可分别属于不同零件、视图或工作状态，不能合并成一个值。
- 保留原文、数值、公差、单位、极限修饰、来源观察及近似位置。英文字母只在原始证据和单位中保留；模型解释、部位及视图使用中文。
- `candidate` 是待复核候选；`not_provided`、`not_applicable`、`ambiguous` 分别表示未提供、不适用、关系不明确。不生成 115 张虚假的“已识别”卡片。
- 对象难以判断的可读标注放入 `unmapped_annotations`，不会硬塞进分类。
- 一般尺寸需要图中对象区域与尺寸端点。明确文字说明（例如舌片厚度、绝缘外径或截面积）可以使用 `explicit_note`，无可靠位置时不造对象框或引线。
- 面积 / AWG 不能冒充绝缘外径；`mm` 不从 `mm²` 中截取。单位不明确时留空，不从小数位数、行业习惯或括号猜英寸。孔中心至端面的距离不能作为零件总长。

`result.json` 可导入静态网页；`audit.json` 保存本机脱敏调用记录。格式与引用检查不能证明模型的物理部位关联、原文抄读或坐标正确。原始材料可能不足以确定封闭 3D 几何，更不足以单凭尺寸批准工艺复用。模型不生成可执行 CAD 代码，不补造隐藏轮廓、扭矩或工艺条件。

## 校验

```sh
python -m unittest test_geometry test_geometry_v2 test_geometry_http
```

测试包含旧格式兼容、重复类别的多个对象、中文语义、未提供状态、原始文件绑定、文字说明、线规与线性尺寸区分、原文数值与单位引用、局部图坐标、直接原图调用以及本机路由的来源/会话约束。HTTP 用例需允许本机回环端口。单元测试使用合成标注或模拟模型响应，不能作为真实识别率统计。

公开静态网页与本机工作台仍是两个独立运行环境，通过结果 JSON 衔接。本模块不在网页前端保存或请求模型密钥，不会把本机诊断凭据部署到云端。

## 本机文字说明补充（不调用模型）

已有图纸标注和旧几何结果可以用明确的文字标签补充参数：

```sh
python geometry_notes.py --stage-one /path/stage-one.json --geometry /path/previous-geometry.json --output /path/new-note-run
```

规则只处理可读观察中明确写出的 `TONGUE ... THK/THICKNESS`、`CIRCULAR MIL AREA` / 导体面积标签和 `WIRE RANGE/SIZE ... AWG`。它不是 115 类通用视觉识别，也不补造对象引线。舌片厚度仅在自身有单位，或同时具有成对括号标注和明确 `DIMENSIONS IN mm [INCHES]` 声明时填写毫米单位；未注明单位的绝缘外径仍保留为空。已有六项模型数值和位置不被改写。

输出的 `processing_method=local_explicit_note_enrichment`、`network_call_performed=false` 和 `added_parameter_ids` 标明规则新增项目。`model` 仅沿用之前几何提取的模型名称，不能理解为这次重新调用过该模型。审计文件保留输入内容散列、规则版本和新增数量。重复处理不会重复添加同一条说明。测试覆盖文件/页面绑定、真实字段格式校验、区域换算、未知单位、幂等和旧格式迁移。

## 模型输出协议兼容

`geometry_protocol.py` 在严格校验前处理少量可审计的协议差异：`provided` 降为待复核 `candidate`；正整数实例编号转为字符串编号（仍检查重复）；仅在所有分行内容都能逐句引用原文时解码误写的换行；明确说明缺少标注框、且只引用一个有区域的观察时，复制该观察的原区域；已知的英文部件/视图名称使用小型工程词典显示中文。未知英文名称保留为校验失败，不按上下文猜译。

所有适配均记录旧值、新值和依据，原始模型响应保留不变。适配不更改尺寸数值、单位、公差、参数类别、对象区域或尺寸引线，不会把错误的部位分类自动纠正成正确结果。协议通过仍不等于几何语义正确。对已保存的失败响应离线重放校验，应明确标为离线重放，不能宣称重新调用模型。

## 语义识别调用预算与慢请求

模型端点与凭据沿用服务端 `DRAWING_VLM_BASE_URL`、`DRAWING_VLM_API_KEY`、`DRAWING_VLM_MODEL`；没有在几何模块写死供应商。`geometry_config.py` 的优先级为：

1. 显式 `DRAWING_GEOMETRY_*` 几何专用环境变量。
2. 已存在的同名 `DRAWING_VLM_*` 通用环境变量。
3. 命令行提供的备用值。
4. 原有默认值：180 秒、10,000 输出 token、思考模式关闭。

代码不会改写环境变量、静默启用思考或覆盖已有用户配置。几何专用变量可分别设置 `TIMEOUT`、`MAX_TOKENS`、`THINKING_MODE`、`THINKING_BUDGET`、`MAX_EDGE`、`MAX_IMAGES`，不影响第一阶段。思考模式仍由供应商策略校验：当前适配器只对明确名为 Qwen3.8 的模型发送其 `enable_thinking` / `thinking_budget` 参数，其他兼容模型不能盲目套用这两个参数。

2026-11-10 两页真实开发样本使用 `qwen3.8-max`、思考开启、思考预算 12,000、总输出预算 30,000、4,096 长边、整页加四张局部图；HTTP 200 分别耗时约 244 秒和 281 秒。响应经过上述可审计协议适配后分别保留 9 项和 14 项候选。相同配置的另一次请求在 300 秒超时，因此这不是稳定性或识别率保证，不能按普通秒级交互设计使用流程。

要显式采用这组思考预算，并把允许的超时提高至 600 秒，可在已经安全配置个人服务凭据的终端运行：

```sh
export DRAWING_GEOMETRY_TIMEOUT=600
export DRAWING_GEOMETRY_MAX_TOKENS=30000
export DRAWING_GEOMETRY_THINKING_MODE=enabled
export DRAWING_GEOMETRY_THINKING_BUDGET=12000
python workbench.py --port 8765
```

600 秒是当前应用允许的超时上限，增加等待时间不会提升已返回内容的正确性，也不保证供应商完成。已有环境变量优先于 CLI；没有这些环境变量时，也可使用：

```sh
python geometry.py --document /path/drawing.pdf --page 1 --output /path/new-run \
  --timeout 600 --max-tokens 30000 --thinking-mode enabled --thinking-budget 12000
python workbench.py --port 8765 --geometry-timeout 600 --geometry-max-tokens 30000 \
  --geometry-thinking-mode enabled --geometry-thinking-budget 12000
```

自定义启动器需要显式传递这些变量或参数。`/api/session` 返回不含密钥的 `geometry_configuration`，可核对最终生效的超时、输出上限与思考设置；它仅表示配置有效，不表示网络连通或结果正确。

调用不自动重试。网络超时或连接错误也保存实际等待秒数、错误类型、脱敏错误、源文件/页面散列、裁剪来源和生效请求配置。CLI 写入 `failed-audit.json`；HTTP 失败响应包含同一份脱敏审计，便于与之前的真实请求对照，不能把超时当成零识别结果。

## 离线 OCR 位置核对

`localization.py` 接收同页原图的本地 OCR 行，按完整文字唯一匹配提供标注框建议。它不调用外部模型，不修复数字或特殊符号，不按距离选重复尺寸，也不改变模型的对象框或引线。

```sh
python localization.py --geometry result.json --ocr-json local-ocr.json --ocr-format apple --output localization-audit.json
```

也支持归一化 OCR 行输入（默认格式）；加 `--embed` 可生成附带独立 `localization_audit` 的结果副本。来源 SHA/page 必须相符，审计散列绑定参数、证据和原始区域；校验时重新计算全部匹配。OCR 元数据来自调用方，仍需确保是对应原图。网页目前默认隐藏模型估计定位，此审计的建议框尚未自动替换网页坐标。

真实弹簧针图测试仅有4/14个参数得到唯一精确文字匹配，其余保留未匹配或歧义状态；不能将这个覆盖数解释为总体定位准确率。
