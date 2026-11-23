/** Scroll the nearest viewport only; scaled kiosk coordinates remain local. */
export function centerScroll(target: HTMLElement) {
  for (
    let parent = target.parentElement;
    parent && !parent.classList.contains("kiosk");
    parent = parent.parentElement
  ) {
    if (
      !/(auto|scroll)/.test(getComputedStyle(parent).overflowY) ||
      parent.scrollHeight <= parent.clientHeight
    )
      continue;
    const frame = parent.getBoundingClientRect(),
      box = target.getBoundingClientRect();
    const factor = frame.height / parent.clientHeight;
    if (!factor) return;
    const top =
      parent.scrollTop +
      (box.top + box.height / 2 - frame.top - frame.height / 2) / factor;
    const previousPadding = parent.style.paddingBottom;
    const remaining = top - (parent.scrollHeight - parent.clientHeight);
    if (remaining > 0)
      parent.style.paddingBottom = `${parseFloat(getComputedStyle(parent).paddingBottom) + remaining + 2}px`;
    const viewport = parent;
    parent.scrollTo({
      top: Math.max(0, top),
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
    return () => {
      viewport.style.paddingBottom = previousPadding;
    };
  }
}
