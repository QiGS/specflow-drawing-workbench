# SPECFlow 工业图纸工作台

图纸本地建库、OCR、相似图检索、人工复核和作业指导书草稿；另附可独立运行的本机视觉模型工作台。线上演示：[SPECFlow](https://specflow-datasheet.sagepin68.chatgpt.site/)。

## 网页

```sh
cd web
python3 -m http.server 4179 --bind 127.0.0.1
```

访问 [本地网页](http://127.0.0.1:4179/)。文件及工作记录保存在当前浏览器；备份不包含原文件。网页支持导入视觉工作台结果 JSON；部署的静态站点目前没有接通实时视觉模型接口。浏览器依赖及其许可证见 [web/vendor/README.md](web/vendor/README.md)。

## 本机视觉工作台

需要 Python 3.10+ 和可访问的兼容视觉模型服务。请使用自己的模型凭据，设置服务进程环境变量 `DRAWING_VLM_API_KEY` 和 `DRAWING_VLM_MODEL`，必要时设置 `DRAWING_VLM_BASE_URL`；不要把密钥写入源码或浏览器。模型服务会接收用户明确选择的图像页面。

```sh
cd vision-workbench
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-workbench.txt
python workbench.py
```

打开终端输出的一次性本地地址。结果可导出 JSON 并在网页“视觉识图”中导入对应原文件。独立工作台与静态网页是两个服务，并未自动打通网页实时识图。请勿公开工作台地址、凭据或敏感图纸。

## 测试

```sh
cd web && node --test tests/*.test.mjs
cd ../vision-workbench && python -m unittest discover -p 'test_*.py'
```

部分真实素材测试依赖额外环境变量，未配置时会跳过；仓库不包含用户图纸、实际模型响应、密钥或标注数据。识别内容及来源、尺寸、公差、工艺必须人工审核；相似分数不证明制造兼容性。该项目尚未实现完整企业级图纸平台。

当前回归：网页190项（187通过、3项因外部素材未配置跳过），后端89项通过；包含三维网格闭合、方向、体积与导出精度验证。

## 中文语义参数与局部建模（0.8）

支持用户定义的115类中文参数词典，按部位/视图分别记录同类多尺寸，保留原文、单位、公差和近似区域。主界面展示中文解释、搜索和分组，英文原文可展开。词典覆盖范围不代表115类已经达到可靠识别率。

在本机工作台上传原图，直接点击“识别当前页参数”，导出geometry-2.0 JSON后在网页“几何参数”导入。模型接收整页和四个有坐标记录的重叠局部图；不强制先执行第一阶段。第一阶段和旧版六项结果仍兼容。

```sh
python geometry.py --document original.pdf --page 1 --output new-geometry-result
# 已有原文和历史几何结果时，可以完全本地补充明确文字标签
python geometry_notes.py --stage-one stage-one.json --geometry previous-geometry.json --output new-local-result
```

本地规则只处理原文明示的厚度、导体面积和AWG范围，保留本地规则来源，不冒充新的模型推理。图纸缺失或单位不明确的参数不会自动补齐。

网页包含环形接触片、理想圆筒段及矩形外包络三种参数模型，可生成2D SVG、可旋转3D网格、参考STL、参数化SCAD和建模依据JSON。输入仅使用确定的名义线性尺寸；缺失、上/下限、未知单位、类别不匹配或矛盾尺寸会阻止生成。这些是局部/包络模型，不是任意PDF自动重建完整CAD；不能直接据此判定工艺复用。

实际开发图纸：保留历史6项模型候选，通过明确文字规则新增厚度、截面积、线规，共9项，已生成局部圆环模型。新的通用模型第一轮因单位引用错误被拒收，后续外发验证仍等待授权，因此不宣称通用识别效果已验证或准确率提高。

资源核查和实际数据集/分割试跑见 [资源评估](docs/resource-review.md)，详细本机操作见 [几何工作台说明](vision-workbench/GEOMETRY_README.md)。
