# AcerolaFX ASCII 算法分析与网页提取

本仓库的 ASCII 效果位于 [`Shaders/AcerolaFX_ASCII.fx`](Shaders/AcerolaFX_ASCII.fx)。它不是普通的“取一个像素、查一个字符”的转换器，而是一个依赖 GPU 多通道纹理和 ReShade 深度缓冲的后处理管线。

本次提取提供了一个不依赖框架、可直接放进网页的浏览器版本：

- 实现：[`web/ascii-renderer.js`](web/ascii-renderer.js)
- 可运行示例：[`web/index.html`](web/index.html)
- 使用说明：[`web/README.md`](web/README.md)

浏览器版本保留了原算法最有辨识度的部分：8×8 字符网格、亮度量化、边缘方向分类、8×8 tile 内的主方向投票和原 shader 的十级亮度量化。网页普通图片或视频没有 ReShade 的场景深度和法线纹理，因此用亮度梯度代替深度/法线边缘；差异和取舍见下文。

## 1. 原始 shader 的处理流程

`AFX_ASCII` technique 一共包含多个 pass，最后通过一个 8×8 的 compute shader 写回 ASCII 结果。

| 阶段 | 源码位置 | 作用 |
| --- | --- | --- |
| 亮度 | `PS_Luminance`，约第 265 行 | 读取 `Common::AcerolaBuffer`，先 `saturate`，再用 `0.2127, 0.7152, 0.0722` 计算亮度。 |
| 1/8 缩小 | `PS_Downscale`，约第 269 行 | 每个 8×8 字符 tile 共享一份颜色和亮度；亮度放在 alpha 通道。 |
| DoG | `PS_HorizontalBlur` + `PS_VerticalBlurAndDifference` | 两个 sigma 的可分离高斯模糊做 Difference of Gaussians，再用 `_Tau` 和 `_Threshold` 得到二值细节边缘。 |
| 深度/法线 | `PS_CalculateNormals` + `PS_EdgeDetect` | 线性化 ReShade 深度，利用相邻视空间顶点叉乘生成法线；8 邻域深度差和法线差分别与阈值比较。 |
| Sobel 方向 | `PS_HorizontalSobel` + `PS_VerticalSobel` | 从边缘缓冲计算梯度角度 `theta`，再划分为竖线、横线、两个对角方向。 |
| tile 投票 | `CS_RenderASCII<8, 8>` | 一个线程组对应一个 8×8 tile；统计 64 个像素的方向，取出现次数最多的方向，少于 `_EdgeThreshold` 就放弃边缘字符。 |
| 字符选择 | `CS_RenderASCII` | 有边缘时读取 `edgesASCII.png`；否则根据缩小后的亮度读取 `fillASCII.png`。 |
| 着色 | `CS_RenderASCII` | 在 `_BackgroundColor`、`_ASCIIColor` 和原图颜色之间插值，并可按深度做衰减。 |

关键参数默认值在源码前半部分：

- `_KernelSize = 2`、`_Sigma = 2.0`、`_SigmaScale = 1.6`：DoG 的平滑尺度。
- `_Tau = 1.0`、`_Threshold = 0.005`：DoG 细节边缘阈值。
- `_EdgeThreshold = 8`：64 个像素中至少要有多少个方向像素才绘制边缘字符。
- `_Exposure = 1.0`、`_Attenuation = 1.0`：亮度进入字符查表前的乘法和幂函数。
- `_BlendWithBase`：字符颜色从纯 `_ASCIIColor` 向原图颜色混合的比例。

## 2. 字符 LUT 的含义

shader 不在字符串里保存字符，而是把字符预先栅格化到两张很小的纹理中：

- `Textures/edgesASCII.png`：40×8，5 个 8×8 cell。第 0 个为空白，第 1 到 4 个分别是竖线、横线和两种对角线。
- `Textures/fillASCII.png`：80×8，10 个 8×8 cell，对应从稀疏到填满的亮度等级。

compute shader 使用 `tex2Dfetch` 和 tile 内坐标选择 LUT cell。例如边缘方向 `0` 会读取第 `1` 个 cell，填充亮度会先被量化到 `0...9`。

网页 DOM 文本不能直接复用这两张“字形位图”，所以 `web/ascii-renderer.js` 使用用户指定的十级字符映射：

```text
[空格] . i C O P 0 ? @ ■
```

也就是代码中的 ` .iCOP0?@■`。其中最后的 `■` 由 Canvas 直接绘制为实心方块，避免字体缺少 U+25A0 时出现错误的系统回退；`@` 是倒数第二级。原始 LUT 的第 9 号 cell 是“填满的方块位图”，所以这个网页映射比原先通用的 ` .:-=+*#%@` 更接近仓库的亮度层次。

## 3. 浏览器版本做了什么

`AcerolaAsciiRenderer` 接受 `<img>`、`<video>`、`<canvas>` 或 `ImageBitmap`，每个动画帧执行：

1. 将源画面缩放到 `列数 × 行数` 个 8×8 tile 的采样画布。
2. 用同一组 Rec.709 近似系数计算每个采样像素的亮度。
3. 在每个 8×8 tile 中计算亮度梯度，并按原 shader 的角度区间累加四个方向桶。
4. 取 tile 的主方向；方向计数不足 `_EdgeThreshold` 时退回亮度字符。
5. 用原 shader 的公式量化亮度：

   ```text
   level = clamp(floor(pow(luminance * exposure, attenuation) * 10) - 1, 0, 9)
   ```

6. 在 Canvas 上绘制等宽字符。Canvas 比每帧创建几千个 `<span>` 更适合动画；最近一帧的纯文本也可以通过 `renderer.text` 读取。

示例启动方式：

```bash
python3 -m http.server 8000
```

然后打开 `http://localhost:8000/web/`。本仓库的 `Textures/example.png` 会作为默认图片，也可以选择本地图片或视频。

## 4. 与原版的差异和下一步

### 已保留

- 8×8 字符采样和原来的 tile 组织方式。
- 原 luminance 权重和十级亮度量化。
- 原四方向角度分桶和“tile 主方向”策略。
- `_Exposure`、`_Attenuation`、`_InvertLuminance`、`_EdgeThreshold`、颜色混合等网页侧可调参数。
- 动态源的逐帧处理：视频会自然形成 ASCII 动画；静态图也可通过 `shimmer` 做轻微演示动画。

### 尚未等价实现

- 网页图片/视频没有游戏的深度缓冲，所以无法直接实现 `_UseDepth`、`_DepthThreshold`、`_DepthCutoff`、`_DepthFalloff` 和真实视空间法线。
- DoG 的两次高斯模糊在 CPU 版本中被亮度梯度阈值替代。对普通网页内容而言，这样避免了每帧多次全图扫描；若输入是高分辨率视频，建议使用 WebGL2 fragment shader 或 WebGPU compute shader。
- 浏览器字体的字形和抗锯齿不可能与 `fillASCII.png` 的位图完全相同。

如果网页的内容本身是 Three.js、Babylon.js 等 3D 场景，下一步应把渲染结果、深度纹理和法线纹理一起送入 WebGL2/WebGPU，并保留原 shader 的多 pass 结构；那样才能完整复刻游戏内效果。对“视频/图片 ASCII 动画”来说，当前提取版通常更简单，也更容易嵌入页面。

## 5. 许可证

仓库使用 MIT License。提取或改写到网页项目时，应保留原项目的版权和 MIT 许可声明；新增的浏览器适配代码也在文件头注明了来源。
