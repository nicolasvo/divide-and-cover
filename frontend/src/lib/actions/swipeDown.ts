// Dismiss-on-swipe-down gesture for bottom sheets.
//
// The touch listener is bound to `node` (typically the sheet's header — i.e.
// the "drag handle" area), but the visual translation is applied to
// `options.target` (typically the whole sheet panel). This way swiping content
// inside the body scrolls the body normally and never triggers dismiss.
//
// Ported and extended from ~/zzz/lineage-boxing/admin/src/lib/swipeDown.ts.

type SwipeDownOptions = {
  onClose: () => void;
  /** Element to translate while dragging. Defaults to `node` itself. */
  target?: HTMLElement;
};

export function swipeDown(node: HTMLElement, options: SwipeDownOptions) {
  let onClose = options.onClose;
  let target: HTMLElement = options.target ?? node;

  let startY = 0;
  let currentY = 0;
  let isDragging = false;

  function onTouchStart(e: TouchEvent) {
    startY = e.touches[0].clientY;
    currentY = startY;
    isDragging = false;
  }

  function onTouchMove(e: TouchEvent) {
    currentY = e.touches[0].clientY;
    const dy = currentY - startY;
    if (dy > 0) {
      if (!isDragging) {
        isDragging = true;
        target.style.transition = 'none';
      }
      target.style.transform = `translateY(${dy}px)`;
      e.preventDefault();
    } else if (isDragging) {
      target.style.transform = '';
      target.style.transition = '';
      isDragging = false;
    }
  }

  function onTouchEnd() {
    if (!isDragging) return;
    isDragging = false;
    const dy = currentY - startY;
    if (dy > 80) {
      target.style.transition = 'transform 0.2s ease';
      target.style.transform = 'translateY(100%)';
      setTimeout(() => onClose(), 200);
    } else {
      target.style.transition = 'transform 0.2s ease';
      target.style.transform = '';
    }
  }

  node.addEventListener('touchstart', onTouchStart, { passive: true });
  node.addEventListener('touchmove', onTouchMove, { passive: false });
  node.addEventListener('touchend', onTouchEnd);

  return {
    update(newOptions: SwipeDownOptions) {
      onClose = newOptions.onClose;
      target = newOptions.target ?? node;
    },
    destroy() {
      node.removeEventListener('touchstart', onTouchStart);
      node.removeEventListener('touchmove', onTouchMove);
      node.removeEventListener('touchend', onTouchEnd);
    }
  };
}
