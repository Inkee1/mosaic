export function clipPane(rect, viewport) {
  for (const box of [rect, viewport]) {
    if (
      !box ||
      !['x', 'y', 'width', 'height'].every(
        (key) => Number.isFinite(box[key]) && Math.abs(box[key]) < 100000,
      ) ||
      box.width < 0 ||
      box.height < 0
    )
      throw new Error('Invalid viewport bounds');
  }
  const x = Math.max(Math.ceil(rect.x), Math.ceil(viewport.x));
  const y = Math.max(Math.ceil(rect.y), Math.ceil(viewport.y));
  const right = Math.min(Math.floor(rect.x + rect.width), Math.floor(viewport.x + viewport.width));
  const bottom = Math.min(
    Math.floor(rect.y + rect.height),
    Math.floor(viewport.y + viewport.height),
  );
  if (right <= x || bottom <= y) return { visible: false };
  return {
    visible: true,
    container: { x, y, width: right - x, height: bottom - y },
    content: {
      x: Math.round(rect.x) - x,
      y: Math.round(rect.y) - y,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
}
