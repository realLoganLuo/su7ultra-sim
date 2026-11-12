> 2026-10-24 驾驶物理更新：本文下方的二代 / EMB / 全主动描述属于原始外观概念资料，不再代表默认驾驶配置。当前默认是液压 ABS / EBD、弹簧阻尼悬架近似与手动连续转向。校准依据、验证和模型边界见 `driving-physics.md`。

# 造型与参数参考笔记（仅文字 + 链接，不含任何图片）

> 二代 SU7 Ultra 为传闻/预测车型。本项目造型为"合理推测"，页面标注"概念预测，非官方"。
> 线控制动 (48V EMB) 与全主动悬架在公开报道中**未找到可靠来源**，属于本演示的设定假设。

## 一代 SU7 Ultra（量产）要点
- 尺寸约 5115 × 1970 × 1465 mm，轴距 3000 mm（量产 Ultra 公布数据，本项目采用该值）。
- 三电机，综合功率约 1.1 MW 级（1138 kW / 1548 hp 量级），0-100 km/h 约 1.98 s，极速 350 km/h。
- 低趴的溜背（fastback）四门轿跑，前脸分体大灯，前机盖双风道，黄色大卡钳，碳纤维前铲/侧裙/扩散器。
- 纽北：原型车 6:22.091，量产赛道包 7:04.957（见下方链接）。

## 二代/"Extreme" 传闻中的造型关键词（谍照与渲染图文字描述）
- 巨型碳纤维赛道尾翼（横跨车身宽度、位置很高），传闻下压力从 ~285 kg 提升到 600 kg+。
- 更激进的前铲、风道，碳纤维扩散器，贯穿式尾灯，黄色大尺寸（碳陶）制动卡钳，半热熔赛道胎。
- 动力传闻：三电机维持或四电机 2054 hp，说法不一。

## 本项目采用的造型设定
- 车身：18+ 个横截面放样（rear → front），低趴溜背，车顶最高点约在轴距中部偏后，A 柱角约 28°。
- 前脸：上方细长 DRL 灯带 + 下方主灯组（分体式），中央下进气口 + 两侧风道，碳纤维下扰流板。
- 后部：高位大尾翼（天鹅颈支架 + 端板），碳纤维扩散器，贯穿式红色尾灯。
- 轮：21 寸多辐轮毂，黄色 6 活塞风格卡钳，打孔刹车盘。
- 涂装：熔岩黄 / 珍珠白 + 黄色条纹。

## 链接
- 谍照/渲染报道（IT之家）：https://www.ithome.com/0/977/299.htm
- 新款 SU7 Ultra 渲染图（凤凰网）：https://i.ifeng.com/c/8uup8q0nKeH
- 造型预测图（凤凰网）：https://i.ifeng.com/c/8uuhz7VtkOG
- 新款 Ultra 路试谍照英文报道：https://english.news18a.com/m/news/english_265367.html
- 纽北 6:22.091：https://carnewschina.com/?p=226908
- 纽北量产纪录 7:04：https://cnevpost.com/2025/06/11/xiaomi-su7-ultra-fastest-production-car-nurburgring/
- 量产 Ultra 发布前预热：https://cnevpost.com/2024/10/28/xiaomi-ev-warms-up-su7-ultra-production-version/

## 车模来源 (3D model credit)
本演示的车身与轮毂使用 Sketchfab 上的 CC-BY-4.0 模型：
"Xiaomi Su7 Ultra Nurburgring" by MattDoesBlender
https://sketchfab.com/3d-models/xiaomi-su7-ultra-nurburgring-df6d8c7af9764d31a4ecef61925c13bb
许可：http://creativecommons.org/licenses/by/4.0/ （许可文本见 `public/models/su7ultra.LICENSE.txt`）。
本项目对其做了压缩（Draco + WebP）、节点重排、材质修复（涂装重着色、轮胎/轮毂/卡钳/玻璃材质替换）。
原始文件位于 `model/`（不随构建发布，已加入 .gitignore）。程序化车模 (`src/car/CarModel.ts`) 保留为加载失败时的后备。
