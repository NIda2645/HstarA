(function initOpenShopCanvasSampler(root) {
  'use strict';

  function finite(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${label} is invalid`);
    return number;
  }

  function sample({canvas, event, documentPoint, documentWidth, documentHeight}) {
    const pointX = finite(documentPoint?.x, 'Document X');
    const pointY = finite(documentPoint?.y, 'Document Y');
    const width = finite(documentWidth, 'Document width');
    const height = finite(documentHeight, 'Document height');
    if (pointX < 0 || pointY < 0 || pointX >= width || pointY >= height) {
      throw new Error('Color sample is outside the document');
    }

    const element = canvas?.lowerCanvasEl;
    const rect = element?.getBoundingClientRect?.();
    if (!element || !rect || rect.width <= 0 || rect.height <= 0) {
      throw new Error('Canvas color could not be sampled');
    }

    const x = Math.floor(
      (finite(event?.clientX, 'Client X') - rect.left) * element.width / rect.width
    );
    const y = Math.floor(
      (finite(event?.clientY, 'Client Y') - rect.top) * element.height / rect.height
    );
    if (x < 0 || y < 0 || x >= element.width || y >= element.height) {
      throw new Error('Color sample is outside the canvas');
    }

    try {
      const [red, green, blue, alpha] = element
        .getContext('2d', {willReadFrequently:true})
        .getImageData(x, y, 1, 1).data;
      const hex = `#${[red, green, blue]
        .map(value => value.toString(16).padStart(2, '0'))
        .join('')}`;
      return {red, green, blue, alpha, hex};
    } catch (_) {
      throw new Error('Canvas color could not be sampled');
    }
  }

  root.HstarOpenShopCanvasSampler = Object.freeze({sample});
})(window);
