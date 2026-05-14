// Dismiss-on-swipe-down gesture for bottom sheets. Only engages when the
// touch starts at the top of the node's scroll (so mid-list swipes scroll
// normally instead of accidentally closing the sheet). Ported from
// ~/zzz/lineage-boxing/admin/src/lib/swipeDown.ts.

export function swipeDown(node: HTMLElement, onClose: () => void) {
  let startY = 0;
  let currentY = 0;
  let isDragging = false;
  let startedAtTop = false;

  function onTouchStart(e: TouchEvent) {
    startY = e.touches[0].clientY;
    currentY = startY;
    isDragging = false;
    startedAtTop = node.scrollTop <= 0;
  }

  function onTouchMove(e: TouchEvent) {
    if (!startedAtTop) return;
    currentY = e.touches[0].clientY;
    const dy = currentY - startY;
    if (dy > 0) {
      if (!isDragging) {
        isDragging = true;
        node.style.transition = 'none';
      }
      node.style.transform = `translateY(${dy}px)`;
      e.preventDefault();
    } else if (isDragging) {
      node.style.transform = '';
      node.style.transition = '';
      isDragging = false;
    }
  }

  function onTouchEnd() {
    if (!isDragging) return;
    isDragging = false;
    const dy = currentY - startY;
    if (dy > 80) {
      node.style.transition = 'transform 0.2s ease';
      node.style.transform = 'translateY(100%)';
      setTimeout(() => onClose(), 200);
    } else {
      node.style.transition = 'transform 0.2s ease';
      node.style.transform = '';
    }
  }

  node.addEventListener('touchstart', onTouchStart, { passive: true });
  node.addEventListener('touchmove', onTouchMove, { passive: false });
  node.addEventListener('touchend', onTouchEnd);

  return {
    update(newOnClose: () => void) {
      onClose = newOnClose;
    },
    destroy() {
      node.removeEventListener('touchstart', onTouchStart);
      node.removeEventListener('touchmove', onTouchMove);
      node.removeEventListener('touchend', onTouchEnd);
    }
  };
}
