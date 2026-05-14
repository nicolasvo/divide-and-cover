// Lock body scroll while a modal/sheet is mounted. Reference-counted so
// nested overlays don't unlock prematurely. Ported from
// ~/zzz/lineage-boxing/admin/src/lib/lockScroll.ts.

let lockCount = 0;
let savedScrollY = 0;

export function lockScroll(_node: HTMLElement) {
  if (lockCount === 0) {
    savedScrollY = window.scrollY;
    document.body.classList.add('no-scroll');
    document.body.style.top = `-${savedScrollY}px`;
  }
  lockCount++;

  return {
    destroy() {
      lockCount--;
      if (lockCount === 0) {
        document.body.classList.remove('no-scroll');
        document.body.style.top = '';
        window.scrollTo(0, savedScrollY);
      }
    }
  };
}
