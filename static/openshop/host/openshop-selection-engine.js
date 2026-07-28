(function bootstrapOpenShopSelectionEngine(root){
  function integer(value, minimum, maximum){
    const number = Math.round(Number(value));
    if(!Number.isFinite(number)) return minimum;
    return Math.max(minimum, Math.min(maximum, number));
  }

  function selectionMode(event = {}){
    if(event.shiftKey && event.altKey) return 'intersect';
    if(event.shiftKey) return 'add';
    if(event.altKey) return 'subtract';
    return 'new';
  }

  function composeMasks(existing, incoming, mode = 'new'){
    const next = incoming instanceof Uint8Array ? incoming : Uint8Array.from(incoming || []);
    const current = existing instanceof Uint8Array ? existing : null;
    if(current && current.length !== next.length) throw new Error('Selection mask dimensions do not match');
    if(mode === 'new' || (!current && mode === 'add')) return new Uint8Array(next);
    const output = new Uint8Array(next.length);
    if(!current) return mode === 'intersect' ? new Uint8Array(next) : output;
    for(let index = 0; index < next.length; index += 1){
      if(mode === 'add') output[index] = current[index] || next[index] ? 1 : 0;
      else if(mode === 'subtract') output[index] = current[index] && !next[index] ? 1 : 0;
      else if(mode === 'intersect') output[index] = current[index] && next[index] ? 1 : 0;
      else output[index] = next[index] ? 1 : 0;
    }
    return output;
  }

  function maskBounds(mask, width, height){
    let minimumX = width;
    let minimumY = height;
    let maximumX = -1;
    let maximumY = -1;
    let count = 0;
    for(let index = 0; index < mask.length; index += 1){
      if(!mask[index]) continue;
      const x = index % width;
      const y = Math.floor(index / width);
      minimumX = Math.min(minimumX, x);
      minimumY = Math.min(minimumY, y);
      maximumX = Math.max(maximumX, x);
      maximumY = Math.max(maximumY, y);
      count += 1;
    }
    return {
      count,
      bounds:count ? {
        x:minimumX,
        y:minimumY,
        w:maximumX - minimumX + 1,
        h:maximumY - minimumY + 1,
      } : null,
    };
  }

  function simplifyPath(points, minimumDistance = 1){
    const threshold = Math.max(0, Number(minimumDistance) || 0);
    const output = [];
    for(const value of points || []){
      const point = {x:Number(value?.x), y:Number(value?.y)};
      if(!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
      const previous = output.at(-1);
      if(!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= threshold){
        output.push(point);
      }
    }
    return output;
  }

  function polygonMask(points, widthValue, heightValue){
    const width = Math.max(1, Math.round(Number(widthValue) || 1));
    const height = Math.max(1, Math.round(Number(heightValue) || 1));
    const path = simplifyPath(points, 0.5);
    const mask = new Uint8Array(width * height);
    if(path.length < 3) return {mask, width, height, count:0, bounds:null};
    let pathMinimumY = height;
    let pathMaximumY = 0;
    for(const point of path){
      pathMinimumY = Math.min(pathMinimumY, point.y);
      pathMaximumY = Math.max(pathMaximumY, point.y);
    }
    const minimumY = Math.max(0, Math.floor(pathMinimumY));
    const maximumY = Math.min(height, Math.ceil(pathMaximumY));
    for(let y = minimumY; y < maximumY; y += 1){
      const scanY = y + 0.5;
      const intersections = [];
      for(let index = 0; index < path.length; index += 1){
        const start = path[index];
        const end = path[(index + 1) % path.length];
        if((start.y <= scanY && end.y > scanY) || (end.y <= scanY && start.y > scanY)){
          intersections.push(start.x + (scanY - start.y) * (end.x - start.x) / (end.y - start.y));
        }
      }
      intersections.sort((left, right) => left - right);
      for(let index = 0; index + 1 < intersections.length; index += 2){
        const startX = Math.max(0, Math.ceil(intersections[index] - 0.5));
        const endX = Math.min(width - 1, Math.ceil(intersections[index + 1] - 0.5) - 1);
        for(let x = startX; x <= endX; x += 1) mask[y * width + x] = 1;
      }
    }
    const summary = maskBounds(mask, width, height);
    return {mask, width, height, count:summary.count, bounds:summary.bounds};
  }

  function colorDistance(data, index, target){
    const offset = index * 4;
    const red = data[offset] - target[0];
    const green = data[offset + 1] - target[1];
    const blue = data[offset + 2] - target[2];
    const alpha = data[offset + 3] - target[3];
    return Math.sqrt(0.299 * red * red + 0.587 * green * green + 0.114 * blue * blue + 0.05 * alpha * alpha);
  }

  function magicWand(options = {}){
    const width = Math.max(1, Math.round(Number(options.width) || 1));
    const height = Math.max(1, Math.round(Number(options.height) || 1));
    const data = options.data;
    if(!data || data.length < width * height * 4) throw new Error('Magic wand image data is invalid');
    const validMask = options.validMask || null;
    if(validMask && validMask.length !== width * height){
      throw new Error('Magic wand document mask dimensions do not match');
    }
    const x = integer(options.x, 0, width - 1);
    const y = integer(options.y, 0, height - 1);
    const tolerance = Math.max(0, Math.min(255, Number(options.tolerance) || 0));
    const seed = y * width + x;
    if(validMask && !validMask[seed]){
      const mask = new Uint8Array(width * height);
      return {mask, width, height, count:0, bounds:null};
    }
    const offset = seed * 4;
    const target = [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]];
    const mask = new Uint8Array(width * height);
    const matches = index => (!validMask || validMask[index])
      && colorDistance(data, index, target) <= tolerance;

    if(options.contiguous !== false){
      const visited = new Uint8Array(width * height);
      const queue = new Int32Array(width * height);
      let head = 0;
      let tail = 0;
      queue[tail++] = seed;
      visited[seed] = 1;
      while(head < tail){
        const index = queue[head++];
        if(!matches(index)) continue;
        mask[index] = 1;
        const currentX = index % width;
        if(currentX > 0 && !visited[index - 1]){
          visited[index - 1] = 1;
          queue[tail++] = index - 1;
        }
        if(currentX + 1 < width && !visited[index + 1]){
          visited[index + 1] = 1;
          queue[tail++] = index + 1;
        }
        if(index >= width && !visited[index - width]){
          visited[index - width] = 1;
          queue[tail++] = index - width;
        }
        if(index + width < mask.length && !visited[index + width]){
          visited[index + width] = 1;
          queue[tail++] = index + width;
        }
      }
    } else {
      for(let index = 0; index < mask.length; index += 1){
        if(matches(index)) mask[index] = 1;
      }
    }
    const summary = maskBounds(mask, width, height);
    return {mask, width, height, count:summary.count, bounds:summary.bounds};
  }

  function boundaryPixels(mask, width, height){
    const output = [];
    for(let y = 0; y < height; y += 1){
      for(let x = 0; x < width; x += 1){
        const index = y * width + x;
        if(!mask[index]) continue;
        if(
          x === 0 || y === 0 || x === width - 1 || y === height - 1
          || !mask[index - 1] || !mask[index + 1]
          || !mask[index - width] || !mask[index + width]
        ) output.push(index);
      }
    }
    return output;
  }

  root.HstarOpenShopSelectionEngine = Object.freeze({
    selectionMode,
    composeMasks,
    maskBounds,
    simplifyPath,
    polygonMask,
    magicWand,
    boundaryPixels,
  });
})(window);
