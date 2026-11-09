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

## 几何参数（0.7）

本机视觉工作台支持独立的第二阶段几何关联：上传原图，提取当前页（或导入已有同文件标注 JSON），再点击“识别六项几何参数”。模型沿尺寸线关联安装孔、舌片、绝缘套和端子长度，绝缘层外径与导体截面积分别处理。

网页新增六张几何参数卡片与高清原图高亮/缩放，导入工作台导出的几何 JSON 后即可查看。无依据的单位、公差和参数保持未确认；位置框属于模型估计。该功能面向端子图的六项业务定义，不代表任意零件的通用几何理解。

验证：网页 163 项通过、3 项缺少外部样本路径跳过；Python 66 项通过。真实已知端子图第二轮调用返回六个候选（约31秒），绝缘层外径单位留空；这不是独立测试集准确率。完整操作见 [几何工作台说明](vision-workbench/GEOMETRY_README.md)。
