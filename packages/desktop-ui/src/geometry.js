const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
/** One transform defines rendering, visible source bounds and the inverse used by input. */
export function desktopGeometry(width, height, viewWidth, viewHeight, zoom = 1, panX = 0, panY = 0) {
  const fit = Math.min(viewWidth / width, viewHeight / height), scale = fit * clamp(zoom, 1, 6);
  panX = clamp(panX, Math.min(0, viewWidth - width * scale), 0);
  panY = clamp(panY, Math.min(0, viewHeight - height * scale), 0);
  const left = Math.max(0, (viewWidth - width * scale) / 2) + panX;
  const top = Math.max(0, (viewHeight - height * scale) / 2) + panY;
  const x = clamp(Math.floor(-left / scale), 0, width - 1), y = clamp(Math.floor(-top / scale), 0, height - 1);
  const right = clamp(Math.ceil((viewWidth - left) / scale), x + 1, width), bottom = clamp(Math.ceil((viewHeight - top) / scale), y + 1, height);
  return { width, height, viewWidth, viewHeight, fit, scale, left, top, panX, panY, rect: { x, y, width: right - x, height: bottom - y } };
}
export function sourcePoint(g, x, y, clampOutside = false) {
  const sourceX = (x - g.left) / g.scale, sourceY = (y - g.top) / g.scale;
  if (!clampOutside && (sourceX < 0 || sourceY < 0 || sourceX >= g.width || sourceY >= g.height)) return;
  return { x: clamp(Math.floor(sourceX), 0, g.width - 1), y: clamp(Math.floor(sourceY), 0, g.height - 1) };
}
export function zoomAround(g, zoom, anchorX, anchorY, destinationX = anchorX, destinationY = anchorY) {
  const scale = g.fit * clamp(zoom, 1, 6);
  return desktopGeometry(g.width, g.height, g.viewWidth, g.viewHeight, zoom,
    destinationX - (anchorX - g.left) / g.scale * scale - Math.max(0, (g.viewWidth - g.width * scale) / 2),
    destinationY - (anchorY - g.top) / g.scale * scale - Math.max(0, (g.viewHeight - g.height * scale) / 2));
}
