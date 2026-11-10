# 外部资源实查（2026-11-10）

- [DOP v2](https://github.com/savitra-roy/GD-T-dimension-Extraction/tree/main/mid-sem%20report/Dataset/DOP.v2-batch_2.yolov8)：实查134张图（训练115/验证13/测试6）、1,489个YOLO框；所有框只有dimensions一种类别。格式审核通过，没有SHA完全相同的跨划分文件（未做感知近重复审核）。数据说明为CC BY 4.0。它可训练标注检测，不能提供115类参数语义或尺寸字符真值。没有将数据复制进本仓库，也未据此训练新的语义模型。
- [eDOCr2](https://github.com/javvi51/edocr2)：MIT许可，图纸版面分割和工程OCR。本次实际运行了上游分割程序：上游Candle_holder样图以及一份用户端子图。端子图返回3组GD&T候选、3组表格候选、0个独立尺寸框；这些是算法输出数量，不代表分类正确率。没有运行其需另行下载权重的完整TensorFlowOCR识别器，未集成该源码到产品。
- [DrawMind3D](https://github.com/NWichter/DrawMind3D)：从PDF标注与**已有STEP**模型中关联孔特征，不是无CAD输入的通用重建器。其[当前许可证](https://github.com/NWichter/DrawMind3D/blob/main/LICENSE)要求事先书面许可，不能因代码在公开GitHub就直接使用；本次没有安装、执行或复制其实现。

本项目的局部三角网格和参数映射由自身实现，不声称集成上述三套完整系统。后续准确率评测需要独立标注“类别、实例、单位、公差、引线端点”，再按零件/文件拆分训练和测试，不能用框检测指标替代工程参数正确率。
