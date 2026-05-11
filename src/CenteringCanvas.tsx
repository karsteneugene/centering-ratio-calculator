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

const placeholderSvg = `
  <svg width="600" height="800" xmlns="http://www.w3.org/2000/svg">
    <rect width="592" height="792" x="4" y="4" fill="#f8fafc" stroke="#cbd5e1" stroke-width="4" stroke-dasharray="12 12" rx="16" />
    <text x="50%" y="50%" font-family="system-ui, sans-serif" font-size="20" font-weight="600" fill="#94a3b8" text-anchor="middle" dominant-baseline="middle">
      Open a card scan to begin
    </text>
  </svg>
`;
const PLACEHOLDER_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(placeholderSvg)}`;

const HIT_PAD = 8;
const EXTENT = 12_000;
const MIN_GAP = 5; // Reduced gap so lines can get close for thin borders

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
    if (diff <= 0.80) return { label: "PSA 9",  color: "#86efac", score: 9 }; 
    return { label: "PSA 8 or lower", color: "#fb923c", score: 8 };
  } else {
    if (diff <= 0.10) return { label: "PSA 10", color: "#4ade80", score: 10 };
    if (diff <= 0.20) return { label: "PSA 9",  color: "#86efac", score: 9 }; 
    if (diff <= 0.30) return { label: "PSA 8",  color: "#fde047", score: 8 }; 
    if (diff <= 0.40) return { label: "PSA 7",  color: "#fb923c", score: 7 }; 
    if (diff <= 0.60) return { label: "PSA 6",  color: "#f87171", score: 6 }; 
    return { label: "PSA 5 or lower", color: "#ef4444", score: 5 };
  }
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

function centrePosition(img: HTMLImageElement) {
  return {
    x: (window.innerWidth  - img.naturalWidth)  / 2,
    y: (window.innerHeight - img.naturalHeight) / 2,
  };
}

// ─── component ───────────────────────────────────────────────────────────────

export default function CenteringCanvas() {
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });

  const stageRef = useRef<Konva.Stage>(null);
  const [imgInfo, setImgInfo] = useState<ImageInfo | null>(null);
  const [guides,  setGuides]  = useState<GuidePositions | null>(null);
  const [loading, setLoading] = useState(false);
  const [isBackSide, setIsBackSide] = useState(false);

  const guidesRef = useRef<GuidePositions | null>(null);
  useEffect(() => { guidesRef.current = guides; }, [guides]);

  const imgInfoRef = useRef<ImageInfo | null>(null);
  useEffect(() => { imgInfoRef.current = imgInfo; }, [imgInfo]);

  // ── resize listener ───────────────────────────────────────────────────────
  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ── safely shift image and guides on window resize ────────────────────────
  useEffect(() => {
    const currentImg = imgInfoRef.current;
    const currentGuides = guidesRef.current;

    if (!currentImg || !currentGuides) return;

    const newPos = centrePosition(currentImg.el);
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
    if (stage) {
      stage.scale({ x: 1, y: 1 });
      stage.position({ x: 0, y: 0 });
    }
  }, [size]);

  // ── apply image and reset guides ──────────────────────────────────────────
  const applyImage = useCallback((el: HTMLImageElement) => {
    const pos = centrePosition(el);
    setImgInfo({ el, x: pos.x, y: pos.y });
    
    // Set default positions for the 8 lines
    const outPad = 10; // Outer lines sit just inside the image bounds
    const inPad = 40;  // Inner lines sit further in
    
    setGuides({
      outerLeft:   pos.x + outPad,
      innerLeft:   pos.x + inPad,
      innerRight:  pos.x + el.naturalWidth  - inPad,
      outerRight:  pos.x + el.naturalWidth  - outPad,
      outerTop:    pos.y + outPad,
      innerTop:    pos.y + inPad,
      innerBottom: pos.y + el.naturalHeight - inPad,
      outerBottom: pos.y + el.naturalHeight - outPad,
    });
    
    const stage = stageRef.current;
    if (stage) {
      stage.scale({ x: 1, y: 1 });
      stage.position({ x: 0, y: 0 });
    }
  }, []);

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
      const el = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new window.Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed to load image: ${assetUrl}`));
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

  // ── wheel zoom ────────────────────────────────────────────────────────────
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
    const newScale = clamp(dir > 0 ? oldScale * ZOOM_FACTOR : oldScale / ZOOM_FACTOR, MIN_SCALE, MAX_SCALE);
    stage.scale({ x: newScale, y: newScale });
    stage.position({
      x: pointer.x - mousePointTo.x * newScale,
      y: pointer.y - mousePointTo.y * newScale,
    });
  }, []);

  const stageDragBound = useCallback((p: { x: number; y: number }) => p, []);

  // ── 8 guide drag handlers with constraints ─────────────────────────────────
  
  // X-Axis Drags
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

  // Y-Axis Drags
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

  const cursorEW   = useCallback(() => { stageRef.current?.container().style.setProperty("cursor", "ew-resize"); }, []);
  const cursorNS   = useCallback(() => { stageRef.current?.container().style.setProperty("cursor", "ns-resize"); }, []);
  const cursorGrab = useCallback(() => { stageRef.current?.container().style.setProperty("cursor", "grab"); }, []);

  // ── centering math & bottleneck logic ──────────────────────────────────────
  const centering = (() => {
    if (!guides) return null;
    const { outerLeft, innerLeft, innerRight, outerRight, outerTop, innerTop, innerBottom, outerBottom } = guides;
    
    return {
      borderLeft:   innerLeft - outerLeft,
      borderRight:  outerRight - innerRight,
      borderTop:    innerTop - outerTop,
      borderBottom: outerBottom - innerBottom,
    };
  })();

  const hGrade = centering ? getGrade(centering.borderLeft, centering.borderRight, isBackSide) : null;
  const vGrade = centering ? getGrade(centering.borderTop, centering.borderBottom, isBackSide) : null;
  const overallGrade = hGrade && vGrade ? (hGrade.score <= vGrade.score ? hGrade : vGrade) : null;

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ position: "relative", width: size.width, height: size.height, backgroundColor: "#ffffff" }}>
      <Stage ref={stageRef} width={size.width} height={size.height} draggable dragBoundFunc={stageDragBound} onWheel={handleWheel}>
        <Layer>
          {imgInfo && (
            <KonvaImage
              image={imgInfo.el}
              x={imgInfo.x}
              y={imgInfo.y}
              width={imgInfo.el.naturalWidth}
              height={imgInfo.el.naturalHeight}
              shadowColor="black"
              shadowBlur={10}
              shadowOpacity={0.2}
            />
          )}

          {guides && (
            <>
              {/* Outer Left (Green) */}
              <Line x={guides.outerLeft} y={0} points={[0, -EXTENT, 0, EXTENT]} stroke="#10b981" strokeWidth={1.5} listening={false} dash={[4, 4]} />
              <Line x={guides.outerLeft} y={0} points={[0, -EXTENT, 0, EXTENT]} stroke="transparent" strokeWidth={HIT_PAD * 2} draggable onDragMove={onOuterLeftDrag} onMouseEnter={cursorEW} onMouseLeave={cursorGrab} />

              {/* Inner Left (Red) */}
              <Line x={guides.innerLeft} y={0} points={[0, -EXTENT, 0, EXTENT]} stroke="#ff5050" strokeWidth={1} listening={false} />
              <Line x={guides.innerLeft} y={0} points={[0, -EXTENT, 0, EXTENT]} stroke="transparent" strokeWidth={HIT_PAD * 2} draggable onDragMove={onInnerLeftDrag} onMouseEnter={cursorEW} onMouseLeave={cursorGrab} />

              {/* Inner Right (Red) */}
              <Line x={guides.innerRight} y={0} points={[0, -EXTENT, 0, EXTENT]} stroke="#ff5050" strokeWidth={1} listening={false} />
              <Line x={guides.innerRight} y={0} points={[0, -EXTENT, 0, EXTENT]} stroke="transparent" strokeWidth={HIT_PAD * 2} draggable onDragMove={onInnerRightDrag} onMouseEnter={cursorEW} onMouseLeave={cursorGrab} />

              {/* Outer Right (Green) */}
              <Line x={guides.outerRight} y={0} points={[0, -EXTENT, 0, EXTENT]} stroke="#10b981" strokeWidth={1.5} listening={false} dash={[4, 4]} />
              <Line x={guides.outerRight} y={0} points={[0, -EXTENT, 0, EXTENT]} stroke="transparent" strokeWidth={HIT_PAD * 2} draggable onDragMove={onOuterRightDrag} onMouseEnter={cursorEW} onMouseLeave={cursorGrab} />


              {/* Outer Top (Green) */}
              <Line x={0} y={guides.outerTop} points={[-EXTENT, 0, EXTENT, 0]} stroke="#10b981" strokeWidth={1.5} listening={false} dash={[4, 4]} />
              <Line x={0} y={guides.outerTop} points={[-EXTENT, 0, EXTENT, 0]} stroke="transparent" strokeWidth={HIT_PAD * 2} draggable onDragMove={onOuterTopDrag} onMouseEnter={cursorNS} onMouseLeave={cursorGrab} />

              {/* Inner Top (Blue) */}
              <Line x={0} y={guides.innerTop} points={[-EXTENT, 0, EXTENT, 0]} stroke="#50c8ff" strokeWidth={1} listening={false} />
              <Line x={0} y={guides.innerTop} points={[-EXTENT, 0, EXTENT, 0]} stroke="transparent" strokeWidth={HIT_PAD * 2} draggable onDragMove={onInnerTopDrag} onMouseEnter={cursorNS} onMouseLeave={cursorGrab} />

              {/* Inner Bottom (Blue) */}
              <Line x={0} y={guides.innerBottom} points={[-EXTENT, 0, EXTENT, 0]} stroke="#50c8ff" strokeWidth={1} listening={false} />
              <Line x={0} y={guides.innerBottom} points={[-EXTENT, 0, EXTENT, 0]} stroke="transparent" strokeWidth={HIT_PAD * 2} draggable onDragMove={onInnerBottomDrag} onMouseEnter={cursorNS} onMouseLeave={cursorGrab} />

              {/* Outer Bottom (Green) */}
              <Line x={0} y={guides.outerBottom} points={[-EXTENT, 0, EXTENT, 0]} stroke="#10b981" strokeWidth={1.5} listening={false} dash={[4, 4]} />
              <Line x={0} y={guides.outerBottom} points={[-EXTENT, 0, EXTENT, 0]} stroke="transparent" strokeWidth={HIT_PAD * 2} draggable onDragMove={onOuterBottomDrag} onMouseEnter={cursorNS} onMouseLeave={cursorGrab} />
            </>
          )}
        </Layer>
      </Stage>

      {/* ── Floating overlay panel ── */}
      <div style={styles.panel}>
        <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
          <button style={{ ...styles.actionBtn, flex: 1, opacity: loading ? 0.6 : 1, background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }} onClick={handleOpenScan} disabled={loading}>
            {loading ? "…" : "Open Scan"}
          </button>
          <button style={{ ...styles.actionBtn, flex: 1, background: isBackSide ? "#4b5563" : "#3b82f6", border: isBackSide ? "1px solid #6b7280" : "1px solid #60a5fa" }} onClick={() => setIsBackSide(!isBackSide)}>
            {isBackSide ? "Back Side" : "Front Side"}
          </button>
        </div>

        {centering && overallGrade ? (
          <>
            <div style={styles.section}>
              <p style={styles.panelTitle}>Measurements</p>
              <div style={styles.row}>
                <span style={styles.label}>Left / Right</span>
                <span style={styles.value}>{centeringLabel(centering.borderLeft, centering.borderRight)}</span>
              </div>
              <div style={styles.row}>
                <span style={styles.label}>Top / Bottom</span>
                <span style={styles.value}>{centeringLabel(centering.borderTop, centering.borderBottom)}</span>
              </div>
            </div>

            <div style={{ ...styles.section, background: "rgba(0,0,0,0.2)", padding: "12px", borderRadius: "8px", marginTop: "12px" }}>
              <p style={{ ...styles.panelTitle, color: "#fff", textAlign: "center", marginBottom: "4px" }}>Estimated Centering</p>
              <p style={{ textAlign: "center", fontSize: "20px", fontWeight: 800, color: overallGrade.color, margin: 0 }}>
                {overallGrade.label}
              </p>
            </div>
          </>
        ) : (
          <p style={{ color: "#888", fontSize: 13, textAlign: "center" }}>Loading image…</p>
        )}
      </div>
    </div>
  );
}

// ─── styles ──────────────────────────────────────────────────────────────────

const styles = {
  panel: { position: "absolute" as const, top: 20, right: 20, width: 280, background: "rgba(20, 20, 25, 0.9)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 14, padding: "16px 20px", color: "#e8e8f0", fontFamily: "'Inter', 'Segoe UI', sans-serif", fontSize: 14, boxShadow: "0 8px 32px rgba(0,0,0,0.5)", userSelect: "none" as const },
  actionBtn: { display: "block", padding: "9px 0", border: "none", borderRadius: 8, color: "#fff", fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer", transition: "all 0.15s" },
  section: { marginBottom: "8px" },
  panelTitle: { margin: "0 0 8px 0", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" as const, color: "#888" },
  row: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
  label: { color: "#aaa", fontSize: 13 },
  value: { color: "#fff", fontSize: 13, fontVariantNumeric: "tabular-nums", fontWeight: 600 },
} satisfies Record<string, React.CSSProperties>;