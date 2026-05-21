import { useCallback, useEffect, useRef, useState } from "react";
import { Stage, Layer, Image as KonvaImage, Line } from "react-konva";
import Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";

// ─── constants ───────────────────────────────────────────────────────────────

const ZOOM_FACTOR = 1.08;
const MIN_SCALE = 0.05;
const MAX_SCALE = 40;

const placeholderSvg = (label: string) => `
  <svg width="600" height="800" xmlns="http://www.w3.org/2000/svg">
    <rect width="592" height="792" x="4" y="4" fill="#f8fafc" stroke="#cbd5e1" stroke-width="4" stroke-dasharray="12 12" rx="16" />
    <text x="50%" y="48%" font-family="system-ui, sans-serif" font-size="20" font-weight="600" fill="#94a3b8" text-anchor="middle" dominant-baseline="middle">
      Open a card scan to begin
    </text>
    <text x="50%" y="55%" font-family="system-ui, sans-serif" font-size="14" fill="#cbd5e1" text-anchor="middle" dominant-baseline="middle">
      (${label})
    </text>
  </svg>
`;

const makePlaceholderUrl = (label: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(placeholderSvg(label))}`;

const HIT_PAD = 8;
const EXTENT = 12_000;
const MIN_GAP = 5;

// ─── types ───────────────────────────────────────────────────────────────────

interface GuidePositions {
  outerLeft: number;
  innerLeft: number;
  innerRight: number;
  outerRight: number;
  outerTop: number;
  innerTop: number;
  innerBottom: number;
  outerBottom: number;
}

interface ImageInfo {
  el: HTMLImageElement;
  x: number;
  y: number;
}

interface GradeResult {
  label: string;
  color: string;
  score: number;
}

type Side = "front" | "back";

// ─── helpers ─────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function centeringLabel(a: number, b: number): string {
  const total = a + b;
  if (total <= 0) return "— / —";
  return `${((a / total) * 100).toFixed(1)} / ${((b / total) * 100).toFixed(1)}`;
}

function getGrade(a: number, b: number, isBack: boolean): GradeResult {
  const total = a + b;
  if (total <= 0) return { label: "—", color: "#888", score: 0 };

  const diff = Math.abs(a - b) / total;

  if (isBack) {
    if (diff <= 0.50) return { label: "PSA 10", color: "#4ade80", score: 10 };
    if (diff <= 0.80) return { label: "PSA 9", color: "#86efac", score: 9 };
    return { label: "PSA 8 or lower", color: "#fb923c", score: 8 };
  } else {
    if (diff <= 0.10) return { label: "PSA 10", color: "#4ade80", score: 10 };
    if (diff <= 0.20) return { label: "PSA 9", color: "#86efac", score: 9 };
    if (diff <= 0.30) return { label: "PSA 8", color: "#fde047", score: 8 };
    if (diff <= 0.40) return { label: "PSA 7", color: "#fb923c", score: 7 };
    if (diff <= 0.60) return { label: "PSA 6", color: "#f87171", score: 6 };
    return { label: "PSA 5 or lower", color: "#ef4444", score: 5 };
  }
}

/** Converts a numeric PSA score to a PSA label string */
function scoreToLabel(score: number): string {
  if (score >= 10) return "PSA 10";
  if (score >= 9) return "PSA 9";
  if (score >= 8) return "PSA 8";
  if (score >= 7) return "PSA 7";
  if (score >= 6) return "PSA 6";
  return "PSA 5 or lower";
}

/** Grade color from a numeric score */
function scoreToColor(score: number): string {
  if (score >= 10) return "#4ade80";
  if (score >= 9) return "#86efac";
  if (score >= 8) return "#fde047";
  if (score >= 7) return "#fb923c";
  if (score >= 6) return "#f87171";
  return "#ef4444";
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function centrePosition(img: HTMLImageElement, containerWidth: number, containerHeight: number) {
  return {
    x: (containerWidth - img.naturalWidth) / 2,
    y: (containerHeight - img.naturalHeight) / 2,
  };
}

function buildDefaultGuides(el: HTMLImageElement, pos: { x: number; y: number }): GuidePositions {
  const outPad = 10;
  const inPad = 40;
  return {
    outerLeft: pos.x + outPad,
    innerLeft: pos.x + inPad,
    innerRight: pos.x + el.naturalWidth - inPad,
    outerRight: pos.x + el.naturalWidth - outPad,
    outerTop: pos.y + outPad,
    innerTop: pos.y + inPad,
    innerBottom: pos.y + el.naturalHeight - inPad,
    outerBottom: pos.y + el.naturalHeight - outPad,
  };
}

// ─── single‑canvas sub‑component ─────────────────────────────────────────────

interface CanvasProps {
  side: Side;
  width: number;
  height: number;
  imgInfo: ImageInfo | null;
  guides: GuidePositions | null;
  loading: boolean;
  onOpenScan: () => void;
  stageRef: React.RefObject<Konva.Stage | null>;
  onWheel: (e: KonvaEventObject<WheelEvent>) => void;
  stageDragBound: (p: { x: number; y: number }) => { x: number; y: number };
  dragHandlers: DragHandlers;
}

interface DragHandlers {
  onOuterLeftDrag: (e: KonvaEventObject<DragEvent>) => void;
  onInnerLeftDrag: (e: KonvaEventObject<DragEvent>) => void;
  onInnerRightDrag: (e: KonvaEventObject<DragEvent>) => void;
  onOuterRightDrag: (e: KonvaEventObject<DragEvent>) => void;
  onOuterTopDrag: (e: KonvaEventObject<DragEvent>) => void;
  onInnerTopDrag: (e: KonvaEventObject<DragEvent>) => void;
  onInnerBottomDrag: (e: KonvaEventObject<DragEvent>) => void;
  onOuterBottomDrag: (e: KonvaEventObject<DragEvent>) => void;
  cursorEW: () => void;
  cursorNS: () => void;
  cursorGrab: () => void;
}

function SideCanvas({
  width, height, imgInfo, guides, loading, onOpenScan,
  stageRef, onWheel, stageDragBound, dragHandlers: dh,
}: CanvasProps) {
  return (
    <div style={{ position: "relative", width, height, backgroundColor: "#ffffff" }}>
      <Stage
        ref={stageRef}
        width={width}
        height={height}
        draggable
        dragBoundFunc={stageDragBound}
        onWheel={onWheel}
        style={{ cursor: "grab" }}
      >
        <Layer>
          {imgInfo && (
            <KonvaImage
              image={imgInfo.el}
              x={imgInfo.x}
              y={imgInfo.y}
              width={imgInfo.el.naturalWidth}
              height={imgInfo.el.naturalHeight}
              shadowColor="black"
              shadowBlur={20}
              shadowOpacity={0.4}
            />
          )}

          {guides && (
            <>
              {/* Outer Left (Green) */}
              <Line x={guides.outerLeft} y={0} points={[0, -EXTENT, 0, EXTENT]} stroke="#10b981" strokeWidth={1.5} listening={false} dash={[4, 4]} />
              <Line x={guides.outerLeft} y={0} points={[0, -EXTENT, 0, EXTENT]} stroke="transparent" strokeWidth={HIT_PAD * 2} draggable onDragMove={dh.onOuterLeftDrag} onMouseEnter={dh.cursorEW} onMouseLeave={dh.cursorGrab} />

              {/* Inner Left (Red) */}
              <Line x={guides.innerLeft} y={0} points={[0, -EXTENT, 0, EXTENT]} stroke="#ff5050" strokeWidth={1} listening={false} />
              <Line x={guides.innerLeft} y={0} points={[0, -EXTENT, 0, EXTENT]} stroke="transparent" strokeWidth={HIT_PAD * 2} draggable onDragMove={dh.onInnerLeftDrag} onMouseEnter={dh.cursorEW} onMouseLeave={dh.cursorGrab} />

              {/* Inner Right (Red) */}
              <Line x={guides.innerRight} y={0} points={[0, -EXTENT, 0, EXTENT]} stroke="#ff5050" strokeWidth={1} listening={false} />
              <Line x={guides.innerRight} y={0} points={[0, -EXTENT, 0, EXTENT]} stroke="transparent" strokeWidth={HIT_PAD * 2} draggable onDragMove={dh.onInnerRightDrag} onMouseEnter={dh.cursorEW} onMouseLeave={dh.cursorGrab} />

              {/* Outer Right (Green) */}
              <Line x={guides.outerRight} y={0} points={[0, -EXTENT, 0, EXTENT]} stroke="#10b981" strokeWidth={1.5} listening={false} dash={[4, 4]} />
              <Line x={guides.outerRight} y={0} points={[0, -EXTENT, 0, EXTENT]} stroke="transparent" strokeWidth={HIT_PAD * 2} draggable onDragMove={dh.onOuterRightDrag} onMouseEnter={dh.cursorEW} onMouseLeave={dh.cursorGrab} />

              {/* Outer Top (Green) */}
              <Line x={0} y={guides.outerTop} points={[-EXTENT, 0, EXTENT, 0]} stroke="#10b981" strokeWidth={1.5} listening={false} dash={[4, 4]} />
              <Line x={0} y={guides.outerTop} points={[-EXTENT, 0, EXTENT, 0]} stroke="transparent" strokeWidth={HIT_PAD * 2} draggable onDragMove={dh.onOuterTopDrag} onMouseEnter={dh.cursorNS} onMouseLeave={dh.cursorGrab} />

              {/* Inner Top (Blue) */}
              <Line x={0} y={guides.innerTop} points={[-EXTENT, 0, EXTENT, 0]} stroke="#50c8ff" strokeWidth={1} listening={false} />
              <Line x={0} y={guides.innerTop} points={[-EXTENT, 0, EXTENT, 0]} stroke="transparent" strokeWidth={HIT_PAD * 2} draggable onDragMove={dh.onInnerTopDrag} onMouseEnter={dh.cursorNS} onMouseLeave={dh.cursorGrab} />

              {/* Inner Bottom (Blue) */}
              <Line x={0} y={guides.innerBottom} points={[-EXTENT, 0, EXTENT, 0]} stroke="#50c8ff" strokeWidth={1} listening={false} />
              <Line x={0} y={guides.innerBottom} points={[-EXTENT, 0, EXTENT, 0]} stroke="transparent" strokeWidth={HIT_PAD * 2} draggable onDragMove={dh.onInnerBottomDrag} onMouseEnter={dh.cursorNS} onMouseLeave={dh.cursorGrab} />

              {/* Outer Bottom (Green) */}
              <Line x={0} y={guides.outerBottom} points={[-EXTENT, 0, EXTENT, 0]} stroke="#10b981" strokeWidth={1.5} listening={false} dash={[4, 4]} />
              <Line x={0} y={guides.outerBottom} points={[-EXTENT, 0, EXTENT, 0]} stroke="transparent" strokeWidth={HIT_PAD * 2} draggable onDragMove={dh.onOuterBottomDrag} onMouseEnter={dh.cursorNS} onMouseLeave={dh.cursorGrab} />
            </>
          )}
        </Layer>
      </Stage>

      {/* Open scan button overlay */}
      <button
        style={{
          position: "absolute",
          bottom: 16,
          left: "50%",
          transform: "translateX(-50%)",
          padding: "8px 20px",
          background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
          border: "none",
          borderRadius: 8,
          color: "#fff",
          fontFamily: "'Inter', 'Segoe UI', sans-serif",
          fontSize: 13,
          fontWeight: 600,
          cursor: loading ? "not-allowed" : "pointer",
          opacity: loading ? 0.6 : 1,
          boxShadow: "0 4px 12px rgba(99,102,241,0.4)",
        }}
        onClick={onOpenScan}
        disabled={loading}
      >
        {loading ? "Loading…" : "Open Scan"}
      </button>
    </div>
  );
}

// ─── hook: per‑side state + drag handlers ─────────────────────────────────────

function useSideState(side: Side, containerWidth: number, containerHeight: number) {
  const stageRef = useRef<Konva.Stage | null>(null);
  const [imgInfo, setImgInfo] = useState<ImageInfo | null>(null);
  const [guides, setGuides] = useState<GuidePositions | null>(null);
  const [loading, setLoading] = useState(false);

  const guidesRef = useRef<GuidePositions | null>(null);
  useEffect(() => { guidesRef.current = guides; }, [guides]);

  const imgInfoRef = useRef<ImageInfo | null>(null);
  useEffect(() => { imgInfoRef.current = imgInfo; }, [imgInfo]);

  // Adjust on container resize
  useEffect(() => {
    const currentImg = imgInfoRef.current;
    const currentGuides = guidesRef.current;
    if (!currentImg || !currentGuides) return;

    const newPos = centrePosition(currentImg.el, containerWidth, containerHeight);
    const deltaX = newPos.x - currentImg.x;
    const deltaY = newPos.y - currentImg.y;
    if (deltaX === 0 && deltaY === 0) return;

    setImgInfo({ ...currentImg, x: newPos.x, y: newPos.y });
    setGuides({
      outerLeft: currentGuides.outerLeft + deltaX,
      innerLeft: currentGuides.innerLeft + deltaX,
      innerRight: currentGuides.innerRight + deltaX,
      outerRight: currentGuides.outerRight + deltaX,
      outerTop: currentGuides.outerTop + deltaY,
      innerTop: currentGuides.innerTop + deltaY,
      innerBottom: currentGuides.innerBottom + deltaY,
      outerBottom: currentGuides.outerBottom + deltaY,
    });

    const stage = stageRef.current;
    if (stage) { stage.scale({ x: 1, y: 1 }); stage.position({ x: 0, y: 0 }); }
  }, [containerWidth, containerHeight]);

  const applyImage = useCallback((el: HTMLImageElement) => {
    const pos = centrePosition(el, containerWidth, containerHeight);
    setImgInfo({ el, x: pos.x, y: pos.y });
    setGuides(buildDefaultGuides(el, pos));

    const stage = stageRef.current;
    if (stage) { stage.scale({ x: 1, y: 1 }); stage.position({ x: 0, y: 0 }); }
  }, [containerWidth, containerHeight]);

  // Load placeholder on mount
  useEffect(() => {
    loadImage(makePlaceholderUrl(side === "front" ? "Front Side" : "Back Side"))
      .then(applyImage)
      .catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleOpenScan = useCallback(async () => {
    setLoading(true);
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp"] }],
      });
      if (!selected) return;
      const assetUrl = convertFileSrc(selected as string);
      const el = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new window.Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed to load: ${assetUrl}`));
        img.src = assetUrl;
      });
      applyImage(el);
    } catch (err) {
      console.error("Failed to open image:", err);
      alert(`Could not load image: ${err}`);
    } finally {
      setLoading(false);
    }
  }, [applyImage]);

  const handleWheel = useCallback((e: KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const oldScale = stage.scaleX();
    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    const mousePointTo = {
      x: (pointer.x - stage.x()) / oldScale,
      y: (pointer.y - stage.y()) / oldScale,
    };
    const dir = e.evt.deltaY < 0 ? 1 : -1;
    const newScale = clamp(dir > 0 ? oldScale * ZOOM_FACTOR : oldScale / ZOOM_FACTOR, MIN_SCALE, MAX_SCALE);
    stage.scale({ x: newScale, y: newScale });
    stage.position({
      x: pointer.x - mousePointTo.x * newScale,
      y: pointer.y - mousePointTo.y * newScale,
    });
  }, []);

  const stageDragBound = useCallback((p: { x: number; y: number }) => p, []);

  // Drag handlers
  const onOuterLeftDrag = useCallback((e: KonvaEventObject<DragEvent>) => {
    const g = guidesRef.current; if (!g) return;
    const newX = clamp(e.target.x(), -EXTENT, g.innerLeft - MIN_GAP);
    e.target.x(newX); e.target.y(0);
    setGuides((p) => p ? { ...p, outerLeft: newX } : p);
  }, []);

  const onInnerLeftDrag = useCallback((e: KonvaEventObject<DragEvent>) => {
    const g = guidesRef.current; if (!g) return;
    const newX = clamp(e.target.x(), g.outerLeft + MIN_GAP, g.innerRight - MIN_GAP);
    e.target.x(newX); e.target.y(0);
    setGuides((p) => p ? { ...p, innerLeft: newX } : p);
  }, []);

  const onInnerRightDrag = useCallback((e: KonvaEventObject<DragEvent>) => {
    const g = guidesRef.current; if (!g) return;
    const newX = clamp(e.target.x(), g.innerLeft + MIN_GAP, g.outerRight - MIN_GAP);
    e.target.x(newX); e.target.y(0);
    setGuides((p) => p ? { ...p, innerRight: newX } : p);
  }, []);

  const onOuterRightDrag = useCallback((e: KonvaEventObject<DragEvent>) => {
    const g = guidesRef.current; if (!g) return;
    const newX = clamp(e.target.x(), g.innerRight + MIN_GAP, EXTENT);
    e.target.x(newX); e.target.y(0);
    setGuides((p) => p ? { ...p, outerRight: newX } : p);
  }, []);

  const onOuterTopDrag = useCallback((e: KonvaEventObject<DragEvent>) => {
    const g = guidesRef.current; if (!g) return;
    const newY = clamp(e.target.y(), -EXTENT, g.innerTop - MIN_GAP);
    e.target.x(0); e.target.y(newY);
    setGuides((p) => p ? { ...p, outerTop: newY } : p);
  }, []);

  const onInnerTopDrag = useCallback((e: KonvaEventObject<DragEvent>) => {
    const g = guidesRef.current; if (!g) return;
    const newY = clamp(e.target.y(), g.outerTop + MIN_GAP, g.innerBottom - MIN_GAP);
    e.target.x(0); e.target.y(newY);
    setGuides((p) => p ? { ...p, innerTop: newY } : p);
  }, []);

  const onInnerBottomDrag = useCallback((e: KonvaEventObject<DragEvent>) => {
    const g = guidesRef.current; if (!g) return;
    const newY = clamp(e.target.y(), g.innerTop + MIN_GAP, g.outerBottom - MIN_GAP);
    e.target.x(0); e.target.y(newY);
    setGuides((p) => p ? { ...p, innerBottom: newY } : p);
  }, []);

  const onOuterBottomDrag = useCallback((e: KonvaEventObject<DragEvent>) => {
    const g = guidesRef.current; if (!g) return;
    const newY = clamp(e.target.y(), g.innerBottom + MIN_GAP, EXTENT);
    e.target.x(0); e.target.y(newY);
    setGuides((p) => p ? { ...p, outerBottom: newY } : p);
  }, []);

  const cursorEW = useCallback(() => { stageRef.current?.container().style.setProperty("cursor", "ew-resize"); }, []);
  const cursorNS = useCallback(() => { stageRef.current?.container().style.setProperty("cursor", "ns-resize"); }, []);
  const cursorGrab = useCallback(() => { stageRef.current?.container().style.setProperty("cursor", "grab"); }, []);

  const dragHandlers: DragHandlers = {
    onOuterLeftDrag, onInnerLeftDrag, onInnerRightDrag, onOuterRightDrag,
    onOuterTopDrag, onInnerTopDrag, onInnerBottomDrag, onOuterBottomDrag,
    cursorEW, cursorNS, cursorGrab,
  };

  return { stageRef, imgInfo, guides, loading, handleOpenScan, handleWheel, stageDragBound, dragHandlers };
}

// ─── centering math ───────────────────────────────────────────────────────────

function computeCentering(guides: GuidePositions | null) {
  if (!guides) return null;
  return {
    borderLeft: guides.innerLeft - guides.outerLeft,
    borderRight: guides.outerRight - guides.innerRight,
    borderTop: guides.innerTop - guides.outerTop,
    borderBottom: guides.outerBottom - guides.innerBottom,
  };
}

// ─── root component ───────────────────────────────────────────────────────────

export default function CenteringCanvas() {
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });

  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Split width in half for the two canvases, keep a divider gap
  const DIVIDER = 8;
  const canvasW = Math.floor((size.width - DIVIDER) / 2);
  const canvasH = size.height;

  const frontState = useSideState("front", canvasW, canvasH);
  const backState = useSideState("back", canvasW, canvasH);

  // ── grade calculation ──────────────────────────────────────────────────────
  const frontCentering = computeCentering(frontState.guides);
  const backCentering = computeCentering(backState.guides);

  const fHGrade = frontCentering ? getGrade(frontCentering.borderLeft, frontCentering.borderRight, false) : null;
  const fVGrade = frontCentering ? getGrade(frontCentering.borderTop, frontCentering.borderBottom, false) : null;
  const bHGrade = backCentering ? getGrade(backCentering.borderLeft, backCentering.borderRight, true) : null;
  const bVGrade = backCentering ? getGrade(backCentering.borderTop, backCentering.borderBottom, true) : null;

  // Worst of each side
  const frontWorstScore = fHGrade && fVGrade ? Math.min(fHGrade.score, fVGrade.score) : null;
  const backWorstScore = bHGrade && bVGrade ? Math.min(bHGrade.score, bVGrade.score) : null;

  // Combined: average the two sides, floor to nearest integer grade
  const combinedScore: number | null =
    frontWorstScore !== null && backWorstScore !== null
      ? Math.floor((frontWorstScore + backWorstScore) / 2)
      : null;

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: "flex", width: size.width, height: size.height, backgroundColor: "#ffffff", overflow: "hidden", position: "relative" }}>

      {/* ── Front canvas ── */}
      <div style={{ position: "relative", width: canvasW, height: canvasH }}>
        {/* Side label */}
        <div style={styles.sideLabel}>FRONT</div>
        <SideCanvas
          side="front"
          width={canvasW}
          height={canvasH}
          imgInfo={frontState.imgInfo}
          guides={frontState.guides}
          loading={frontState.loading}
          onOpenScan={frontState.handleOpenScan}
          stageRef={frontState.stageRef}
          onWheel={frontState.handleWheel}
          stageDragBound={frontState.stageDragBound}
          dragHandlers={frontState.dragHandlers}
        />
        {/* Per-side mini stats */}
        {frontCentering && fHGrade && fVGrade && (
          <div style={styles.miniStats}>
            <span style={styles.miniRow}>
              <span style={styles.miniLabel}>L/R</span>
              <span style={styles.miniValue}>{centeringLabel(frontCentering.borderLeft, frontCentering.borderRight)}</span>
            </span>
            <span style={styles.miniRow}>
              <span style={styles.miniLabel}>T/B</span>
              <span style={styles.miniValue}>{centeringLabel(frontCentering.borderTop, frontCentering.borderBottom)}</span>
            </span>
            <span style={{ ...styles.miniGrade, color: frontWorstScore !== null ? scoreToColor(frontWorstScore) : "#888" }}>
              {frontWorstScore !== null ? scoreToLabel(frontWorstScore) : "—"}
            </span>
          </div>
        )}
      </div>

      {/* ── Divider ── */}
      <div style={{ width: DIVIDER, height: "100%", backgroundColor: "#94a3b8", flexShrink: 0, boxShadow: "0 0 8px rgba(0,0,0,0.2)" }} />      {/* ── Back canvas ── */}
      <div style={{ position: "relative", width: canvasW, height: canvasH }}>
        <div style={styles.sideLabel}>BACK</div>
        <SideCanvas
          side="back"
          width={canvasW}
          height={canvasH}
          imgInfo={backState.imgInfo}
          guides={backState.guides}
          loading={backState.loading}
          onOpenScan={backState.handleOpenScan}
          stageRef={backState.stageRef}
          onWheel={backState.handleWheel}
          stageDragBound={backState.stageDragBound}
          dragHandlers={backState.dragHandlers}
        />
        {backCentering && bHGrade && bVGrade && (
          <div style={styles.miniStats}>
            <span style={styles.miniRow}>
              <span style={styles.miniLabel}>L/R</span>
              <span style={styles.miniValue}>{centeringLabel(backCentering.borderLeft, backCentering.borderRight)}</span>
            </span>
            <span style={styles.miniRow}>
              <span style={styles.miniLabel}>T/B</span>
              <span style={styles.miniValue}>{centeringLabel(backCentering.borderTop, backCentering.borderBottom)}</span>
            </span>
            <span style={{ ...styles.miniGrade, color: backWorstScore !== null ? scoreToColor(backWorstScore) : "#888" }}>
              {backWorstScore !== null ? scoreToLabel(backWorstScore) : "—"}
            </span>
          </div>
        )}
      </div>

      {/* ── Floating combined results panel ── */}
      <div style={styles.panel}>
        <p style={styles.panelTitle}>Combined Centering</p>

        {/* Front row */}
        <div style={styles.sideRow}>
          <span style={styles.sideName}>Front</span>
          <div style={styles.sideDetails}>
            {frontCentering ? (
              <>
                <span style={styles.detailText}>{centeringLabel(frontCentering.borderLeft, frontCentering.borderRight)} (H)</span>
                <span style={styles.detailText}>{centeringLabel(frontCentering.borderTop, frontCentering.borderBottom)} (V)</span>
              </>
            ) : <span style={styles.detailText}>—</span>}
          </div>
          <span style={{ ...styles.sideBadge, color: frontWorstScore !== null ? scoreToColor(frontWorstScore) : "#555" }}>
            {frontWorstScore !== null ? scoreToLabel(frontWorstScore) : "—"}
          </span>
        </div>

        {/* Back row */}
        <div style={styles.sideRow}>
          <span style={styles.sideName}>Back</span>
          <div style={styles.sideDetails}>
            {backCentering ? (
              <>
                <span style={styles.detailText}>{centeringLabel(backCentering.borderLeft, backCentering.borderRight)} (H)</span>
                <span style={styles.detailText}>{centeringLabel(backCentering.borderTop, backCentering.borderBottom)} (V)</span>
              </>
            ) : <span style={styles.detailText}>—</span>}
          </div>
          <span style={{ ...styles.sideBadge, color: backWorstScore !== null ? scoreToColor(backWorstScore) : "#555" }}>
            {backWorstScore !== null ? scoreToLabel(backWorstScore) : "—"}
          </span>
        </div>

        {/* Divider */}
        <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "12px 0" }} />

        {/* Combined grade */}
        <div style={{ textAlign: "center" }}>
          {combinedScore !== null ? (
            <>
              <p style={{ margin: "0 0 4px", fontSize: 11, color: "#666", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                Estimated Grade
              </p>
              <p style={{ margin: 0, fontSize: 26, fontWeight: 800, color: scoreToColor(combinedScore) }}>
                {scoreToLabel(combinedScore)}
              </p>
              <p style={{ margin: "4px 0 0", fontSize: 11, color: "#555" }}>
                avg of front ({frontWorstScore}) + back ({backWorstScore})
              </p>
            </>
          ) : (
            <p style={{ margin: 0, color: "#444", fontSize: 13 }}>
              Set guides on both sides to see grade
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── styles ──────────────────────────────────────────────────────────────────

const styles = {
  panel: {
    position: "absolute" as const,
    top: 20,
    left: "50%",
    transform: "translateX(-50%)",
    width: 320,
    background: "rgba(13, 13, 18, 0.92)",
    backdropFilter: "blur(16px)",
    WebkitBackdropFilter: "blur(16px)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 16,
    padding: "16px 20px",
    color: "#e8e8f0",
    fontFamily: "'Inter', 'Segoe UI', sans-serif",
    fontSize: 13,
    boxShadow: "0 8px 40px rgba(0,0,0,0.6)",
    userSelect: "none" as const,
    pointerEvents: "none" as const, // panel is read-only display
  },
  panelTitle: {
    margin: "0 0 12px",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.1em",
    textTransform: "uppercase" as const,
    color: "#555",
    textAlign: "center" as const,
  },
  sideRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },
  sideName: {
    fontSize: 12,
    fontWeight: 700,
    color: "#aaa",
    width: 36,
    flexShrink: 0,
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
  },
  sideDetails: {
    flex: 1,
    display: "flex",
    flexDirection: "column" as const,
    gap: 2,
  },
  detailText: {
    color: "#777",
    fontSize: 12,
    fontVariantNumeric: "tabular-nums" as const,
  },
  sideBadge: {
    fontSize: 13,
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums" as const,
    flexShrink: 0,
  },
  sideLabel: {
    position: "absolute" as const,
    top: 14,
    left: "50%",
    transform: "translateX(-50%)",
    fontSize: 16,
    fontWeight: 800,
    letterSpacing: "0.2em",
    color: "rgba(30,30,40,0.5)",
    fontFamily: "'Inter', 'Segoe UI', sans-serif",
    userSelect: "none" as const,
    pointerEvents: "none" as const,
    zIndex: 10,
  },
  miniStats: {
    position: "absolute" as const,
    bottom: 52,
    left: "50%",
    transform: "translateX(-50%)",
    background: "rgba(0,0,0,0.7)",
    backdropFilter: "blur(8px)",
    border: "1px solid rgba(255,255,255,0.07)",
    borderRadius: 10,
    padding: "8px 14px",
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    gap: 4,
    pointerEvents: "none" as const,
    fontFamily: "'Inter', 'Segoe UI', sans-serif",
  },
  miniRow: {
    display: "flex",
    gap: 8,
    alignItems: "center",
  },
  miniLabel: {
    fontSize: 10,
    color: "#555",
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
  },
  miniValue: {
    fontSize: 12,
    color: "#ccc",
    fontVariantNumeric: "tabular-nums" as const,
    fontWeight: 600,
  },
  miniGrade: {
    fontSize: 14,
    fontWeight: 800,
    marginTop: 2,
  },
} satisfies Record<string, React.CSSProperties>;