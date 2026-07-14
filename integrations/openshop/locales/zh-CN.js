(function registerOpenShopChinese(global) {
  'use strict';

  const i18n = global.HstarOpenShopI18n;
  if (!i18n) throw new Error('HstarOpenShopI18n must load before zh-CN messages');

  const messages = Object.freeze({
    'Layer': '图层',
    'Created {width} × {height} canvas': '已创建 {width} × {height} 画布',
  });

  i18n.register('zh-CN', messages);
}(window));
