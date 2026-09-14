"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/button";
import { IconAlert, IconClose, IconMinus, IconPlus } from "@/components/icons";
import {
  clampPlacement,
  containScale,
  coverScale,
  DEFAULT_RATIO_ID,
  drawRect,
  frameSize,
  initialPlacement,
  outputSize,
  parseCustomRatio,
  RATIO_PRESETS,
  zoomAround,
  zoomLimits,
  type AspectRatio,
  type Placement,
} from "@/lib/images/crop";
import {
  edgeColourOf,
  exportCrop,
  renderCrop,
  turnSource,
  type CropSource,
} from "@/lib/images/browser";

export type CropResult = {
  blob: Blob;
  altText: string;
  width: number;
  height: number;
  ratioLabel: string;
};

/** Gaps kept between the frame and the edge of the editing area. */
const STAGE_PADDING = 28;

/**
 * The crop editor (D-049).
 *
 * Upload, choose a shape, move and zoom, check the preview, save. The frame
 * on the dark stage is the saved image: everything inside it is kept, the
 * dimmed part around it is not. The picture is only ever scaled evenly, and
 * the first framing shows the whole product unless the photograph is already
 * close to the chosen shape (lib/images/crop.ts).
 */
export function CropEditor({
  source,
  heading,
  noun,
  confirmLabel,
  initialAlt,
  altRequired,
  progress,
  onCancel,
  onConfirm,
}: {
  source: CropSource;
  heading: string;
  /** "photograph" or "lifestyle image" — used in the labels. */
  noun: string;
  confirmLabel: string;
  initialAlt: string;
  /** A replacement may keep the description it already has. */
  altRequired: boolean;
  /** "Image 2 of 5" while a batch is being worked through. */
  progress: string | null;
  onCancel: () => void;
  /** Resolves to an error message, or null once saved. */
  onConfirm: (result: CropResult) => Promise<string | null>;
}) {
  const ids = useId();
  const [ratioId, setRatioId] = useState<string>(DEFAULT_RATIO_ID);
  const [customWidth, setCustomWidth] = useState("4");
  const [customHeight, setCustomHeight] = useState("5");
  const [lastCustom, setLastCustom] = useState<AspectRatio>({ width: 4, height: 5 });
  const [turns, setTurns] = useState(0);
  const [fillMode, setFillMode] = useState<"edge" | "white">("edge");
  const [altText, setAltText] = useState(initialAlt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [stage, setStage] = useState({ width: 0, height: 0 });

  const stageRef = useRef<HTMLCanvasElement>(null);
  const stageBoxRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const cardRef = useRef<HTMLCanvasElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // The picture the right way round, after any quarter turns.
  const turned = useMemo(() => turnSource(source, turns), [source, turns]);
  const edgeColour = useMemo(() => edgeColourOf(turned), [turned]);
  const fill = fillMode === "white" ? "#ffffff" : edgeColour;

  const custom = parseCustomRatio(customWidth, customHeight);
  const ratio: AspectRatio =
    ratioId === "custom"
      ? custom.ok
        ? custom.ratio
        : lastCustom
      : RATIO_PRESETS.find((preset) => preset.id === ratioId) ?? RATIO_PRESETS[0];
  const ratioName =
    ratioId === "custom" ? (custom.ok ? custom.label : "Custom") : ratioId;

  // Keyed on the shape's value, not on the ratio object's identity.
  const shape = ratio.width / ratio.height;
  const frame = useMemo(() => frameSize({ width: shape, height: 1 }), [shape]);
  const size = { width: turned.width, height: turned.height };

  /*
   * The placement belongs to one shape and one orientation. Changing either
   * starts from a fresh, product-safe framing rather than carrying a crop
   * made for a different frame.
   */
  const placementKey = `${frame.width}x${frame.height}:${turns}`;
  const [stored, setStored] = useState<{ key: string; placement: Placement } | null>(
    null,
  );
  const placement =
    stored && stored.key === placementKey
      ? stored.placement
      : initialPlacement(size, frame);
  /*
   * The latest placement, for the wheel and pointer handlers, which are bound
   * once and would otherwise see the placement from when they were bound.
   * Written after each render rather than during it.
   */
  const placementRef = useRef(placement);
  useEffect(() => {
    placementRef.current = placement;
  });

  function update(next: Placement) {
    setStored({ key: placementKey, placement: clampPlacement(next, size, frame) });
  }

  const limits = zoomLimits(size, frame);
  const fitScale = containScale(size, frame);
  const saved = outputSize(frame, placement);

  // The stage's own size, so the frame can be fitted inside it.
  useEffect(() => {
    const box = stageBoxRef.current;
    if (!box) return;
    const observer = new ResizeObserver(([entry]) => {
      setStage({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  const display =
    stage.width > 0
      ? Math.max(
          0.01,
          Math.min(
            (stage.width - STAGE_PADDING * 2) / frame.width,
            (stage.height - STAGE_PADDING * 2) / frame.height,
          ),
        )
      : 0.1;

  // Draw the stage: the whole picture, dimmed outside the frame.
  useEffect(() => {
    const canvas = stageRef.current;
    if (!canvas || stage.width === 0) return;
    const ratioPx = window.devicePixelRatio || 1;
    canvas.width = Math.round(stage.width * ratioPx);
    canvas.height = Math.round(stage.height * ratioPx);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratioPx, 0, 0, ratioPx, 0, 0);

    const frameWidth = frame.width * display;
    const frameHeight = frame.height * display;
    const left = (stage.width - frameWidth) / 2;
    const top = (stage.height - frameHeight) / 2;

    context.fillStyle = "#0a1526";
    context.fillRect(0, 0, stage.width, stage.height);
    context.fillStyle = fill;
    context.fillRect(left, top, frameWidth, frameHeight);

    const rect = drawRect(size, frame, placement, frameWidth);
    context.imageSmoothingQuality = "high";
    context.drawImage(turned, left + rect.x, top + rect.y, rect.width, rect.height);

    // Everything outside the frame is what will be cut away.
    context.fillStyle = "rgba(10, 21, 38, 0.66)";
    context.fillRect(0, 0, stage.width, top);
    context.fillRect(0, top + frameHeight, stage.width, stage.height - top - frameHeight);
    context.fillRect(0, top, left, frameHeight);
    context.fillRect(left + frameWidth, top, stage.width - left - frameWidth, frameHeight);

    // Thirds, brighter while the picture is being moved.
    context.strokeStyle = dragging ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.22)";
    context.lineWidth = 1;
    context.beginPath();
    for (const step of [1, 2]) {
      context.moveTo(left + (frameWidth * step) / 3, top);
      context.lineTo(left + (frameWidth * step) / 3, top + frameHeight);
      context.moveTo(left, top + (frameHeight * step) / 3);
      context.lineTo(left + frameWidth, top + (frameHeight * step) / 3);
    }
    context.stroke();

    context.strokeStyle = "#ffffff";
    context.lineWidth = 2;
    context.strokeRect(left - 1, top - 1, frameWidth + 2, frameHeight + 2);
    // Frame and stage are drawn from the same values as the saved file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, display, frame, placement, turned, fill, dragging]);

  // The previews: the product image at its shape, and a square catalogue card.
  useEffect(() => {
    const handle = window.requestAnimationFrame(() => {
      const preview = previewRef.current;
      const card = cardRef.current;
      if (!preview || !card) return;
      renderCrop(preview, turned, frame, placement, 240, fill);

      // The catalogue card is square and fills its box, so a tall image loses
      // its top and bottom there; the preview shows exactly how much.
      card.width = 160;
      card.height = 160;
      const context = card.getContext("2d");
      if (!context) return;
      const cover = Math.max(160 / preview.width, 160 / preview.height);
      const width = preview.width * cover;
      const height = preview.height * cover;
      context.clearRect(0, 0, 160, 160);
      context.drawImage(preview, (160 - width) / 2, (160 - height) / 2, width, height);
    });
    return () => window.cancelAnimationFrame(handle);
  }, [turned, frame, placement, fill]);

  // Escape cancels; the page behind does not scroll; focus starts in the dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [busy, onCancel]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  // Wheel zoom needs a listener that may cancel the page scroll.
  useEffect(() => {
    const canvas = stageRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = canvas.getBoundingClientRect();
      const point = {
        x: (event.clientX - bounds.left - bounds.width / 2) / display,
        y: (event.clientY - bounds.top - bounds.height / 2) / display,
      };
      const current = placementRef.current;
      update(
        zoomAround(current, current.scale * Math.exp(-event.deltaY * 0.0015), point, size, frame),
      );
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display, frame, placementKey, turned]);

  // Pointers: one moves the picture, two pinch to zoom.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; scale: number } | null>(null);

  function onPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = {
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        scale: placementRef.current.scale,
      };
    }
    setDragging(true);
  }

  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const last = pointers.current.get(event.pointerId);
    if (!last) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const current = placementRef.current;

    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const bounds = event.currentTarget.getBoundingClientRect();
      const point = {
        x: ((a.x + b.x) / 2 - bounds.left - bounds.width / 2) / display,
        y: ((a.y + b.y) / 2 - bounds.top - bounds.height / 2) / display,
      };
      update(
        zoomAround(current, (pinch.current.scale * distance) / pinch.current.distance, point, size, frame),
      );
      return;
    }

    update({
      ...current,
      x: current.x + (event.clientX - last.x) / display,
      y: current.y + (event.clientY - last.y) / display,
    });
  }

  function onPointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) setDragging(false);
  }

  function onStageKey(event: React.KeyboardEvent<HTMLCanvasElement>) {
    const step = event.shiftKey ? 120 : 24;
    const current = placementRef.current;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    if (moves[event.key]) {
      event.preventDefault();
      const [dx, dy] = moves[event.key];
      update({ ...current, x: current.x + dx, y: current.y + dy });
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      update(zoomAround(current, current.scale * 1.1, { x: 0, y: 0 }, size, frame));
    } else if (event.key === "-") {
      event.preventDefault();
      update(zoomAround(current, current.scale / 1.1, { x: 0, y: 0 }, size, frame));
    }
  }

  function zoomBy(factor: number) {
    update(zoomAround(placement, placement.scale * factor, { x: 0, y: 0 }, size, frame));
  }

  async function confirm() {
    if (ratioId === "custom" && !custom.ok) {
      setError(custom.error);
      return;
    }
    if (altRequired && altText.trim() === "") {
      setError(`Describe the ${noun}, so it works for someone using a screen reader.`);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const output = await exportCrop(turned, frame, placement, fill);
      const problem = await onConfirm({
        ...output,
        altText: altText.trim(),
        ratioLabel: ratioName,
      });
      if (problem) setError(problem);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That image could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  const control =
    "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-control border border-blue-300 bg-paper px-3 text-meta font-medium text-ink transition-colors hover:border-blue-500 hover:bg-blue-50 disabled:opacity-50";
  const zoomPercent = Math.round((placement.scale / fitScale) * 100);

  return (
    <div className="fixed inset-0 z-[80] flex bg-ink-deep/70 backdrop-blur-sm md:p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-heading`}
        tabIndex={-1}
        className="animate-rise m-auto flex h-dvh w-full max-w-6xl flex-col overflow-hidden bg-paper outline-none md:h-[min(92dvh,58rem)] md:rounded-card md:shadow-[var(--shadow-float)]"
      >
        <div className="flex items-center justify-between gap-3 border-b border-blue-200 px-4 py-3">
          <div className="min-w-0">
            <h2 id={`${ids}-heading`} className="truncate font-display text-h3 text-ink">
              {heading}
            </h2>
            {progress ? <p className="text-meta text-ink/70">{progress}</p> : null}
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="inline-flex size-11 shrink-0 items-center justify-center rounded-control text-ink/70 hover:bg-blue-50 hover:text-ink disabled:opacity-50"
          >
            <IconClose size={20} />
            <span className="sr-only">Cancel</span>
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-rows-[minmax(16rem,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_23rem] lg:grid-rows-1">
          <div ref={stageBoxRef} className="relative min-h-0 bg-ink-deep">
            <canvas
              ref={stageRef}
              tabIndex={0}
              aria-label={`Crop area, ${ratioName}. Drag the picture or use the arrow keys to move it; plus and minus zoom.`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onKeyDown={onStageKey}
              className={`absolute inset-0 size-full touch-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brass ${
                dragging ? "cursor-grabbing" : "cursor-grab"
              }`}
            />
            <p className="pointer-events-none absolute inset-x-0 bottom-2 text-center text-[0.75rem] text-paper/75">
              Drag to position · scroll or pinch to zoom
            </p>
          </div>

          <div className="flex min-h-0 flex-col gap-5 overflow-y-auto border-t border-blue-200 p-4 lg:border-l lg:border-t-0">
            <fieldset>
              <legend className="text-meta font-semibold text-ink">Aspect ratio</legend>
              <div className="mt-2 grid grid-cols-4 gap-1.5">
                {[...RATIO_PRESETS, { id: "custom", note: "Any shape" }].map((preset) => {
                  const active = ratioId === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => {
                        setRatioId(preset.id);
                        setError(null);
                      }}
                      className={`flex min-h-12 flex-col items-center justify-center rounded-control border px-1 text-center transition-colors ${
                        active
                          ? "border-blue-600 bg-blue-50 text-blue-600 shadow-[var(--shadow-raise)]"
                          : "border-blue-300 text-ink hover:border-blue-500 hover:bg-blue-50/60"
                      }`}
                    >
                      <span className="text-meta font-bold tabular-nums">
                        {preset.id === "custom" ? "Custom" : preset.id}
                      </span>
                      <span className="text-[0.625rem] leading-tight text-ink/70">
                        {preset.note}
                      </span>
                    </button>
                  );
                })}
              </div>

              {ratioId === "custom" ? (
                <div className="mt-3 flex flex-col gap-2">
                  <div className="flex items-end gap-2">
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <label htmlFor={`${ids}-width`} className="text-meta text-ink/70">
                        Width
                      </label>
                      <input
                        id={`${ids}-width`}
                        inputMode="decimal"
                        value={customWidth}
                        onChange={(event) => {
                          setCustomWidth(event.target.value);
                          const parsed = parseCustomRatio(event.target.value, customHeight);
                          if (parsed.ok) setLastCustom(parsed.ratio);
                        }}
                        className="min-h-10 w-full rounded-control border border-blue-300 px-2.5 text-body tabular-nums"
                      />
                    </div>
                    <span aria-hidden="true" className="pb-2.5 text-ink/70">
                      ×
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <label htmlFor={`${ids}-height`} className="text-meta text-ink/70">
                        Height
                      </label>
                      <input
                        id={`${ids}-height`}
                        inputMode="decimal"
                        value={customHeight}
                        onChange={(event) => {
                          setCustomHeight(event.target.value);
                          const parsed = parseCustomRatio(customWidth, event.target.value);
                          if (parsed.ok) setLastCustom(parsed.ratio);
                        }}
                        className="min-h-10 w-full rounded-control border border-blue-300 px-2.5 text-body tabular-nums"
                      />
                    </div>
                  </div>
                  <p
                    aria-live="polite"
                    className={`text-meta ${custom.ok ? "text-ink" : "text-stamp-red-text"}`}
                  >
                    {custom.ok ? (
                      <>
                        Aspect ratio: <strong className="tabular-nums">{custom.label}</strong>
                      </>
                    ) : (
                      custom.error
                    )}
                  </p>
                </div>
              ) : null}
            </fieldset>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <label htmlFor={`${ids}-zoom`} className="text-meta font-semibold text-ink">
                  Zoom
                </label>
                <span className="text-meta tabular-nums text-ink/70">{zoomPercent}%</span>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => zoomBy(1 / 1.15)} className={`${control} w-10 px-0`}>
                  <IconMinus size={16} />
                  <span className="sr-only">Zoom out</span>
                </button>
                <input
                  id={`${ids}-zoom`}
                  type="range"
                  min={Math.log(limits.min)}
                  max={Math.log(limits.max)}
                  step="any"
                  value={Math.log(placement.scale)}
                  onChange={(event) =>
                    update(
                      zoomAround(placement, Math.exp(Number(event.target.value)), { x: 0, y: 0 }, size, frame),
                    )
                  }
                  className="min-w-0 flex-1 accent-blue-600"
                />
                <button type="button" onClick={() => zoomBy(1.15)} className={`${control} w-10 px-0`}>
                  <IconPlus size={16} />
                  <span className="sr-only">Zoom in</span>
                </button>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => update({ scale: fitScale, x: 0, y: 0 })}
                  className={control}
                >
                  Show whole image
                </button>
                <button
                  type="button"
                  onClick={() => update({ scale: coverScale(size, frame), x: 0, y: 0 })}
                  className={control}
                >
                  Fill frame
                </button>
                <button type="button" onClick={() => update({ ...placement, x: 0, y: 0 })} className={control}>
                  Centre
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTurns(0);
                    setStored(null);
                  }}
                  className={control}
                >
                  Reset
                </button>
                <button type="button" onClick={() => setTurns((value) => value - 1)} className={control}>
                  Rotate left
                </button>
                <button type="button" onClick={() => setTurns((value) => value + 1)} className={control}>
                  Rotate right
                </button>
              </div>
            </div>

            <fieldset className="flex flex-col gap-1.5">
              <legend className="text-meta font-semibold text-ink">Empty space</legend>
              <p className="text-[0.75rem] text-ink/70">
                Where the picture does not reach the frame&apos;s edge.
              </p>
              <div className="mt-1 flex flex-wrap gap-3">
                <label className="flex min-h-9 cursor-pointer items-center gap-2 text-meta text-ink">
                  <input
                    type="radio"
                    name={`${ids}-fill`}
                    checked={fillMode === "edge"}
                    onChange={() => setFillMode("edge")}
                  />
                  <span
                    aria-hidden="true"
                    className="size-4 rounded-[4px] border border-blue-300"
                    style={{ backgroundColor: edgeColour }}
                  />
                  Match the image edge
                </label>
                <label className="flex min-h-9 cursor-pointer items-center gap-2 text-meta text-ink">
                  <input
                    type="radio"
                    name={`${ids}-fill`}
                    checked={fillMode === "white"}
                    onChange={() => setFillMode("white")}
                  />
                  <span aria-hidden="true" className="size-4 rounded-[4px] border border-blue-300 bg-paper" />
                  White
                </label>
              </div>
            </fieldset>

            <div className="flex flex-col gap-2">
              <p className="text-meta font-semibold text-ink">Preview</p>
              <div className="flex items-end gap-4">
                <figure className="flex flex-col gap-1">
                  <canvas
                    ref={previewRef}
                    aria-label={`Preview of the saved ${noun}`}
                    role="img"
                    className="max-h-44 w-auto max-w-[9.5rem] rounded-[var(--radius-control)] border border-blue-300 bg-blue-50 shadow-[var(--shadow-raise)]"
                  />
                  <figcaption className="text-[0.75rem] text-ink/70">
                    Product image · {ratioName}
                  </figcaption>
                </figure>
                <figure className="flex flex-col gap-1">
                  <canvas
                    ref={cardRef}
                    aria-label="Preview of the square catalogue card"
                    role="img"
                    className="size-24 rounded-[var(--radius-control)] border border-blue-300 bg-blue-50"
                  />
                  <figcaption className="text-[0.75rem] text-ink/70">Catalogue card</figcaption>
                </figure>
              </div>
              <p className="text-[0.75rem] tabular-nums text-ink/70">
                Saved as {saved.width} × {saved.height} px
                {saved.width < frame.width
                  ? " — the original is smaller than the standard, so it is not enlarged."
                  : "."}
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${ids}-alt`} className="text-meta font-semibold text-ink">
                Describe the {noun}
              </label>
              <input
                id={`${ids}-alt`}
                value={altText}
                onChange={(event) => setAltText(event.target.value)}
                placeholder="Open-back headphones, three-quarter view"
                className="min-h-11 rounded-control border border-blue-300 px-3 text-body"
              />
              <p className="text-[0.75rem] text-ink/70">
                Describe the product, not the file. This is what someone using a screen reader hears.
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-blue-200 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
          <div aria-live="polite" className="mr-auto min-w-0">
            {error ? (
              <p className="flex items-start gap-2 text-meta text-stamp-red-text">
                <IconAlert size={15} className="mt-0.5 shrink-0" />
                {error}
              </p>
            ) : null}
          </div>
          <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
            {progress ? "Skip" : "Cancel"}
          </Button>
          <Button type="button" onClick={confirm} disabled={busy}>
            {busy ? "Saving…" : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
