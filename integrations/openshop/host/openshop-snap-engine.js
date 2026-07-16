(function bootstrapOpenShopSnapEngine(root){
  function finite(value, fallback=0){
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function point(value){
    return {
      left:finite(value?.left),
      top:finite(value?.top),
    };
  }

  function rect(value){
    const normalized = {
      left:finite(value?.left),
      top:finite(value?.top),
      width:finite(value?.width),
      height:finite(value?.height),
    };
    return normalized.width > 0 && normalized.height > 0 ? normalized : null;
  }

  function axisPoints(value, axis){
    return axis === 'x'
      ? [value.left, value.left + value.width / 2, value.left + value.width]
      : [value.top, value.top + value.height / 2, value.top + value.height];
  }

  function addMatching(list, currentValue, targetValue, axis, tolerance, priority, source){
    if(!currentValue || !targetValue) return;
    const currentPoints = axisPoints(currentValue, axis);
    const targetPoints = axisPoints(targetValue, axis);
    currentPoints.forEach((current, index) => {
      const delta = targetPoints[index] - current;
      if(Math.abs(delta) <= tolerance) list.push({delta, priority, source});
    });
  }

  function addDocumentOverlap(xCandidates, yCandidates, objectRect, documentRect, tolerance){
    if(!objectRect || !documentRect) return;
    if(
      Math.abs(objectRect.width - documentRect.width) > tolerance
      || Math.abs(objectRect.height - documentRect.height) > tolerance
    ) return;
    const deltaX = documentRect.left - objectRect.left;
    const deltaY = documentRect.top - objectRect.top;
    if(Math.abs(deltaX) <= tolerance){
      xCandidates.push({delta:deltaX, priority:1, source:'document-overlap'});
    }
    if(Math.abs(deltaY) <= tolerance){
      yCandidates.push({delta:deltaY, priority:1, source:'document-overlap'});
    }
  }

  function addDocumentGeometry(xCandidates, yCandidates, objectRect, documentRect, tolerance){
    if(!objectRect || !documentRect) return;
    const pairs = [
      [xCandidates, objectRect.left, documentRect.left, 'document-left'],
      [xCandidates, objectRect.left + objectRect.width, documentRect.left + documentRect.width, 'document-right'],
      [yCandidates, objectRect.top, documentRect.top, 'document-top'],
      [yCandidates, objectRect.top + objectRect.height, documentRect.top + documentRect.height, 'document-bottom'],
      [xCandidates, objectRect.left + objectRect.width / 2, documentRect.left + documentRect.width / 2, 'document-center-x'],
      [yCandidates, objectRect.top + objectRect.height / 2, documentRect.top + documentRect.height / 2, 'document-center-y'],
    ];
    pairs.forEach(([list, current, target, source]) => {
      const delta = target - current;
      if(Math.abs(delta) <= tolerance) list.push({delta, priority:2, source});
    });
  }

  function choose(candidates){
    return candidates.sort((left, right) => (
      left.priority - right.priority || Math.abs(left.delta) - Math.abs(right.delta)
    ))[0] || null;
  }

  function gridActive(grid){
    return Boolean(grid?.enabled) && finite(grid?.size) > 0;
  }

  function gridValue(value, grid){
    if(!gridActive(grid)) return value;
    const size = finite(grid.size);
    return Math.round(value / size) * size;
  }

  function resolveMovement(input={}){
    const position = point(input.position);
    const objectRect = rect(input.objectRect);
    const documentRect = rect(input.documentRect);
    const localAnchorRect = rect(input.localAnchorRect);
    const localTargetRect = rect(input.localTargetRect);
    const tolerance = Math.max(0, finite(input.tolerance));
    const xCandidates = [];
    const yCandidates = [];

    addMatching(
      xCandidates, localAnchorRect, localTargetRect, 'x', tolerance, 0, 'local-selection'
    );
    addMatching(
      yCandidates, localAnchorRect, localTargetRect, 'y', tolerance, 0, 'local-selection'
    );
    addDocumentOverlap(xCandidates, yCandidates, objectRect, documentRect, tolerance);
    addDocumentGeometry(xCandidates, yCandidates, objectRect, documentRect, tolerance);

    const x = choose(xCandidates);
    const y = choose(yCandidates);
    return {
      left:x ? position.left + x.delta : gridValue(position.left, input.grid),
      top:y ? position.top + y.delta : gridValue(position.top, input.grid),
      sourceX:x?.source || (gridActive(input.grid) ? 'grid' : 'none'),
      sourceY:y?.source || (gridActive(input.grid) ? 'grid' : 'none'),
    };
  }

  root.HstarOpenShopSnapEngine = Object.freeze({resolveMovement});
})(window);
