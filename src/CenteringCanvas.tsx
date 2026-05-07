import { useCallback, useEffect, useRef, useState } from "react";
import { Stage, Layer, Image as KonvaImage, Rect } from "react-konva";
import Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";

// ─── constants ───────────────────────────────────────────────────────────────

const ZOOM_FACTOR = 1.08;
const MIN_SCALE = 0.05;
const MAX_SCALE = 40;

const PLACEHOLDER_URL = "https://picsum.photos/600/800";

const GUIDE_STROKE = 2;
const HIT_PAD = 8;
const EXTENT = 12_000;
const MIN_GAP = 10;

// ─── types ───────────────────────────────────────────────────────────────────

interface GuidePositions {
  leftX: number;
  rightX: number;
  topY: number;
  bottomY: number;
}

interface ImageInfo {
  el: HTMLImageElement;
  x: number;
  y: number;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function centeringLabel(a: number, b: number): string {
  const total = a + b;
  if (total <= 0) return "— / —";
  return `${((a / total) * 100).toFixed(1)}% / ${((b / total) * 100).toFixed(1)}%`;
}

function grade(a: number, b: number): { label: string; color: string } {
  const total = a + b;
  if (total <= 0) return { label: "—", color: "#888" };
  const diff = Math.abs(a - b) / total;
  if (diff < 0.02) return { label: "Gem Mint", color: "#4ade80" };
  if (diff < 0.05) return { label: "Mint",     color: "#86efac" };
  if (diff < 0.10) return { label: "Near Mint",color: "#fde047" };
  if (diff < 0.18) return { label: "Excellent", color: "#fb923c" };
  return { label: "Poor", color: "#f87171" };
}

/** Load a URL into an HTMLImageElement and resolve with the loaded element. */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** Compute the image position that centres it in the current viewport. */
function centrePosition(img: HTMLImageElement) {
  return {
    x: (window.innerWidth  - img.naturalWidth)  / 2,
    y: (window.innerHeight - img.naturalHeight) / 2,
  };
}

// ─── component ───────────────────────────────────────────────────────────────

export default function CenteringCanvas() {
  const [size, setSize] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });

  const stageRef = useRef<Konva.Stage>(null);
  const [imgInfo, setImgInfo]   = useState<ImageInfo | null>(null);
  const [guides,  setGuides]    = useState<GuidePositions | null>(null);
  const [loading, setLoading]   = useState(false);

  const guidesRef = useRef<GuidePositions | null>(null);
  useEffect(() => { guidesRef.current = guides; }, [guides]);

  // ── resize ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const onResize = () =>
      setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ── helper: apply a loaded image to state + reset stage ──────────────────
  const applyImage = useCallback((el: HTMLImageElement) => {
    const pos = centrePosition(el);
    setImgInfo({ el, x: pos.x, y: pos.y });
    setGuides({
      leftX:   pos.x,
      rightX:  pos.x + el.naturalWidth,
      topY:    pos.y,
      bottomY: pos.y + el.naturalHeight,
    });
    // Reset zoom & pan
    const stage = stageRef.current;
    if (stage) {
      stage.scale({ x: 1, y: 1 });
      stage.position({ x: 0, y: 0 });
    }
  }, []);

  // ── load placeholder on mount ─────────────────────────────────────────────
  useEffect(() => {
    loadImage(PLACEHOLDER_URL).then(applyImage).catch(console.error);
  }, [applyImage]);

  // ── open file picker ──────────────────────────────────────────────────────
  const handleOpenScan = useCallback(async () => {
    setLoading(true);
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp"] }],
      });

      if (!selected) return;

      const assetUrl = convertFileSrc(selected as string);
      
      // Load WITHOUT crossOrigin for local asset:// URLs
      const el = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new window.Image();
        // Do NOT set crossOrigin for local Tauri asset URLs
        img.onload = () => resolve(img);
        img.onerror = (e) => reject(new Error(`Failed to load image: ${assetUrl}`));
        img.src = assetUrl;
      });

      applyImage(el);
    } catch (err) {
      console.error("Failed to open image:", err);
      alert(`Could not load image: ${err}`); // surface the error visibly
    } finally {
      setLoading(false);
    }
  }, [applyImage]);

  // ── wheel zoom ───────────────────────────────────────────────────────────
  const handleWheel = useCallback((e: KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;

    const oldScale = stage.scaleX();
    const pointer  = stage.getPointerPosition();
    if (!pointer) return;

    const mousePointTo = {
      x: (pointer.x - stage.x()) / oldScale,
      y: (pointer.y - stage.y()) / oldScale,
    };
    const dir      = e.evt.deltaY < 0 ? 1 : -1;
    const newScale = clamp(
      dir > 0 ? oldScale * ZOOM_FACTOR : oldScale / ZOOM_FACTOR,
      MIN_SCALE, MAX_SCALE
    );
    stage.scale({ x: newScale, y: newScale });
    stage.position({
      x: pointer.x - mousePointTo.x * newScale,
      y: pointer.y - mousePointTo.y * newScale,
    });
  }, []);

  const stageDragBound = useCallback((p: { x: number; y: number }) => p, []);

  // ── guide drag handlers ──────────────────────────────────────────────────
  const onLeftDrag = useCallback((e: KonvaEventObject<DragEvent>) => {
    const g = guidesRef.current; if (!g) return;
    const newX = clamp(e.target.x(), -EXTENT, g.rightX - MIN_GAP);
    e.target.x(newX); e.target.y(-EXTENT);
    setGuides((p) => p ? { ...p, leftX: newX } : p);
  }, []);

  const onRightDrag = useCallback((e: KonvaEventObject<DragEvent>) => {
    const g = guidesRef.current; if (!g) return;
    const newX = clamp(e.target.x(), g.leftX + MIN_GAP, EXTENT);
    e.target.x(newX); e.target.y(-EXTENT);
    setGuides((p) => p ? { ...p, rightX: newX } : p);
  }, []);

  const onTopDrag = useCallback((e: KonvaEventObject<DragEvent>) => {
    const g = guidesRef.current; if (!g) return;
    const newY = clamp(e.target.y(), -EXTENT, g.bottomY - MIN_GAP);
    e.target.x(-EXTENT); e.target.y(newY);
    setGuides((p) => p ? { ...p, topY: newY } : p);
  }, []);

  const onBottomDrag = useCallback((e: KonvaEventObject<DragEvent>) => {
    const g = guidesRef.current; if (!g) return;
    const newY = clamp(e.target.y(), g.topY + MIN_GAP, EXTENT);
    e.target.x(-EXTENT); e.target.y(newY);
    setGuides((p) => p ? { ...p, bottomY: newY } : p);
  }, []);

  // ── cursor helpers ───────────────────────────────────────────────────────
  const cursorEW   = useCallback(() => { stageRef.current?.container().style.setProperty("cursor", "ew-resize"); }, []);
  const cursorNS   = useCallback(() => { stageRef.current?.container().style.setProperty("cursor", "ns-resize"); }, []);
  const cursorGrab = useCallback(() => { stageRef.current?.container().style.setProperty("cursor", "grab"); }, []);

  // ── centering math ───────────────────────────────────────────────────────
  const centering = (() => {
    if (!guides || !imgInfo) return null;
    const { leftX, rightX, topY, bottomY } = guides;
    const { x: imgX, y: imgY, el } = imgInfo;
    return {
      borderLeft:   leftX  - imgX,
      borderRight:  (imgX + el.naturalWidth)  - rightX,
      borderTop:    topY   - imgY,
      borderBottom: (imgY + el.naturalHeight) - bottomY,
    };
  })();

  const hGrade = centering ? grade(centering.borderLeft,  centering.borderRight)  : null;
  const vGrade = centering ? grade(centering.borderTop,   centering.borderBottom) : null;

  const vW = GUIDE_STROKE + HIT_PAD * 2;
  const hH = GUIDE_STROKE + HIT_PAD * 2;

  // ── render ───────────────────────────────────────────────────────────────
  return (
    <div style={{ position: "relative", width: size.width, height: size.height }}>

      {/* ── Konva canvas ── */}
      <Stage
        ref={stageRef}
        width={size.width}
        height={size.height}
        draggable
        dragBoundFunc={stageDragBound}
        onWheel={handleWheel}
        style={{ background: "#1a1a2e" }}
      >
        <Layer>
          {imgInfo && (
            <KonvaImage
              image={imgInfo.el}
              x={imgInfo.x}
              y={imgInfo.y}
              width={imgInfo.el.naturalWidth}
              height={imgInfo.el.naturalHeight}
            />
          )}

          {guides && (
            <>
              <Rect x={guides.leftX}  y={-EXTENT} width={vW}        height={EXTENT*2} offsetX={vW/2}
                    fill="transparent" stroke="#ff5050" strokeWidth={GUIDE_STROKE}
                    draggable onDragMove={onLeftDrag}   onMouseEnter={cursorEW} onMouseLeave={cursorGrab} />
              <Rect x={guides.rightX} y={-EXTENT} width={vW}        height={EXTENT*2} offsetX={vW/2}
                    fill="transparent" stroke="#ff5050" strokeWidth={GUIDE_STROKE}
                    draggable onDragMove={onRightDrag}  onMouseEnter={cursorEW} onMouseLeave={cursorGrab} />
              <Rect x={-EXTENT} y={guides.topY}    width={EXTENT*2} height={hH}       offsetY={hH/2}
                    fill="transparent" stroke="#50c8ff" strokeWidth={GUIDE_STROKE}
                    draggable onDragMove={onTopDrag}    onMouseEnter={cursorNS} onMouseLeave={cursorGrab} />
              <Rect x={-EXTENT} y={guides.bottomY} width={EXTENT*2} height={hH}       offsetY={hH/2}
                    fill="transparent" stroke="#50c8ff" strokeWidth={GUIDE_STROKE}
                    draggable onDragMove={onBottomDrag} onMouseEnter={cursorNS} onMouseLeave={cursorGrab} />
            </>
          )}
        </Layer>
      </Stage>

      {/* ── Floating overlay panel ── */}
      <div style={styles.panel}>

        {/* Open Scan button */}
        <button
          style={{ ...styles.openBtn, opacity: loading ? 0.6 : 1 }}
          onClick={handleOpenScan}
          disabled={loading}
        >
          {loading ? "Loading…" : "⊕  Open Scan"}
        </button>

        <p style={styles.panelTitle}>Centering</p>

        {centering ? (
          <>
            <div style={styles.row}>
              <span style={styles.label}>Left / Right</span>
              <span style={styles.value}>{centeringLabel(centering.borderLeft, centering.borderRight)}</span>
            </div>
            <div style={{ ...styles.row, marginBottom: 12 }}>
              <span style={styles.label}>Grade</span>
              <span style={{ ...styles.value, color: hGrade?.color, fontWeight: 700 }}>{hGrade?.label}</span>
            </div>
            <div style={styles.row}>
              <span style={styles.label}>Top / Bottom</span>
              <span style={styles.value}>{centeringLabel(centering.borderTop, centering.borderBottom)}</span>
            </div>
            <div style={styles.row}>
              <span style={styles.label}>Grade</span>
              <span style={{ ...styles.value, color: vGrade?.color, fontWeight: 700 }}>{vGrade?.label}</span>
            </div>
          </>
        ) : (
          <p style={{ color: "#888", fontSize: 13 }}>Loading image…</p>
        )}
      </div>
    </div>
  );
}

// ─── styles ──────────────────────────────────────────────────────────────────

const styles = {
  panel: {
    position:            "absolute"   as const,
    top:                 20,
    right:               20,
    width:               240,
    background:          "rgba(15, 15, 30, 0.82)",
    backdropFilter:      "blur(12px)",
    WebkitBackdropFilter:"blur(12px)",
    border:              "1px solid rgba(255,255,255,0.1)",
    borderRadius:        14,
    padding:             "16px 20px",
    color:               "#e8e8f0",
    fontFamily:          "'Inter', 'Segoe UI', sans-serif",
    fontSize:            14,
    boxShadow:           "0 8px 32px rgba(0,0,0,0.5)",
    userSelect:          "none" as const,
  },
  openBtn: {
    display:        "block",
    width:          "100%",
    marginBottom:   16,
    padding:        "9px 0",
    background:     "linear-gradient(135deg, #6366f1, #8b5cf6)",
    border:         "none",
    borderRadius:   9,
    color:          "#fff",
    fontFamily:     "inherit",
    fontSize:       13,
    fontWeight:     600,
    letterSpacing:  "0.03em",
    cursor:         "pointer",
    transition:     "filter 0.15s, transform 0.1s",
  },
  panelTitle: {
    margin:        "0 0 12px 0",
    fontSize:       11,
    fontWeight:     700,
    letterSpacing: "0.12em",
    textTransform: "uppercase" as const,
    color:          "#888",
  },
  row: {
    display:        "flex",
    justifyContent: "space-between",
    alignItems:     "center",
    marginBottom:   6,
  },
  label: { color: "#aaa", fontSize: 13 },
  value: { color: "#fff", fontSize: 13, fontVariantNumeric: "tabular-nums" },
} satisfies Record<string, React.CSSProperties>;
