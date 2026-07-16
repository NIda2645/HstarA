(function bootstrapOpenShopPixelFill(root){
  function parseHexColor(value){
    const match = /^#([0-9a-f]{6})$/i.exec(String(value || '').trim());
    if(!match) throw new Error('颜色格式无效');
    const hex = match[1];
    return [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
      255,
    ];
  }

  function fillImageData(imageData, color, includesPixel = () => true){
    const rgba = parseHexColor(color);
    const width = Number(imageData?.width || 0);
    const height = Number(imageData?.height || 0);
    const data = imageData?.data;
    if(!data || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1){
      throw new TypeError('图像像素数据无效');
    }
    let count = 0;
    for(let y = 0; y < height; y += 1){
      for(let x = 0; x < width; x += 1){
        if(!includesPixel(x, y)) continue;
        data.set(rgba, (y * width + x) * 4);
        count += 1;
      }
    }
    return count;
  }

  root.HstarOpenShopPixelFill = Object.freeze({fillImageData});
})(window);
