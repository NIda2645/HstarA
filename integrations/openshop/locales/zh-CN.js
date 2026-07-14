(function registerOpenShopChinese(global) {
  'use strict';

  const i18n = global.HstarOpenShopI18n;
  if (!i18n) throw new Error('HstarOpenShopI18n must load before zh-CN messages');

  const messages = Object.freeze({
    "File": "文件",
    "Edit": "编辑",
    "Image": "图像",
    "Layer": "图层",
    "Select": "选择",
    "Filter": "滤镜",
    "View": "视图",
    "Move Tool": "移动工具",
    "Rectangular Marquee Tool": "矩形选框工具",
    "Elliptical Marquee Tool": "椭圆选框工具",
    "Lasso Tool": "套索工具",
    "Polygonal Lasso Tool": "多边形套索工具",
    "Magic Wand Tool": "魔棒工具",
    "Crop Tool": "裁剪工具",
    "Eyedropper Tool": "吸管工具",
    "Brush Tool": "画笔工具",
    "Eraser Tool": "橡皮擦工具",
    "Clone Stamp Tool": "仿制图章工具",
    "Healing Brush Tool": "修复画笔工具",
    "Horizontal Type Tool": "横排文字工具",
    "Hand Tool": "抓手工具",
    "Zoom Tool": "缩放工具",
    "Layers": "图层",
    "Properties": "属性",
    "History": "历史记录",
    "Navigator": "导航器",
    "Info": "信息",
    "Color": "颜色",
    "Swatches": "色板",
    "Adjustments": "调整",
    "Opacity": "不透明度",
    "Blend Mode": "混合模式",
    "Fill": "填充",
    "Preferences": "首选项",
    "Created {width} × {height} canvas": "已创建 {width} × {height} 画布",
  });

  i18n.register('zh-CN', messages);
}(window));
