/**
 * Input debugging, enabled with `?debug=1`. Records pointer / touch / zoom events and a state
 * snapshot, and posts them in batches to `/api/debug-log` (written to ./debug-events.log by the
 * server) so input problems on a remote device can be inspected from the dev machine.
 */

export type DebugState = () => Record<string, unknown>;

const SEND_INTERVAL_MS = 500;
const MOVE_THROTTLE_MS = 100;

export function initDebug(getState: DebugState) {
  if (new URLSearchParams(location.search).get("debug") !== "1") return;

  const session = Math.random().toString(36).slice(2, 7);
  let queue: unknown[] = [];
  const t0 = performance.now();
  const lastMove = new Map<number, number>();

  const badge = document.createElement("div");
  badge.style.cssText =
    "position:fixed;right:4px;bottom:4px;z-index:2000;font:11px monospace;padding:2px 6px;" +
    "background:#000a;color:#0f0;border-radius:4px;pointer-events:none;white-space:pre";
  document.body.append(badge);
  let sent = 0;
  let last = "";

  const css = (el: Element) => getComputedStyle(el).touchAction;
  const describe = (t: EventTarget | null) => {
    const el = t as HTMLElement | null;
    if (!el || !el.tagName) return String(t);
    const cls = typeof el.className === "string" ? el.className.split(" ")[0] : "";
    return el.id ? `${el.tagName.toLowerCase()}#${el.id}` : `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}`;
  };
  const snapshot = () => ({
    ...getState(),
    ua: navigator.userAgent,
    dpr: devicePixelRatio,
    inner: [innerWidth, innerHeight],
    visualViewport: visualViewport && {
      scale: visualViewport.scale,
      size: [Math.round(visualViewport.width), Math.round(visualViewport.height)],
      offset: [Math.round(visualViewport.offsetLeft), Math.round(visualViewport.offsetTop)],
    },
    coarse: matchMedia("(pointer: coarse)").matches,
    touchAction: {
      html: css(document.documentElement),
      body: css(document.body),
      container: css(document.getElementById("viewerContainer")!),
    },
    classes: { html: document.documentElement.className, body: document.body.className },
  });

  const log = (kind: string, data: Record<string, unknown> = {}) => {
    const entry = { t: Math.round(performance.now() - t0), kind, ...data };
    queue.push(entry);
    last = `${kind} ${(data.pointerType as string) ?? ""}`;
  };

  function flush() {
    badge.textContent = `debug ${session}\nsent ${sent}\n${last}`;
    if (!queue.length) return;
    const batch = queue;
    queue = [];
    sent += batch.length;
    fetch("/api/debug-log", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: batch.map((e) => JSON.stringify({ session, ...(e as object) })).join("\n"),
      keepalive: true,
    }).catch(() => {});
  }
  setInterval(flush, SEND_INTERVAL_MS);

  log("start", snapshot());

  const opts = { capture: true, passive: true } as const;
  const ptr = (e: Event) => {
    const p = e as PointerEvent;
    if (p.type === "pointermove") {
      if (p.timeStamp - (lastMove.get(p.pointerId) ?? -Infinity) < MOVE_THROTTLE_MS) return;
      lastMove.set(p.pointerId, p.timeStamp);
    }
    log(p.type, {
      pointerType: p.pointerType,
      id: p.pointerId,
      primary: p.isPrimary,
      button: p.button,
      buttons: p.buttons,
      x: Math.round(p.clientX),
      y: Math.round(p.clientY),
      target: describe(p.target),
      cancelable: p.cancelable,
    });
    if (p.type === "pointerdown") log("state", snapshot());
  };
  for (const type of [
    "pointerdown", "pointerup", "pointercancel", "pointermove",
    "gotpointercapture", "lostpointercapture",
  ]) window.addEventListener(type, ptr, opts);

  const touch = (e: Event) => {
    const t = e as TouchEvent;
    if (t.type === "touchmove") {
      if (t.timeStamp - (lastMove.get(-1) ?? -Infinity) < MOVE_THROTTLE_MS) return;
      lastMove.set(-1, t.timeStamp);
    }
    log(t.type, {
      touches: t.touches.length,
      changed: t.changedTouches.length,
      target: describe(t.target),
      cancelable: t.cancelable,
    });
  };
  for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
    window.addEventListener(type, touch, opts);
  }

  for (const type of ["click", "dblclick", "contextmenu", "gesturestart", "gesturechange", "gestureend", "wheel"]) {
    window.addEventListener(
      type,
      (e) => log(type, { target: describe(e.target), ctrlKey: (e as MouseEvent).ctrlKey }),
      opts,
    );
  }

  visualViewport?.addEventListener("resize", () => log("visualViewport", snapshot()));
  window.addEventListener("error", (e) => log("error", { message: e.message }));

  return { log, snapshot };
}
