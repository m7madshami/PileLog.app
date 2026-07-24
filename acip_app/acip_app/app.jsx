const { useState, useRef, useEffect, useLayoutEffect } = React;

// ── Helpers ───────────────────────────────────────────────────────────────────
const nowStr = () => new Date().toLocaleTimeString("en-US", { hour:"2-digit", minute:"2-digit" });
const fmtTime = (s) => `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`;

// ── Pile-type memory ─────────────────────────────────────────────────────────
// Remembers the typical field values last used for each Pile Type (e.g. "PC4"
// vs "PC6"). When the user changes a pile's type, its remembered values are
// applied — so switching between two pile types on the same site doesn't drag
// over the wrong diameter/capacity/etc. from whichever type was drilled last.
const TYPE_MEMORY_FIELDS = ["pileDiameter","groundElevation","pileCapacity","capThickness","reinfSteel","groutStrength","groutSupplier","productCode","flow"];
const loadTypeMemory = () => { try { return JSON.parse(localStorage.getItem("acip_pile_type_memory")) || {}; } catch(e) { return {}; } };
const saveTypeMemory = (pile) => {
  if (!pile.pileType) return;
  try {
    const mem = loadTypeMemory();
    const entry = mem[pile.pileType] || {};
    TYPE_MEMORY_FIELDS.forEach(k => { if (pile[k]) entry[k] = pile[k]; });
    mem[pile.pileType] = entry;
    localStorage.setItem("acip_pile_type_memory", JSON.stringify(mem));
  } catch(e) {}
};
const applyTypeMemory = (pile, pileType) => {
  const mem = loadTypeMemory()[pileType];
  if (!mem) return { ...pile, pileType };
  const next = { ...pile, pileType };
  TYPE_MEMORY_FIELDS.forEach(k => { if (mem[k]) next[k] = mem[k]; });
  return next;
};

const emptyFoot = (n) => ({ foot: n, seconds: null, knm: "", note: "" });

// Actual drilled depth = the depth value of the last logged foot. Each foot
// entry stores its own absolute depth (`.foot`), so this works correctly even
// if the recording interval was switched mid-pile (e.g. 5ft → 1ft near the
// bottom to land on a depth that isn't a multiple of 5).
const depthFt = (pile) => {
  const feet = pile.feet || [];
  if (feet.length) return feet[feet.length - 1].foot;
  return 0;
};

// Repair corrupted foot depths. A bug in an earlier build's Prev/Next
// navigation could overwrite a foot's record with its neighbor's, producing
// duplicate depths (e.g. 2ft, 2ft, 3ft). Depths must be strictly increasing,
// so walk backward from the end: whenever an entry's depth is >= the next
// one's, renumber it to (next depth − local spacing), where local spacing is
// taken from the nearest valid gap ahead (falls back to the pile's recording
// interval). Data after the corrupted rows is untouched.
const repairFeet = (pile) => {
  const feet = pile.feet || [];
  if (feet.length < 2) return pile;
  let dirty = false;
  const fixed = feet.map(f => ({ ...f }));
  for (let i = fixed.length - 2; i >= 0; i--) {
    if (fixed[i].foot >= fixed[i+1].foot) {
      const gapAhead = (i + 2 < fixed.length) ? (fixed[i+2].foot - fixed[i+1].foot) : 0;
      const gap = gapAhead > 0 ? gapAhead : (pile.footInterval || 1);
      fixed[i].foot = fixed[i+1].foot - gap;
      dirty = true;
    }
  }
  return dirty ? { ...pile, feet: fixed } : pile;
};

// Snap the page to top and lock body scroll while a fixed-position modal is
// open — iOS Safari anchors position:fixed to the layout viewport, which can
// sit below the visible area if the page was scrolled when the modal opened.
function useModalScrollLock(active) {
  useEffect(() => {
    if (!active) return;
    const prevOverflow = document.body.style.overflow;
    const prevY = window.scrollY;
    window.scrollTo(0, 0);
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prevOverflow; window.scrollTo(0, prevY); };
  }, [active]);
}

// Grout bands go from drillDepth DOWN to 0 (ground surface), every `interval` ft
const buildGroutBands = (drillDepth, interval = 5) => {
  const bands = [];
  // bottom first
  bands.push({ depth: drillDepth, strokes: "", label: `Bottom (${drillDepth}ft)` });
  // then every `interval` ft coming up, including ground surface at 0
  let d = Math.floor(drillDepth / interval) * interval;
  if (d === drillDepth) d -= interval;
  while (d >= 0) {
    bands.push({ depth: d, strokes: "", label: d === 0 ? "Ground (0ft)" : `${d}ft` });
    d -= interval;
  }
  return bands;
};

const emptyPile = () => ({
  id: Date.now() + Math.random(),
  pileNo: "",
  drillStart: null, drillEnd: null, groutStart: null, groutEnd: null,
  drillStartEpoch: null, footStartEpoch: null, pausedAt: null,
  feet: [],
  groutBands: [],
  refusalDepth: null,
  notInstalled: false,           // marked when a pile has to be redrilled — shows "Not Installed" in summary
  pileKind: "ACIP",              // "ACIP" | "RI" (Rigid Inclusion — unreinforced)
  footInterval: 1,               // record seconds/torque every N ft (1 or 5)
  groutInterval: 5,              // grout band spacing in ft (5 or 10)
  pileType: "PC4", pileDiameter: "24", groundElevation: "",
  pileCapacity: "", capThickness: "", pileLength: "", drillDepth: "", tipElevation: "",
  cutoffElevation: "", theoreticalVol: "", totalStrokes: "",
  actualVolume: "", groutFactor: "",
  reinfSteel: "PC4", groutStrength: "5,000psi",
  trucks: Array.from({ length: 3 }, () => ({ no:"", ticket:"", qty:"", batch:"" })),
  flow: "", batchTime: "",
  groutSupplier: "PEGASUS CONCRETE", productCode: "",
  slurryAt: "", groutAt: "", notes: "",
});

const emptyProject = () => ({
  projectName: "", projectNo: "", location: "",
  pilingContractor: "", date: new Date().toLocaleDateString("en-US"),
  inspector: "", equipment: "",
  pumpCalibFactor: "", lastCalibDate: "",
});

// ── Derived values ────────────────────────────────────────────────────────────
// Total Strokes Pumped = cumulative strokes at ground level (0 ft)
// Actual Volume (ft³)  = total strokes × pump calibration (ft³/stroke)
// Theoretical Vol (ft³)= 3.14·(dia/2)² · drill depth   (π=3.14 per Langan hand-calc convention; dia in inches → ft)
// Grout Factor         = actual / theoretical
// Tip Elevation (ft)   = ground elevation − drill depth
// Manual entries in the Details tab always take priority over computed values.
const PI_LANGAN = 3.14;
const round2 = (n) => Math.round(n * 100) / 100;
const calcDerived = (pile, project) => {
  const dia = parseFloat(pile.pileDiameter);
  // Manually entered Drill Depth wins over the tap log — if the inspector
  // corrects the depth in Details, every derived value follows that entry.
  const drilledFt = parseFloat(pile.drillDepth) || depthFt(pile) || 0;
  const drillDepth = pile.drillDepth || (drilledFt ? String(drilledFt) : "");
  const theoretical = pile.theoreticalVol ||
    ((!isNaN(dia) && drilledFt) ? String(round2(PI_LANGAN * Math.pow(dia/24, 2) * drilledFt)) : "");
  const groundEl = parseFloat(pile.groundElevation);
  // Tip Elevation = Ground Elevation − Drilled Depth
  const tipElevation = pile.tipElevation ||
    ((!isNaN(groundEl) && drilledFt) ? String(round2(groundEl - drilledFt)) : "");
  const capThickness = parseFloat(pile.capThickness);
  // Cutoff Elevation = Ground Elevation − Pile Cap Thickness
  const cutoffElevation = pile.cutoffElevation ||
    ((!isNaN(groundEl) && !isNaN(capThickness)) ? String(round2(groundEl - capThickness)) : "");
  // Pile Length = Cutoff Elevation − Tip Elevation
  const cutoffNum = parseFloat(cutoffElevation), tipNum = parseFloat(tipElevation);
  const pileLength = pile.pileLength ||
    ((!isNaN(cutoffNum) && !isNaN(tipNum)) ? String(round2(cutoffNum - tipNum)) : "");
  const groundBand = (pile.groutBands||[]).find(b => b.depth === 0);
  const totalStrokes = pile.totalStrokes || (groundBand?.strokes ? String(groundBand.strokes) : "");
  const calibFactor = parseFloat(project.pumpCalibFactor) > 0 ? parseFloat(project.pumpCalibFactor) : null;
  const actual = pile.actualVolume ||
    ((totalStrokes && calibFactor) ? String(round2(parseFloat(totalStrokes) * calibFactor)) : "");
  const groutFactor = pile.groutFactor ||
    ((actual && theoretical && parseFloat(theoretical) > 0) ? String(round2(parseFloat(actual) / parseFloat(theoretical))) : "");
  return { drillDepth, theoretical, totalStrokes, actual, groutFactor, calibFactor, tipElevation, cutoffElevation, pileLength };
};

// ── KNm Torque Slider (vertical) ──────────────────────────────────────────────
// Only hard drilling matters: default "<75" (not recorded), then 80→180 in 5s.
// Big value readout sits above the track so it's never covered by a thumb.
const KNM_VALUES = ["<75", ...Array.from({ length: 21 }, (_, i) => String(80 + i * 5))];
const DEFAULT_KNM_IDX = 0;

function KnmWheel({ value, onChange }) {
  const initIdx = value ? Math.max(0, KNM_VALUES.indexOf(String(value))) : DEFAULT_KNM_IDX;
  const [idx, setIdx] = useState(initIdx);
  const trackRef = useRef(null);
  const draggingRef = useRef(false);
  const TRACK_H = 140;
  const N = KNM_VALUES.length;

  // Keep in sync if the parent's value changes from outside (e.g. carried
  // forward from the previous foot).
  useEffect(() => {
    const i = value ? Math.max(0, KNM_VALUES.indexOf(String(value))) : DEFAULT_KNM_IDX;
    if (!draggingRef.current) setIdx(i);
  }, [value]);

  const commitIdx = (i) => {
    const c = Math.max(0, Math.min(N - 1, Math.round(i)));
    setIdx(c);
    const val = KNM_VALUES[c];
    onChange(val === "<75" ? "" : val);
  };

  // Map a pointer Y position on the track to an index: top = max (180K),
  // bottom = min (<75) — pushing up = more torque, like a throttle.
  const yToIdx = (clientY) => {
    const rect = trackRef.current.getBoundingClientRect();
    const frac = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    return frac * (N - 1);
  };

  const onPointerDown = (e) => {
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    commitIdx(yToIdx(e.clientY));
  };
  const onPointerMove = (e) => {
    if (!draggingRef.current) return;
    commitIdx(yToIdx(e.clientY));
  };
  const onPointerUp = () => { draggingRef.current = false; };

  const isHigh = parseInt(KNM_VALUES[idx]) > 75;
  const curVal = KNM_VALUES[idx];
  // Thumb position: idx 0 at bottom, max at top
  const thumbY = (1 - idx / (N - 1)) * TRACK_H;

  const nudgeBtn = (dir, disabled) => ({
    width:64, padding:"8px 0", borderRadius:10, border:"none",
    cursor: disabled ? "default" : "pointer",
    background: disabled ? "#122636" : "#1e4a73", color:"#fff",
    fontSize:18, fontWeight:900, opacity: disabled ? 0.35 : 1
  });

  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", userSelect:"none" }}>
      <div style={{ fontSize:11, fontWeight:700, color:"#a8c0d9", marginBottom:4 }}>KNm Torque</div>
      {/* Value readout — always visible above the track, never covered by a finger */}
      <div style={{
        fontSize: curVal==="<75" ? 15 : 24, fontWeight:900,
        color: isHigh ? "#e74c3c" : "#fff", minHeight:30, marginBottom:4,
        display:"flex", alignItems:"center", justifyContent:"center"
      }}>
        {curVal}{curVal!=="<75" ? "K" : ""}
      </div>
      {/* Fine-tune: slider for coarse, +/− for single-step precision */}
      <button onClick={() => commitIdx(idx + 1)} disabled={idx >= N-1} style={{ ...nudgeBtn("+", idx >= N-1), marginBottom:5 }}>+</button>
      <div
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{
          width:64, height:TRACK_H, position:"relative", borderRadius:14,
          background:"linear-gradient(to top, #0d2236, #1e3a56 60%, #4a1510)",
          border:"2px solid "+(isHigh?"#e74c3c":"#2d6a9f"),
          cursor:"ns-resize", touchAction:"none"
        }}
      >
        {/* tick marks at 100K and 150K for orientation */}
        {[100,150].map(v=>{
          const i = KNM_VALUES.indexOf(String(v));
          const ty = (1 - i/(N-1)) * TRACK_H;
          return <div key={v} style={{ position:"absolute", top:ty-1, left:4, right:4, height:1, background:"#3a5268", pointerEvents:"none" }}/>;
        })}
        {/* thumb */}
        <div style={{
          position:"absolute", top:Math.max(0,Math.min(TRACK_H-18,thumbY-9)), left:3, right:3, height:18,
          borderRadius:9, background: isHigh ? "#e74c3c" : "#4a90d9",
          boxShadow:"0 2px 8px rgba(0,0,0,0.5)", pointerEvents:"none"
        }}/>
      </div>
      <button onClick={() => commitIdx(idx - 1)} disabled={idx <= 0} style={{ ...nudgeBtn("−", idx <= 0), marginTop:5 }}>−</button>
      <div style={{ marginTop:4, fontSize:11, fontWeight:700, color: isHigh?"#e74c3c":"#4a7fa5", minHeight:16 }}>
        {isHigh ? "⚠ HIGH" : ""}
      </div>
    </div>
  );
}

// ── Numpad modal ──────────────────────────────────────────────────────────────
function Numpad({ label, initialValue, onConfirm, onCancel }) {
  const [val, setVal] = useState(initialValue || "");
  useModalScrollLock(true);
  const tap = (k) => {
    if (k === "⌫") setVal(v => v.slice(0, -1));
    else if (k === "✓") onConfirm(val);
    else setVal(v => (v + k).slice(0, 5));
  };
  const keys = ["1","2","3","4","5","6","7","8","9","⌫","0","✓"];
  return (
    <div style={{ position:"fixed", top:0, left:0, width:"100vw", height:"100dvh", background:"rgba(0,0,0,0.75)", zIndex:400, display:"flex", alignItems:"center", justifyContent:"center" }}>
      <div style={{ background:"#1a3a5c", borderRadius:20, padding:22, width:290, boxShadow:"0 8px 40px rgba(0,0,0,0.6)" }}>
        <div style={{ color:"#fff", fontSize:22, marginBottom:10, textAlign:"center", fontWeight:900, lineHeight:1.25 }}>{label}</div>
        <div style={{ background:"#071520", borderRadius:12, padding:"14px 16px", fontSize:40, fontWeight:900, color:"#fff", textAlign:"center", marginBottom:18, minHeight:60 }}>
          {val || <span style={{ color:"#2d4a5c" }}>0</span>}
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:10 }}>
          {keys.map(k => (
            <button key={k} onClick={() => tap(k)} style={{
              padding:"18px 0", borderRadius:12, border:"none", cursor:"pointer", fontSize:22, fontWeight:800,
              background: k==="✓" ? "#27ae60" : k==="⌫" ? "#922b21" : "#2d5a8a", color:"#fff"
            }}>{k}</button>
          ))}
        </div>
        <button onClick={onCancel} style={{ width:"100%", marginTop:12, padding:12, borderRadius:10, border:"none", background:"#0d2236", color:"#a8c0d9", cursor:"pointer", fontSize:14 }}>Cancel</button>
      </div>
    </div>
  );
}

// ── Fill Missing Seconds — fast backfill for arrived-late / zero-second feet ──
const missingFeet = (pile) => (pile.feet||[]).filter(f => f.seconds == null || f.seconds === 0).map(f => f.foot);

function FillSecondsModal({ pile, onUpdate, onClose }) {
  const [currentFoot, setCurrentFoot] = useState(() => missingFeet(pile)[0] ?? null);
  const [val, setVal] = useState("");

  if (currentFoot == null) { onClose(); return null; }
  const remaining = missingFeet(pile).length;

  const advance = (feet, fromFoot) => {
    const list = feet.filter(f => (f.seconds == null || f.seconds === 0) && f.foot !== fromFoot).map(f => f.foot);
    const next = list.find(n => n > fromFoot) ?? list[0];
    if (next != null) { setCurrentFoot(next); setVal(""); } else onClose();
  };

  const saveAndNext = () => {
    const secs = parseInt(val);
    if (isNaN(secs)) return;
    const newFeet = pile.feet.map(f => f.foot === currentFoot ? { ...f, seconds: secs } : f);
    onUpdate({ ...pile, feet: newFeet });
    advance(newFeet, currentFoot);
  };
  const skip = () => advance(pile.feet, currentFoot);

  const tap = (k) => {
    if (k === "⌫") setVal(v => v.slice(0, -1));
    else setVal(v => (v + k).slice(0, 4));
  };
  const keys = ["1","2","3","4","5","6","7","8","9","","0","⌫"];

  return (
    <div style={{ position:"fixed", top:0, left:0, width:"100vw", height:"100dvh", background:"rgba(0,0,0,0.8)", zIndex:300, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}>
      <div style={{ background:"#1a3a5c", borderRadius:20, padding:22, width:290, boxShadow:"0 8px 40px rgba(0,0,0,0.6)" }}>
        <div style={{ color:"#fff", fontSize:17, fontWeight:900, textAlign:"center" }}>⏱ Foot {currentFoot} — Seconds</div>
        <div style={{ color:"#a8c0d9", fontSize:12, textAlign:"center", marginBottom:10 }}>{remaining} foot{remaining!==1?"s":""} missing seconds</div>
        <div style={{ background:"#071520", borderRadius:12, padding:"12px 16px", fontSize:38, fontWeight:900, color:"#fff", textAlign:"center", marginBottom:14, minHeight:56 }}>
          {val || <span style={{ color:"#2d4a5c" }}>0</span>}<span style={{ fontSize:18, color:"#4a7fa5" }}> s</span>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8, marginBottom:12 }}>
          {keys.map((k,i) => k === "" ? <div key={i}/> : (
            <button key={i} onClick={() => tap(k)} style={{
              padding:"16px 0", borderRadius:12, border:"none", cursor:"pointer", fontSize:20, fontWeight:800,
              background: k === "⌫" ? "#922b21" : "#2d5a8a", color:"#fff"
            }}>{k}</button>
          ))}
        </div>
        <button onClick={saveAndNext} disabled={!val} style={{
          width:"100%", padding:15, borderRadius:12, border:"none",
          background: val ? "#27ae60" : "#26445c", color: val ? "#fff" : "#4a7fa5",
          fontSize:16, fontWeight:900, cursor: val ? "pointer" : "default", marginBottom:8
        }}>✓ Save & Next</button>
        <div style={{ display:"flex", gap:8 }}>
          <button onClick={skip} style={{ flex:1, padding:12, borderRadius:10, border:"1px solid #2d4a5c", background:"#0d2236", color:"#a8c0d9", fontSize:13, cursor:"pointer", fontWeight:700 }}>Skip →</button>
          <button onClick={onClose} style={{ flex:1, padding:12, borderRadius:10, border:"1px solid #2d4a5c", background:"#0d2236", color:"#a8c0d9", fontSize:13, cursor:"pointer", fontWeight:700 }}>Done</button>
        </div>
      </div>
    </div>
  );
}

// ── Drilling Screen ───────────────────────────────────────────────────────────
// ── Foot Edit Modal (shared) ──────────────────────────────────────────────────
// One popup only — tapping Seconds or KNm swaps the same modal into a numpad
// for that field (never stacks a second overlay on top). Scroll-locks itself
// on open so it always renders centered in the visible viewport.
function FootEditModal({ pile, foot, feetList, onUpdate, onClose }) {
  const [local, setLocal] = useState(foot);
  // Track the position being edited in STATE — deriving it from the `foot`
  // prop was a serious bug: the prop never changes during Prev/Next
  // navigation, so every save landed on the original row, overwriting
  // neighboring feet with each other's records (duplicate depths like
  // 2ft/2ft). curIdx moves with the navigation; saves land where the user
  // actually is.
  const [curIdx, setCurIdx] = useState(() => feetList.findIndex(f => f.foot === foot.foot));
  const [editing, setEditing] = useState(null); // null | "seconds" | "knm"
  useModalScrollLock(true);

  const atFirst = curIdx <= 0, atLast = curIdx === -1 || curIdx >= (pile.feet||[]).length - 1;

  const saveAndGo = (targetIdx) => {
    const newFeet = pile.feet.map((f,i) => i === curIdx ? local : f);
    onUpdate({ ...pile, feet: newFeet });
    if (targetIdx != null && newFeet[targetIdx]) {
      setLocal({ ...newFeet[targetIdx] });
      setCurIdx(targetIdx);
      setEditing(null);
    }
    else onClose();
  };

  if (editing) {
    const isSecs = editing === "seconds";
    return (
      <Numpad
        label={isSecs ? `Seconds at ${local.foot}ft` : `KNm Torque at ${local.foot}ft`}
        initialValue={isSecs ? (local.seconds!=null ? String(local.seconds) : "") : (local.knm||"")}
        onConfirm={(v) => {
          setLocal(f => isSecs ? { ...f, seconds: v==="" ? null : Number(v) } : { ...f, knm: v });
          setEditing(null);
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  const hi = local.knm && parseInt(local.knm) > 75;
  const footLabel = (pile.footInterval||1) > 1 ? `Depth ${local.foot}ft` : `Foot ${local.foot}`;
  const cellStyle = (danger) => ({
    width:"100%", padding:"14px", borderRadius:8, border:`1px solid ${danger?"#e74c3c":"#2d4a5c"}`,
    background:"#071520", fontSize:20, fontWeight:800, boxSizing:"border-box", marginBottom:14,
    cursor:"pointer", display:"flex", justifyContent:"space-between", alignItems:"center"
  });

  return (
    <div style={{ position:"fixed", top:0, left:0, width:"100vw", height:"100dvh", background:"rgba(0,0,0,0.75)", zIndex:300, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}>
      <div style={{ background:"#132536", borderRadius:18, padding:22, width:"100%", maxWidth:360, boxShadow:"0 8px 32px rgba(0,0,0,0.5)" }}>
        <div style={{ color:"#fff", fontWeight:900, fontSize:17, marginBottom:16 }}>Edit {footLabel}</div>

        <div style={{ color:"#a8c0d9", fontSize:12, fontWeight:700, marginBottom:4 }}>Seconds</div>
        <div onClick={() => setEditing("seconds")} style={{ ...cellStyle(false), color: local.seconds!=null ? "#fff" : "#4a7fa5" }}>
          <span>{local.seconds!=null ? `${local.seconds}s` : "tap to enter"}</span>
          <span style={{ fontSize:13, color:"#4a7fa5" }}>⌨ numpad</span>
        </div>

        <div style={{ color:"#a8c0d9", fontSize:12, fontWeight:700, marginBottom:4 }}>KNm Torque (blank = none)</div>
        <div onClick={() => setEditing("knm")} style={{ ...cellStyle(hi), color: hi ? "#e74c3c" : local.knm ? "#fff" : "#4a7fa5" }}>
          <span>{local.knm ? `${local.knm}K${hi?" ⚠":""}` : "tap to enter"}</span>
          <span style={{ fontSize:13, color:"#4a7fa5" }}>⌨ numpad</span>
        </div>

        <div style={{ display:"flex", gap:8, marginBottom:8 }}>
          <button disabled={atFirst} onClick={() => saveAndGo(curIdx - 1)}
            style={{ flex:1, padding:12, borderRadius:10, border:"1px solid #2d4a5c", background: atFirst ? "#0a1a29" : "#0d2236", color: atFirst ? "#2d4a5c" : "#a8c0d9", fontSize:14, cursor: atFirst ? "default" : "pointer", fontWeight:700 }}
          >◀ Prev</button>
          <button onClick={() => saveAndGo(null)} style={{ flex:1.4, padding:12, borderRadius:10, border:"none", background:"#27ae60", color:"#fff", fontSize:14, cursor:"pointer", fontWeight:800 }}>✓ Done</button>
          <button disabled={atLast} onClick={() => saveAndGo(curIdx + 1)}
            style={{ flex:1, padding:12, borderRadius:10, border:"1px solid #2d4a5c", background: atLast ? "#0a1a29" : "#0d2236", color: atLast ? "#2d4a5c" : "#a8c0d9", fontSize:14, cursor: atLast ? "default" : "pointer", fontWeight:700 }}
          >Next ▶</button>
        </div>
        <button onClick={onClose} style={{ width:"100%", padding:10, borderRadius:10, border:"none", background:"transparent", color:"#6a8caf", fontSize:12, cursor:"pointer" }}>Cancel without saving this foot</button>
      </div>
    </div>
  );
}

function DrillScreen({ pile, onUpdate }) {
  // Phase & timing derive entirely from persisted pile data — survives
  // reloads, tab discards, and re-renders (fixes the "huge timer" bug).
  const phase = !pile.drillStart ? "idle" : pile.drillEnd ? "done" : pile.pausedAt ? "paused" : "drilling";
  const [, tick] = useState(0); // re-render every 250ms while drilling
  const [currentKnm, setCurrentKnm] = useState("");

  const [showRefusal, setShowRefusal] = useState(false);
  const [showLateStart, setShowLateStart] = useState(false);

  useEffect(() => {
    if (phase !== "drilling") return;
    const id = setInterval(() => tick(t => t + 1), 250);
    return () => clearInterval(id);
  }, [phase]);

  const refNow = phase === "paused" ? pile.pausedAt : Date.now();
  const elapsed = pile.drillStartEpoch ? Math.max(0, Math.floor((refNow - pile.drillStartEpoch) / 1000)) : 0;
  const footTimer = pile.footStartEpoch ? Math.max(0, Math.floor((refNow - pile.footStartEpoch) / 1000)) : 0;

  const startDrilling = () => {
    const now = Date.now();
    onUpdate({ ...pile, drillStart: nowStr(), drillStartEpoch: now, footStartEpoch: now, pausedAt: null });
  };

  // Arrived late: rig is already at `depth` ft. Create blank feet 1..depth
  // (seconds null, backfill later via ✏️ edit), start live counting from depth+1.
  const startAtDepth = (val) => {
    const depth = parseInt(val);
    setShowLateStart(false);
    if (isNaN(depth) || depth < 1) return;
    const now = Date.now();
    const missedFeet = Array.from({ length: depth }, (_, i) => ({ foot: i+1, seconds: null, knm:"", note:"" }));
    onUpdate({ ...pile, drillStart: nowStr(), drillStartEpoch: now, footStartEpoch: now, pausedAt: null, feet: missedFeet });
  };

  const pause = () => onUpdate({ ...pile, pausedAt: Date.now() });
  const resume = () => {
    // Shift both anchors forward by the pause duration so timers exclude it
    const pausedFor = Date.now() - pile.pausedAt;
    onUpdate({ ...pile, drillStartEpoch: pile.drillStartEpoch + pausedFor, footStartEpoch: pile.footStartEpoch + pausedFor, pausedAt: null });
  };

  const tapFoot = () => {
    if (phase !== "drilling") return;
    // Haptic pulse confirms the tap registered without needing to look at the
    // screen (no-op on devices without vibration support, e.g. iPads).
    try { if (navigator.vibrate) navigator.vibrate(40); } catch(e) {}
    const interval = pile.footInterval || 1;
    const now = Date.now();
    const secs = Math.max(0, Math.floor((now - pile.footStartEpoch) / 1000));
    // Next depth = last logged depth + current interval (not count×interval),
    // so switching the interval mid-pile lands correctly instead of assuming
    // every foot so far used today's interval.
    const lastDepth = depthFt(pile);
    const newFoot = emptyFoot(lastDepth + interval);
    newFoot.seconds = secs;
    newFoot.knm = currentKnm;
    newFoot.note = "";
    onUpdate({ ...pile, feet: [...(pile.feet || []), newFoot], footStartEpoch: now });
    // Carry the current torque value into the next foot as its starting
    // point (rig conditions rarely reset foot-to-foot), instead of snapping to 0.
  };

  const undoLastFoot = () => {
    if (!pile.feet?.length) return;
    onUpdate({ ...pile, feet: pile.feet.slice(0, -1), footStartEpoch: Date.now() });
  };

  const confirmRefusal = () => {
    const ft = depthFt(pile);
    const note = `Drilling terminated — refusal at ${ft}ft`;
    const bands = buildGroutBands(ft, pile.groutInterval || 5);
    onUpdate({ ...pile, drillEnd: nowStr(), pausedAt: null, refusalDepth: ft, groutBands: bands, notes: pile.notes ? pile.notes + "\n" + note : note });
    setShowRefusal(false);
  };

  const finishDrilling = () => {
    const depth = depthFt(pile);
    // Irreversible phase change — confirm to protect against an accidental tap
    if (!window.confirm(`Finish drilling at ${depth} ft and move to grouting?`)) return;
    const bands = buildGroutBands(depth, pile.groutInterval || 5);
    onUpdate({ ...pile, drillEnd: nowStr(), pausedAt: null, groutBands: bands });
  };

  const feet = pile.feet || [];
  const currentFoot = feet.length + 1;
  const [editingFoot, setEditingFoot] = useState(null); // foot object being edited
  const [showFullLog, setShowFullLog] = useState(false);
  const [showFillSecs, setShowFillSecs] = useState(false);

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>

      {/* ── Status row ── */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
        {[
          ["Total Time", phase==="paused" ? "⏸ PAUSED" : fmtTime(elapsed), phase==="paused" ? "#f39c12" : "#fff"],
          ["Depth", `${depthFt(pile)} ft`, "#4fc3f7"],
          ["This Foot", phase==="paused" ? "—" : `${footTimer}s`, "#fff"],
        ].map(([label, val, color]) => (
          <div key={label} style={{ background:"#071520", borderRadius:10, padding:"8px 6px", textAlign:"center" }}>
            <div style={{ color:"#4a7fa5", fontSize:10 }}>{label}</div>
            <div style={{ color, fontSize:20, fontWeight:900, fontVariantNumeric:"tabular-nums" }}>{val}</div>
          </div>
        ))}
      </div>

      {/* ── Main area: tap button + KNm wheel side by side ── */}
      {phase !== "done" && (
        <div style={{ display:"flex", gap:10, alignItems:"stretch" }}>
          {/* +1ft button */}
          <button
            onClick={tapFoot}
            disabled={phase !== "drilling"}
            style={{
              flex:1, borderRadius:16, border:"none", cursor: phase==="drilling" ? "pointer" : "default",
              background: phase==="idle" ? "#1a3a5c" : phase==="paused" ? "#7a5c00" : "#1a6b3c",
              color:"#fff", fontWeight:900, lineHeight:1.2,
              boxShadow: phase==="drilling" ? "0 4px 20px rgba(26,107,60,0.5)" : "none",
              opacity: phase==="drilling" ? 1 : 0.6,
              minHeight:130, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center"
            }}
          >
            {phase === "idle" && <span style={{ fontSize:16, color:"#a8c0d9" }}>Start drilling first</span>}
            {phase === "paused" && <><span style={{ fontSize:30 }}>⏸</span><span style={{ fontSize:16, color:"#f0c040" }}>Paused</span></>}
            {phase === "drilling" && <><span style={{ fontSize:52 }}>+{pile.footInterval||1}ft</span><span style={{ fontSize:14, color:"#a8d9b8", marginTop:4 }}>Tap per {pile.footInterval===5?"5ft":"foot"}</span></>}
          </button>

          {/* KNm wheel */}
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center" }}>
            <KnmWheel value={currentKnm} onChange={setCurrentKnm} />
          </div>
        </div>
      )}

      {/* ── Control buttons ── */}
      {phase === "idle" && (
        <>
          <button onClick={startDrilling} style={{ width:"100%", padding:"18px 0", borderRadius:14, border:"none", cursor:"pointer", background:"#27ae60", color:"#fff", fontSize:20, fontWeight:900, boxShadow:"0 4px 18px rgba(39,174,96,0.4)" }}>
            ▶ START DRILLING
          </button>
          <button onClick={() => setShowLateStart(true)} style={{ width:"100%", padding:"12px 0", borderRadius:12, border:"1px dashed #4a7fa5", cursor:"pointer", background:"transparent", color:"#a8c0d9", fontSize:14, fontWeight:700 }}>
            🏃 Arrived late? Start at current depth…
          </button>
        </>
      )}

      {showLateStart && (
        <Numpad
          label="Rig is currently at depth (ft)"
          initialValue=""
          onConfirm={startAtDepth}
          onCancel={() => setShowLateStart(false)}
        />
      )}

      {(phase === "drilling" || phase === "paused") && (
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:8 }}>
          {phase === "drilling"
            ? <button onClick={pause} style={{ padding:"14px 0", borderRadius:12, border:"none", cursor:"pointer", background:"#e67e22", color:"#fff", fontSize:14, fontWeight:800 }}>⏸ Pause</button>
            : <button onClick={resume} style={{ padding:"14px 0", borderRadius:12, border:"none", cursor:"pointer", background:"#27ae60", color:"#fff", fontSize:14, fontWeight:800 }}>▶ Resume</button>
          }
          <button onClick={undoLastFoot} disabled={!feet.length} style={{ padding:"14px 0", borderRadius:12, border:"none", cursor:"pointer", background:"#2d5a8a", color:"#fff", fontSize:14, fontWeight:800, opacity: feet.length?1:0.4 }}>↺ Undo</button>
          <button onClick={() => setShowRefusal(true)} style={{ padding:"14px 0", borderRadius:12, border:"none", cursor:"pointer", background:"#922b21", color:"#fff", fontSize:13, fontWeight:800 }}>⛔ Refusal</button>
          <button onClick={finishDrilling} style={{ padding:"14px 0", borderRadius:12, border:"none", cursor:"pointer", background:"#2980b9", color:"#fff", fontSize:13, fontWeight:800 }}>✓ Done</button>
        </div>
      )}

      {/* ── Foot log (recent + expandable) ── */}
      {feet.length > 0 && (
        <div style={{ background:"#071520", borderRadius:12, padding:"10px 12px" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
            <span style={{ color:"#4a7fa5", fontSize:11, fontWeight:700 }}>Drill log — {depthFt(pile)} ft logged</span>
            <div style={{ display:"flex", gap:6 }}>
              {missingFeet(pile).length>0 && (
                <button onClick={() => setShowFillSecs(true)} style={{ background:"#7a5c00", border:"1px solid #f0c040", borderRadius:6, color:"#ffd700", fontSize:11, fontWeight:800, padding:"3px 8px", cursor:"pointer" }}>
                  ⏱ Fill ({missingFeet(pile).length})
                </button>
              )}
              <button onClick={() => setShowFullLog(s=>!s)} style={{ background:"none", border:"1px solid #2d4a5c", borderRadius:6, color:"#a8c0d9", fontSize:11, padding:"3px 8px", cursor:"pointer" }}>
                {showFullLog ? "▲ collapse" : "▼ show all"}
              </button>
            </div>
          </div>
          {/* Always show last 4, or all if expanded. Whole row is the edit
              target — a full-width tap area prevents hitting the wrong foot. */}
          {(showFullLog ? [...feet].reverse() : [...feet].reverse().slice(0,4)).map(f => {
            const hi = f.knm && parseInt(f.knm) > 75;
            const missed = f.seconds == null;
            return (
              <div key={f.foot} onClick={() => setEditingFoot({...f})} style={{ display:"flex", gap:8, alignItems:"center", padding:"12px 8px", borderBottom:"1px solid #0d2236", background: missed ? "rgba(240,192,64,0.12)" : "transparent", borderRadius: missed ? 6 : 0, cursor:"pointer" }}>
                <span style={{ color:"#4fc3f7", fontWeight:700, width:40, fontSize:15 }}>{f.foot}ft</span>
                <span style={{ color: missed ? "#f0c040" : "#fff", fontWeight:700, width:40, fontSize:15 }}>{f.seconds!=null?`${f.seconds}s`:"fill"}</span>
                {f.knm
                  ? <span style={{ color:hi?"#e74c3c":"#a8c0d9", fontWeight:hi?800:400, fontSize:13, width:50 }}>{f.knm}K{hi?" ⚠":""}</span>
                  : <span style={{ width:50, color:"#2d4a5c", fontSize:13 }}>—</span>
                }
                <span style={{ color:"#f0c040", fontSize:11, flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{f.note||""}</span>
                <span style={{ color:"#4a7fa5", fontSize:14, flexShrink:0, padding:"0 4px" }}>✏️ ›</span>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Pile Notes — available from the moment the pile is created ── */}
      <div style={{ background:"#071520", borderRadius:12, padding:"12px" }}>
        <div style={{ color:"#4a7fa5", fontSize:10, fontWeight:700, marginBottom:3 }}>Pile Notes (appear on PDF)</div>
        <textarea
          value={pile.notes||""}
          onChange={e => onUpdate({ ...pile, notes: e.target.value })}
          rows={3}
          placeholder="Add any notes about this pile…"
          style={{ width:"100%", padding:"10px 12px", borderRadius:8, border:"1px solid #2d4a5c", background:"#0d2236", color:"#fff", fontSize:14, boxSizing:"border-box", resize:"vertical" }}
        />
      </div>

      {/* ── Grout Trucks — available from the moment the pile is created, so
          truck info can be logged during downtime before drilling starts ── */}
      <TrucksSection pile={pile} onUpdate={onUpdate}/>

      {/* ── Edit foot modal ── */}
      {editingFoot && (
        <FootEditModal pile={pile} foot={editingFoot} feetList={feet} onUpdate={onUpdate} onClose={() => setEditingFoot(null)} />
      )}

      {/* ── Refusal confirm ── */}
      {showFillSecs && (
        <FillSecondsModal pile={pile} onUpdate={onUpdate} onClose={()=>setShowFillSecs(false)}/>
      )}

      {showRefusal && (
        <div style={{ position:"fixed", top:0, left:0, width:"100vw", height:"100dvh", background:"rgba(0,0,0,0.75)", zIndex:300, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
          <div style={{ background:"#fff", borderRadius:18, padding:26, maxWidth:320, width:"100%" }}>
            <div style={{ fontSize:20, fontWeight:900, color:"#922b21", marginBottom:10 }}>⛔ Confirm Refusal</div>
            <div style={{ fontSize:14, color:"#333", marginBottom:22 }}>
              Mark drilling as terminated due to refusal at <strong>{depthFt(pile)}ft</strong>?<br/>
              This will log the current time as drill end.
            </div>
            <div style={{ display:"flex", gap:10 }}>
              <button onClick={() => setShowRefusal(false)} style={{ flex:1, padding:14, borderRadius:10, border:"1px solid #ccc", background:"#f5f5f5", fontSize:15, cursor:"pointer", fontWeight:700 }}>Cancel</button>
              <button onClick={confirmRefusal} style={{ flex:2, padding:14, borderRadius:10, border:"none", background:"#922b21", color:"#fff", fontSize:15, cursor:"pointer", fontWeight:700 }}>Confirm Refusal</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Grout Screen ──────────────────────────────────────────────────────────────
// ── Grout Trucks (shared between DrillScreen pre-drilling and GroutScreen) ────
function TrucksSection({ pile, onUpdate }) {
  return (
    <div style={{ background:"#071520", borderRadius:12, padding:"10px 12px" }}>
      <div style={{ color:"#a8c0d9", fontSize:12, fontWeight:700, marginBottom:8 }}>🚛 Grout Trucks</div>
      {(pile.trucks||[]).map((t, ti) => {
        const setT = (field, val) => {
          const trucks = pile.trucks.map((x,i)=>i===ti?{...x,[field]:val}:x);
          onUpdate({...pile, trucks});
        };
        const inpS = { width:"100%", padding:"10px 8px", borderRadius:8, border:"1px solid #2d4a5c", background:"#0d2236", color:"#fff", fontSize:14, boxSizing:"border-box" };
        const lblS = { color:"#4a7fa5", fontSize:10, fontWeight:700, marginBottom:2 };
        const hasData = t.no||t.ticket||t.qty||t.batch;
        return (
          <div key={ti} style={{ border:`1px solid ${hasData?"#27ae60":"#1a3a5c"}`, borderRadius:10, padding:"8px 10px", marginBottom:8 }}>
            <div style={{ color: hasData?"#2ecc71":"#4a7fa5", fontSize:11, fontWeight:800, marginBottom:6 }}>Truck #{ti+1}{ti===2?" (leftover / extra)":""}</div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
              <div><div style={lblS}>Truck No.</div>
                <input value={t.no} onChange={e=>setT("no",e.target.value)} placeholder="4 digits" inputMode="numeric" style={inpS}/></div>
              <div><div style={lblS}>Ticket No.</div>
                <input value={t.ticket} onChange={e=>setT("ticket",e.target.value)} placeholder="6 digits" inputMode="numeric" style={inpS}/></div>
              <div><div style={lblS}>Cum. Qty (CY)</div>
                <input value={t.qty} type="number" onChange={e=>setT("qty",e.target.value)} placeholder="e.g. 9" style={inpS}/></div>
              <div><div style={lblS}>Batch Time</div>
                <input value={t.batch} type="time" onChange={e=>setT("batch",e.target.value)} style={{...inpS, colorScheme:"dark"}}/></div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function GroutScreen({ pile, onUpdate }) {
  const [numpadBand, setNumpadBand] = useState(null);
  const [numpadField, setNumpadField] = useState(null); // "slurryAt" | "groutAt"
  const [showPileNoWarn, setShowPileNoWarn] = useState(false);
  const [warnPileNo, setWarnPileNo] = useState("");
  const phase = !pile.groutStart ? "idle" : !pile.groutEnd ? "grouting" : "done";

  const startGrouting = () => onUpdate({ ...pile, groutStart: nowStr() });
  const finishGrouting = () => {
    // Guard: don't let a pile finish without its pile number
    if (!pile.pileNo || !pile.pileNo.trim()) { setWarnPileNo(""); setShowPileNoWarn(true); return; }
    saveTypeMemory(pile);
    onUpdate({ ...pile, groutEnd: nowStr() });
  };
  const finishWithPileNo = () => {
    saveTypeMemory(pile);
    onUpdate({ ...pile, pileNo: warnPileNo.trim(), groutEnd: nowStr() });
    setShowPileNoWarn(false);
  };
  const finishWithoutPileNo = () => {
    saveTypeMemory(pile);
    onUpdate({ ...pile, groutEnd: nowStr() });
    setShowPileNoWarn(false);
  };

  const saveBandStrokes = (val) => {
    const newBands = pile.groutBands.map(b => b.depth === numpadBand ? { ...b, strokes: val } : b);
    onUpdate({ ...pile, groutBands: newBands });
    setNumpadBand(null);
  };

  const saveFieldDepth = (val) => {
    onUpdate({ ...pile, [numpadField]: val });
    setNumpadField(null);
  };

  const bands = pile.groutBands || [];
  const filled = bands.filter(b => b.strokes).length;

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>

      {/* Times */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
        <div style={{ background:"#071520", borderRadius:10, padding:"8px 12px" }}>
          <div style={{ color:"#4a7fa5", fontSize:10 }}>Drill End</div>
          <div style={{ color:"#fff", fontWeight:700, fontSize:13 }}>{pile.drillEnd||"—"}</div>
        </div>
        <div style={{ background:"#071520", borderRadius:10, padding:"8px 12px" }}>
          <div style={{ color:"#4a7fa5", fontSize:10 }}>Grout Start</div>
          <div style={{ color: pile.groutStart?"#c39bd3":"#4a7fa5", fontWeight:700, fontSize:13 }}>{pile.groutStart||"—"}</div>
        </div>
      </div>

      {phase === "idle" && (
        <button onClick={startGrouting} style={{ width:"100%", padding:"28px 0", borderRadius:16, border:"none", cursor:"pointer", background:"#8e44ad", color:"#fff", fontSize:22, fontWeight:900, boxShadow:"0 4px 18px rgba(142,68,173,0.4)" }}>
          ▶ START GROUTING
        </button>
      )}

      {(phase === "grouting" || phase === "done") && (
        <>
          <div style={{ color:"#a8c0d9", fontSize:12, fontWeight:700 }}>
            Strokes going up — bottom to surface ({filled}/{bands.length} entered)
          </div>

          {/* Band grid */}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8 }}>
            {bands.map((b, i) => {
              const isBottom = i === 0;
              const done = !!b.strokes;
              return (
                <button key={b.depth} onClick={() => (phase==="grouting"||phase==="done") && setNumpadBand(b.depth)} style={{
                  padding:"14px 6px", borderRadius:12,
                  border:`2px solid ${done ? "#27ae60" : isBottom ? "#e67e22" : "#2d6a9f"}`,
                  background: done ? "#1a4a2e" : isBottom ? "#3d2200" : "#1a3a5c",
                  color:"#fff", cursor: phase==="grouting"?"pointer":"default", textAlign:"center"
                }}>
                  <div style={{ fontSize:11, color: done?"#a8d9b8" : isBottom?"#f0a060":"#a8c0d9", fontWeight:700 }}>
                    {isBottom ? "⬇ BOTTOM" : b.label}
                  </div>
                  <div style={{ fontSize:24, fontWeight:900, color: done?"#2ecc71" : isBottom?"#e67e22":"#4fc3f7", marginTop:2 }}>
                    {b.strokes || "—"}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Slurry / Grout return observed */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
            <button onClick={() => (phase==="grouting"||phase==="done") && setNumpadField("slurryAt")} style={{
              padding:"12px 6px", borderRadius:12,
              border:`2px solid ${pile.slurryAt ? "#27ae60":"#3498db"}`,
              background: pile.slurryAt ? "#1a4a2e":"#123a52", color:"#fff",
              cursor: phase==="grouting"?"pointer":"default", textAlign:"center"
            }}>
              <div style={{ fontSize:11, fontWeight:700, color: pile.slurryAt?"#a8d9b8":"#7fc4f0" }}>💧 Slurry Return @</div>
              <div style={{ fontSize:20, fontWeight:900, color: pile.slurryAt?"#2ecc71":"#4fc3f7" }}>{pile.slurryAt ? `${pile.slurryAt}ft` : "—"}</div>
            </button>
            <button onClick={() => (phase==="grouting"||phase==="done") && setNumpadField("groutAt")} style={{
              padding:"12px 6px", borderRadius:12,
              border:`2px solid ${pile.groutAt ? "#27ae60":"#8e44ad"}`,
              background: pile.groutAt ? "#1a4a2e":"#2d1a3a", color:"#fff",
              cursor: phase==="grouting"?"pointer":"default", textAlign:"center"
            }}>
              <div style={{ fontSize:11, fontWeight:700, color: pile.groutAt?"#a8d9b8":"#c39bd3" }}>🟣 Grout Return @</div>
              <div style={{ fontSize:20, fontWeight:900, color: pile.groutAt?"#2ecc71":"#c39bd3" }}>{pile.groutAt ? `${pile.groutAt}ft` : "—"}</div>
            </button>
          </div>

          {/* Truck info — up to 3 trucks (incl. leftover grout from previous pile) */}
          <TrucksSection pile={pile} onUpdate={onUpdate}/>

          {phase === "grouting" && (
            <button onClick={finishGrouting} style={{ width:"100%", padding:"18px 0", borderRadius:14, border:"none", cursor:"pointer", background:"#27ae60", color:"#fff", fontSize:18, fontWeight:900 }}>
              ✓ Done Grouting
            </button>
          )}

          {phase === "done" && (
            <div style={{ background:"#1a4a2e", borderRadius:12, padding:"16px", textAlign:"center" }}>
              <div style={{ fontSize:28 }}>✅</div>
              <div style={{ color:"#2ecc71", fontWeight:800, fontSize:16 }}>Grouting Complete</div>
              <div style={{ color:"#a8d9b8", fontSize:12, marginTop:4 }}>Grout End: {pile.groutEnd}</div>
            </div>
          )}

          {/* ── Reinforcement cage + end-of-pile notes (after grouting) ── */}
          {phase === "done" && (
            <>
            {(() => {
              // Live computed summary — read active project's calibration from the store
              let proj = {};
              try {
                const s = JSON.parse(localStorage.getItem("acip_store"));
                const act = s && s.projects && (s.projects.find(e=>e.id===s.activeId) || s.projects[0]);
                proj = (act && act.project) || {};
              } catch(e) {}
              const d = calcDerived(pile, proj);
              return (d.totalStrokes || d.theoretical) ? (
                <div style={{ background:"#071520", borderRadius:12, padding:"10px 12px", display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:6, textAlign:"center" }}>
                  {[["Total Strokes", d.totalStrokes||"—"],["Theo. Vol (ft³)", d.theoretical||"—"],["Actual Vol (ft³)", d.actual||"—"],["Grout Factor", d.groutFactor||"—"]].map(([l,v])=>(
                    <div key={l}>
                      <div style={{ color:"#4a7fa5", fontSize:9, fontWeight:700 }}>{l}</div>
                      <div style={{ color: l==="Grout Factor" && v!=="—" && parseFloat(v)<1 ? "#e74c3c" : "#4fc3f7", fontSize:16, fontWeight:900 }}>{v}</div>
                    </div>
                  ))}
                </div>
              ) : null;
            })()}
            <div style={{ background:"#071520", borderRadius:12, padding:"12px" }}>
              <div style={{ color:"#a8c0d9", fontSize:12, fontWeight:700, marginBottom:8 }}>🏗 Reinforcement Cage & Notes</div>
              {!(pile.notes||"").includes("cage installed") ? (
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:10 }}>
                  <button onClick={() => {
                    const note = `Reinforcement cage installed with no issues (${nowStr()})`;
                    onUpdate({ ...pile, notes: pile.notes ? pile.notes + "\n" + note : note });
                  }} style={{ padding:"14px 8px", borderRadius:10, border:"2px solid #27ae60", background:"#1a4a2e", color:"#2ecc71", fontWeight:800, fontSize:13, cursor:"pointer" }}>
                    ✓ Cage Installed — No Issues
                  </button>
                  <button onClick={() => {
                    const note = `Reinforcement cage installed (${nowStr()}) — `;
                    onUpdate({ ...pile, notes: pile.notes ? pile.notes + "\n" + note : note });
                  }} style={{ padding:"14px 8px", borderRadius:10, border:"2px solid #e67e22", background:"#3d2200", color:"#e67e22", fontWeight:800, fontSize:13, cursor:"pointer" }}>
                    ⚠ Cage Installed — With Issues…
                  </button>
                </div>
              ) : (
                <div style={{ color:"#2ecc71", fontSize:12, fontWeight:700, marginBottom:8 }}>✓ Cage installation logged — edit below if needed</div>
              )}
              <div style={{ color:"#4a7fa5", fontSize:10, fontWeight:700, marginBottom:3 }}>Pile Notes (appear on PDF)</div>
              <textarea
                value={pile.notes||""}
                onChange={e => onUpdate({ ...pile, notes: e.target.value })}
                rows={3}
                placeholder="Add any notes about this pile…"
                style={{ width:"100%", padding:"10px 12px", borderRadius:8, border:"1px solid #2d4a5c", background:"#0d2236", color:"#fff", fontSize:14, boxSizing:"border-box", resize:"vertical" }}
              />
            </div>
            </>
          )}
        </>
      )}

      {numpadBand !== null && (
        <Numpad
          label={`Strokes at ${bands.find(b=>b.depth===numpadBand)?.label||numpadBand}`}
          initialValue={bands.find(b=>b.depth===numpadBand)?.strokes||""}
          onConfirm={saveBandStrokes}
          onCancel={() => setNumpadBand(null)}
        />
      )}

      {numpadField !== null && (
        <Numpad
          label={numpadField === "slurryAt" ? "Slurry return observed at (ft)" : "Grout return observed at (ft)"}
          initialValue={pile[numpadField]||""}
          onConfirm={saveFieldDepth}
          onCancel={() => setNumpadField(null)}
        />
      )}

      {/* ── Missing pile number warning ── */}
      {showPileNoWarn && (
        <div style={{ position:"fixed", top:0, left:0, width:"100vw", height:"100dvh", background:"rgba(0,0,0,0.8)", zIndex:300, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
          <div style={{ background:"#fff", borderRadius:18, padding:24, maxWidth:340, width:"100%" }}>
            <div style={{ fontSize:34, textAlign:"center" }}>⚠️</div>
            <div style={{ fontSize:18, fontWeight:900, color:"#b7791f", textAlign:"center", marginBottom:8 }}>No Pile Number!</div>
            <div style={{ fontSize:13, color:"#444", marginBottom:14, textAlign:"center" }}>
              This pile has no Pile No. entered. Enter it now so the log is complete:
            </div>
            <input
              value={warnPileNo}
              onChange={e=>setWarnPileNo(e.target.value)}
              placeholder="e.g. P0108"
              autoFocus
              style={{ width:"100%", padding:"12px", borderRadius:10, border:"2px solid #b7791f", fontSize:20, fontWeight:800, textAlign:"center", boxSizing:"border-box", marginBottom:14 }}
            />
            <button onClick={finishWithPileNo} disabled={!warnPileNo.trim()} style={{
              width:"100%", padding:14, borderRadius:10, border:"none",
              background: warnPileNo.trim() ? "#27ae60" : "#ccc", color:"#fff", fontSize:16, cursor: warnPileNo.trim()?"pointer":"default", fontWeight:800, marginBottom:8
            }}>✓ Save Pile No. & Finish</button>
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={()=>setShowPileNoWarn(false)} style={{ flex:1, padding:12, borderRadius:10, border:"1px solid #ccc", background:"#f5f5f5", fontSize:13, cursor:"pointer", fontWeight:700 }}>Cancel</button>
              <button onClick={finishWithoutPileNo} style={{ flex:1, padding:12, borderRadius:10, border:"1px solid #b7791f", background:"#fff8ee", color:"#b7791f", fontSize:13, cursor:"pointer", fontWeight:700 }}>Finish without it</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── PDF Generator ─────────────────────────────────────────────────────────────
async function generatePDF(project, piles) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation:"portrait", unit:"pt", format:"letter" });
  const W=612, margin=36, rowH=15, labelW=95, dataColW=(W-margin*2-labelW)/2;

  const pages=[];
  for(let i=0;i<piles.length;i+=2) pages.push(piles.slice(i,i+2));

  pages.forEach((pagePiles,pi)=>{
    if(pi>0) doc.addPage();

    // Header — title reflects this page's pile kind (ACIP vs Rigid Inclusion)
    const pageKind = pagePiles[0]?.pileKind === "RI" ? "RI" : "ACIP";
    const headerTitle = pageKind === "RI" ? "RIGID INCLUSION INSPECTION LOG" : "AUGERCAST PILE INSPECTION LOG";
    doc.setFont("helvetica","bold"); doc.setFontSize(16); doc.setTextColor(0,51,102);
    doc.text("LANGAN", margin, margin+12);
    doc.setFontSize(10); doc.setTextColor(0,0,0);
    doc.text(headerTitle, W/2, margin+12, {align:"center"});

    const ph=margin+26; doc.setFontSize(7.5);
    [["Project:",project.projectName],["Location:",project.location],
     ["Piling Contractor:",project.pilingContractor],["Equipment:",project.equipment]
    ].forEach(([l,v],i)=>{ doc.setFont("helvetica","bold"); doc.text(l,margin,ph+i*11); doc.setFont("helvetica","normal"); doc.text(v||"",margin+85,ph+i*11); });
    [["Project No:",project.projectNo],["Date(s):",project.date],
     ["Inspector:",project.inspector],["Page:",`${pi+1}`]
    ].forEach(([l,v],i)=>{ doc.setFont("helvetica","bold"); doc.text(l,W/2+8,ph+i*11); doc.setFont("helvetica","normal"); doc.text(v||"",W/2+68,ph+i*11); });

    const tTop=ph+50;
    const mainRows=[
      ["Pile Type","pileType"],["Pile Diameter (in)","pileDiameter"],
      ["Ground Elevation (ft)","groundElevation"],["Pile Capacity (kips)","pileCapacity"],
      ["Pile Cap Thickness (ft)","capThickness"],
      ["Pile Length (ft)","pileLength"],["Drill Depth (ft)","drillDepth"],
      ["Tip Elevation (ft)","tipElevation"],["Cutoff Elevation (ft)","cutoffElevation"],
      ["Theoretical Vol. (ft\u00b3)","theoreticalVol"],["Total Strokes Pumped","totalStrokes"],
      ["Actual Volume (ft\u00b3)","actualVolume"],["Grout Factor","groutFactor"],
    ];

    // col header
    doc.setFillColor(210,225,245); doc.rect(margin,tTop,W-margin*2,rowH,"F");
    doc.setDrawColor(100); doc.rect(margin,tTop,W-margin*2,rowH);
    doc.setFont("helvetica","bold"); doc.setFontSize(7);
    doc.line(margin+labelW,tTop,margin+labelW,tTop+rowH);
    pagePiles.forEach((p,ci)=>{
      if(ci>0) doc.line(margin+labelW+ci*dataColW,tTop,margin+labelW+ci*dataColW,tTop+rowH);
      doc.text(`Pile No. ${p.pileNo||"(blank)"}`, margin+labelW+ci*dataColW+4, tTop+10);
    });

    // Precompute derived values once per pile (was per-row — slow with many piles)
    const derivedByPile = pagePiles.map(p => {
      const d = calcDerived(p, project);
      return { drillDepth:d.drillDepth, theoreticalVol:d.theoretical, totalStrokes:d.totalStrokes, actualVolume:d.actual, groutFactor:d.groutFactor, tipElevation:d.tipElevation, cutoffElevation:d.cutoffElevation, pileLength:d.pileLength };
    });
    mainRows.forEach((r,ri)=>{
      const y=tTop+(ri+1)*rowH;
      if(ri%2===0){doc.setFillColor(248,250,253); doc.rect(margin,y,W-margin*2,rowH,"F");}
      doc.setDrawColor(180); doc.rect(margin,y,W-margin*2,rowH);
      doc.setFont("helvetica","bold"); doc.setFontSize(6.5); doc.text(r[0],margin+3,y+10);
      doc.line(margin+labelW,y,margin+labelW,y+rowH);
      pagePiles.forEach((p,ci)=>{
        if(ci>0) doc.line(margin+labelW+ci*dataColW,y,margin+labelW+ci*dataColW,y+rowH);
        doc.setFont("helvetica","normal"); doc.setFontSize(7.5);
        const derivedMap = derivedByPile[ci];
        const val = derivedMap.hasOwnProperty(r[1]) ? derivedMap[r[1]] : p[r[1]];
        doc.text(String(val||""), margin+labelW+ci*dataColW+4, y+10);
      });
    });

    // Remarks header
    const remY=tTop+(mainRows.length+1)*rowH;
    doc.setFillColor(210,225,245); doc.rect(margin,remY,W-margin*2,rowH,"F");
    doc.setDrawColor(100); doc.rect(margin,remY,W-margin*2,rowH);
    doc.setFont("helvetica","bold"); doc.setFontSize(7); doc.text("Drill Log:",margin+3,remY+6); doc.setFontSize(5.5); doc.text("sec/ft + torque",margin+3,remY+12);
    doc.line(margin+labelW,remY,margin+labelW,remY+rowH);
    pagePiles.forEach((_,ci)=>{ if(ci>0) doc.line(margin+labelW+ci*dataColW,remY,margin+labelW+ci*dataColW,remY+rowH); });
    // One concise legend across the row
    doc.setFont("helvetica","normal"); doc.setFontSize(6);
    doc.text("sec/ft under 5-ft marks \u00b7 circled = strokes \u00b7 red = KNm", margin+labelW+4, remY+10);

    // Depth log — matches original Langan form: 4 vertical depth columns per pile,
    // seconds per foot stacked below each 5ft label, circled stroke counts, remarks summary at right
    const depthY=remY+rowH, depthH=214;
    doc.setDrawColor(150); doc.rect(margin,depthY,W-margin*2,depthH);

    // Left boundary of the chart area = the label column edge, same as the table above
    doc.line(margin+labelW, depthY, margin+labelW, depthY+depthH);
    // Grout supplier / product code live in the label strip, like the original form
    doc.setFont("helvetica","bold"); doc.setFontSize(6);
    doc.text("Grout Supplier:", margin+3, depthY+12);
    doc.setFont("helvetica","normal");
    doc.text((pagePiles[0]?.groutSupplier||"").substring(0,28), margin+3, depthY+20);
    doc.setFont("helvetica","bold");
    doc.text("Product Code:", margin+3, depthY+32);
    doc.setFont("helvetica","normal");
    doc.text((pagePiles[0]?.productCode||"").substring(0,28), margin+3, depthY+40);

    pagePiles.forEach((pile,ci)=>{
      // Align with the main table: label column on the left, then one dataColW per pile
      const colX = margin + labelW + ci*dataColW;
      const cw = dataColW;
      if(ci>0) doc.line(colX,depthY,colX,depthY+depthH);

      const feet = pile.feet||[];
      const bands = pile.groutBands||[];
      const footInterval = pile.footInterval || 1;
      const getFoot = (n) => feet.find(f=>f.foot===n);
      const getStrokes = (d) => bands.find(b=>b.depth===d)?.strokes || "";

      // Layout: 4 quarter-columns (0-25,25-50,50-75,75-100) + summary strip on right
      const summaryW = 52;
      const qW = (cw - summaryW - 6) / 4;
      const lineH = 6.6;   // each foot line
      const topPad = 8;

      for (let q=0; q<4; q++) {
        const qx = colX + 3 + q*qW;
        let y = depthY + topPad;
        for (let m=0; m<5; m++) {
          const markDepth = q*25 + m*5;   // 0,5,10,15,20 / 25,30... etc
          // ── 5ft mark header: circled strokes + depth label + dashes ──
          const strokesHere = getStrokes(markDepth);
          doc.setFontSize(5.5); doc.setFont("helvetica","bold");
          // circle with stroke count
          if (strokesHere) {
            doc.setDrawColor(60);
            doc.circle(qx+6, y-1.6, 5.8);
            const sw = doc.getTextWidth(String(strokesHere));
            doc.text(String(strokesHere), qx+6-sw/2, y+0.4);
          }
          doc.text(`${markDepth}'`, qx+13, y);
          doc.setDrawColor(170);
          // small dashes like the form
          doc.setLineDashPattern([1.5,1.2],0);
          doc.line(qx+22, y-1.5, qx+qW-4, y-1.5);
          doc.setLineDashPattern([],0);

          y += lineH;
          // ── 5 feet under this mark: seconds (+KNm if high). Each foot is
          // looked up by its own exact depth, so this correctly shows sparse
          // 5ft-interval readings and dense 1ft readings side by side if the
          // interval was switched partway through this pile. ──
          doc.setFont("helvetica","normal"); doc.setFontSize(5.5);
          for (let s=1; s<=5; s++) {
            const footNum = markDepth + s;
            const f = getFoot(footNum);
            if (f && f.seconds!=null) {
              const hi = f.knm && parseInt(f.knm)>75;
              let txt = String(f.seconds);
              doc.text(txt, qx+14, y);
              if (hi) {
                doc.setTextColor(180,30,30); doc.setFont("helvetica","bold");
                doc.text(`${f.knm}k`, qx+14+doc.getTextWidth(txt)+2, y);
                doc.setTextColor(0,0,0); doc.setFont("helvetica","normal");
              }
            } else if (footNum <= depthFt(pile)) {
              // Within drilled depth but no reading here (5ft-interval gap) — blank, not dashes
            } else {
              doc.setTextColor(150,150,150);
              doc.text("----", qx+14, y);
              doc.setTextColor(0,0,0);
            }
            y += lineH;
          }
        }
        // vertical separator between quarter columns
        if (q<3) { doc.setDrawColor(220); doc.line(colX+3+(q+1)*qW-2, depthY+3, colX+3+(q+1)*qW-2, depthY+depthH-3); }
      }

      // ── Summary strip (right side, like original form) ──
      const sx = colX + cw - summaryW + 2;
      doc.setDrawColor(200); doc.line(sx-3, depthY+3, sx-3, depthY+depthH-3);
      let sy = depthY + 12;
      doc.setFont("helvetica","bold"); doc.setFontSize(5.5);
      doc.text("Strokes", sx, sy); doc.text("@Bottom:", sx, sy+6);
      doc.setFontSize(9);
      const bottomBand = bands[0];
      doc.text(String(bottomBand?.strokes||""), sx+8, sy+16);
      sy += 26;
      doc.setFontSize(5.5);
      doc.text("Slurry @:", sx, sy);
      doc.setFontSize(8); doc.text(pile.slurryAt?`${pile.slurryAt}'`:"", sx+4, sy+8);
      sy += 18;
      doc.setFontSize(5.5);
      doc.text("Grout @:", sx, sy);
      doc.setFontSize(8); doc.text(pile.groutAt?`${pile.groutAt}'`:"", sx+4, sy+8);
      sy += 18;
      doc.setFontSize(5.5);
      doc.text("Notes:", sx, sy);
      doc.setFont("helvetica","normal"); doc.setFontSize(5);
      // refusal + general notes + per-foot notes, wrapped in summary strip
      let noteLines = [];
      if (pile.refusalDepth) noteLines.push(`REFUSAL @ ${pile.refusalDepth}'`);
      if (pile.notes) noteLines.push(...pile.notes.split("\n"));
      feet.filter(f=>f.note).forEach(f=>noteLines.push(`${f.foot}': ${f.note}`));
      const wrapped = doc.splitTextToSize(noteLines.join("; "), summaryW-4);
      wrapped.slice(0, Math.floor((depthY+depthH-6-sy-5)/5.5)).forEach((ln,li)=>{
        if (li===0 && pile.refusalDepth) doc.setTextColor(180,30,30);
        doc.text(ln, sx, sy+6+li*5.5);
        doc.setTextColor(0,0,0);
      });
    });

    // Bottom rows — times shown as h:mm (strip seconds from any legacy values)
    const hm = (s) => s ? String(s).replace(/(\d{1,2}:\d{2}):\d{2}/, "$1") : "";
    // Trucks print in ascending cumulative-quantity order (since quantities are
    // cumulative, this reflects the actual pour sequence even if entries were
    // logged out of order in the field). Empty/blank trucks sort last.
    const sortedTrucks = (p) => (p.trucks||[]).map((t,i)=>({...t, origIdx:i}))
      .sort((a,b) => {
        const qa = parseFloat(a.qty), qb = parseFloat(b.qty);
        const aEmpty = !a.no && !a.ticket && !a.qty, bEmpty = !b.no && !b.ticket && !b.qty;
        if (aEmpty && bEmpty) return 0;
        if (aEmpty) return 1;
        if (bEmpty) return -1;
        if (isNaN(qa) && isNaN(qb)) return 0;
        if (isNaN(qa)) return 1;
        if (isNaN(qb)) return -1;
        return qa - qb;
      });
    const botY=depthY+depthH;
    const botRows=[
      ["Drilling Time", p=>`Start: ${hm(p.drillStart)}   End: ${hm(p.drillEnd)}`],
      ["Pump Time",     p=>`Start: ${hm(p.groutStart)}   End: ${hm(p.groutEnd)}`],
      ["Reinforcing Steel", p=>p.pileKind==="RI" ? "N/A — unreinforced" : (p.reinfSteel||"")],
      ["Grout Strength (lbs/in\u00b2)", p=>p.groutStrength||""],
      ["Truck 1 — No / Ticket / Qty", p=>{const t=sortedTrucks(p)[0]; return t&&(t.no||t.ticket||t.qty) ? `${t.no||"—"}  /  ${t.ticket||"—"}  /  ${t.qty?t.qty+" cy":"—"}` : "";}],
      ["Truck 2 — No / Ticket / Qty", p=>{const t=sortedTrucks(p)[1]; return t&&(t.no||t.ticket||t.qty) ? `${t.no||"—"}  /  ${t.ticket||"—"}  /  ${t.qty?t.qty+" cy":"—"}` : "";}],
      ["Truck 3 — No / Ticket / Qty", p=>{const t=sortedTrucks(p)[2]; return t&&(t.no||t.ticket||t.qty) ? `${t.no||"—"}  /  ${t.ticket||"—"}  /  ${t.qty?t.qty+" cy":"—"}` : "";}],
      ["Flow (s) / Spread (in)", p=>p.flow||""],
      ["Batch Time / Water Added", p=>sortedTrucks(p).filter(t=>t.batch).map(t=>`T${t.origIdx+1}: ${t.batch}`).join("    ") || p.batchTime || ""],
    ];
    botRows.forEach((brow,ri)=>{
      const by=botY+ri*rowH;
      if(ri%2===0){doc.setFillColor(248,250,253); doc.rect(margin,by,W-margin*2,rowH,"F");}
      doc.setDrawColor(180); doc.rect(margin,by,W-margin*2,rowH);
      doc.setFont("helvetica","bold"); doc.setFontSize(6.5); doc.text(brow[0],margin+3,by+10);
      doc.line(margin+labelW,by,margin+labelW,by+rowH);
      pagePiles.forEach((pile,ci)=>{
        if(ci>0) doc.line(margin+labelW+ci*dataColW,by,margin+labelW+ci*dataColW,by+rowH);
        doc.setFont("helvetica","normal"); doc.setFontSize(7); doc.text(brow[1](pile),margin+labelW+ci*dataColW+4,by+10);
      });
    });

    const footerY=botY+botRows.length*rowH+10;
    doc.setFontSize(6); doc.setFont("helvetica","normal");
    doc.text(`Pump Calibration: ${project.pumpCalibFactor||"___"} ft\u00b3/stroke;  Date of Pump Calibration: ${project.lastCalibDate||"___________"}    Sum of piles today: ${piles.length}`,margin,footerY);
    doc.text("Criteria: (1) Pre-drill to 5 feet above termination depth up to 48 hours;  (2) No-pre-drilling",margin,footerY+9);
  });

  // Append the daily summary as the final page of the full log
  doc.addPage();
  drawSummaryPage(doc, project, piles);

  const blob = doc.output("blob");
  return URL.createObjectURL(blob);
}

// ── Daily Summary PDF: one row per pile — no, depth, strokes, times, notes ────
// Draws the daily summary onto an existing jsPDF doc (current page).
// Used standalone by generateSummaryPDF and appended by generatePDF.
function drawSummaryPage(doc, project, piles) {
  const W=612, margin=40;
  const hm = (s) => s ? String(s).replace(/(\d{1,2}:\d{2}):\d{2}/, "$1") : "";

  // Header
  doc.setFont("helvetica","bold"); doc.setFontSize(16); doc.setTextColor(0,51,102);
  doc.text("LANGAN", margin, margin+12);
  doc.setFontSize(11); doc.setTextColor(0,0,0);
  doc.text("DAILY PILE INSTALLATION SUMMARY", W/2, margin+12, {align:"center"});

  const ph = margin+30; doc.setFontSize(8);
  [["Project:",project.projectName],["Location:",project.location],["Piling Contractor:",project.pilingContractor]].forEach(([l,v],i)=>{
    doc.setFont("helvetica","bold"); doc.text(l,margin,ph+i*12);
    doc.setFont("helvetica","normal"); doc.text(v||"",margin+80,ph+i*12);
  });
  [["Project No:",project.projectNo],["Date:",project.date],["Inspector:",project.inspector]].forEach(([l,v],i)=>{
    doc.setFont("helvetica","bold"); doc.text(l,W/2+10,ph+i*12);
    doc.setFont("helvetica","normal"); doc.text(v||"",W/2+70,ph+i*12);
  });

  // Table
  const cols = [
    { label:"Pile No.", w:60 },
    { label:"Drill Depth (ft)", w:70 },
    { label:"Total Strokes", w:70 },
    { label:"Grout Factor", w:65 },
    { label:"Duration", w:80 },
    { label:"Notes", w:W-margin*2-60-70-70-65-80 },
  ];
  let y = ph + 46;
  const rowPad = 5;

  // Parse "h:mm AM/PM" (or "h:mm:ss AM/PM") into minutes-since-midnight
  const toMinutes = (s) => {
    if (!s) return null;
    const m = String(s).match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?/i);
    if (!m) return null;
    let h = parseInt(m[1]), mins = parseInt(m[2]);
    const ap = (m[3]||"").toUpperCase();
    if (ap === "PM" && h !== 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
    return h*60 + mins;
  };
  // Elapsed duration from drill start to grout end, e.g. "1h 37m"
  const duration = (pile) => {
    const a = toMinutes(pile.drillStart), b = toMinutes(pile.groutEnd);
    if (a == null || b == null) return "—";
    let diff = b - a;
    if (diff < 0) diff += 24*60; // crossed midnight
    const h = Math.floor(diff/60), m = diff%60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  const drawHeader = () => {
    doc.setFillColor(210,225,245);
    doc.rect(margin, y, W-margin*2, 18, "F");
    doc.setDrawColor(100); doc.rect(margin, y, W-margin*2, 18);
    doc.setFont("helvetica","bold"); doc.setFontSize(8);
    let x = margin;
    cols.forEach(c => { doc.text(c.label, x+4, y+12); x += c.w; if (x < W-margin) doc.line(x, y, x, y+18); });
    y += 18;
  };
  drawHeader();

  doc.setFont("helvetica","normal"); doc.setFontSize(8);
  let totalStrokesSum = 0, totalDepthSum = 0, installedCount = 0;
  piles.forEach((pile, pi) => {
    const d = calcDerived(pile, project);
    const noteText = [pile.refusalDepth ? `REFUSAL @ ${pile.refusalDepth}ft` : "", pile.notes||""].filter(Boolean).join("; ");
    const noteLines = doc.splitTextToSize(noteText || "—", cols[5].w - 8);
    const rowH = Math.max(18, noteLines.length * 9 + rowPad*2);

    // page break
    if (y + rowH > 760) { doc.addPage(); y = margin; drawHeader(); doc.setFont("helvetica","normal"); doc.setFontSize(8); }

    if (pi % 2 === 0) { doc.setFillColor(248,250,253); doc.rect(margin, y, W-margin*2, rowH, "F"); }
    doc.setDrawColor(180); doc.rect(margin, y, W-margin*2, rowH);

    if (!pile.notInstalled) {
      installedCount++;
      const strokesNum = parseFloat(d.totalStrokes); if(!isNaN(strokesNum)) totalStrokesSum += strokesNum;
      const depthNum = parseFloat(d.drillDepth); if(!isNaN(depthNum)) totalDepthSum += depthNum;
    }

    const vals = [
      pile.pileNo || `(pile ${pi+1})`,
      pile.notInstalled ? "Not Installed" : (d.drillDepth || "—"),
      d.totalStrokes || "—",
      d.groutFactor || "—",
      duration(pile),
    ];
    let x = margin;
    vals.forEach((v, ci) => {
      const gfLow = ci===3 && v!=="—" && parseFloat(v) < 1;
      const notInst = ci===1 && pile.notInstalled;
      if (gfLow || notInst) { doc.setTextColor(180,30,30); doc.setFont("helvetica","bold"); }
      doc.text(String(v), x+4, y+13);
      if (gfLow || notInst) { doc.setTextColor(0,0,0); doc.setFont("helvetica","normal"); }
      x += cols[ci].w;
      doc.line(x, y, x, y+rowH);
    });
    // notes (wrapped)
    noteLines.forEach((ln, li) => doc.text(ln, x+4, y+13+li*9));
    y += rowH;
  });

  // Totals row — pile count + total grout used
  // Truck quantities are CUMULATIVE, so the day's total grout = the last
  // entered quantity of the last truck in the last pile that has one.
  let totalGrout = null;
  for (let i = piles.length - 1; i >= 0 && totalGrout == null; i--) {
    const ts = piles[i].trucks || [];
    for (let j = ts.length - 1; j >= 0; j--) {
      if (ts[j].qty) { totalGrout = ts[j].qty; break; }
    }
  }
  doc.setFillColor(225,235,248);
  doc.rect(margin, y, W-margin*2, 18, "F");
  doc.setDrawColor(100); doc.rect(margin, y, W-margin*2, 18);
  doc.setFont("helvetica","bold"); doc.setFontSize(8);
  doc.text(`TOTAL — ${installedCount} pile${installedCount!==1?"s":""} installed${totalGrout ? `        Total grout used: ${totalGrout} CY` : ""}`, margin+4, y+12);
  y += 30;

  doc.setFont("helvetica","normal"); doc.setFontSize(7);
  doc.text(`Prepared by: ${project.inspector||"____________"}        Date: ${project.date||""}`, margin, y);
}

async function generateSummaryPDF(project, piles) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation:"portrait", unit:"pt", format:"letter" });
  drawSummaryPage(doc, project, piles);
  const blob = doc.output("blob");
  return URL.createObjectURL(blob);
}

// ── Shared field component (module-level so React keeps input focus while typing) ──
const FIELD_INP = {width:"100%",padding:"9px 10px",borderRadius:8,border:"1px solid #2d4a5c",background:"#071520",color:"#fff",fontSize:14,boxSizing:"border-box"};
const FIELD_LBL = {fontSize:11,fontWeight:700,color:"#a8c0d9",marginBottom:3};
function Field({ label, field, obj, set, type="text", placeholder="" }) {
  return (
    <div style={{marginBottom:10}}>
      <div style={FIELD_LBL}>{label}</div>
      <input type={type} value={obj[field]||""} onChange={e=>set(field,e.target.value)} style={FIELD_INP} placeholder={placeholder}/>
    </div>
  );
}

// ── Pile Details Form ─────────────────────────────────────────────────────────
// A computed field shows its live auto-calculated value with an "auto" tag.
// Tapping the ✏️ turns it into a normal editable input (manual override,
// which calcDerived always prefers over the computed value).
function ComputedField({ label, field, pile, onUpdate, computedValue, unit="" }) {
  const [editing, setEditing] = useState(!!pile[field]);
  const isOverridden = !!pile[field];
  if (editing) {
    return (
      <div style={{ marginBottom:10 }}>
        <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:3 }}>
          <span style={FIELD_LBL}>{label}</span>
          <button onClick={()=>{ onUpdate({ ...pile, [field]: "" }); setEditing(false); }}
            title="Back to auto-calculated" style={{ background:"none", border:"none", color:"#4a7fa5", fontSize:10, cursor:"pointer", padding:0 }}>↺ auto</button>
        </div>
        <input type="number" value={pile[field]||""} onChange={e=>onUpdate({...pile,[field]:e.target.value})} style={FIELD_INP} autoFocus/>
      </div>
    );
  }
  return (
    <div style={{ marginBottom:10 }}>
      <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:3 }}>
        <span style={FIELD_LBL}>{label}</span>
        <span style={{ background:"#1a3a5c", color:"#7fc4f0", fontSize:9, fontWeight:800, padding:"1px 6px", borderRadius:5 }}>AUTO</span>
      </div>
      <div onClick={()=>setEditing(true)} style={{ ...FIELD_INP, display:"flex", alignItems:"center", justifyContent:"space-between", cursor:"pointer", color: computedValue ? "#4fc3f7" : "#4a7fa5", background:"#0a1a29" }}>
        <span>{computedValue ? `${computedValue}${unit}` : "—"}</span>
        <span style={{ fontSize:12, color:"#4a7fa5" }}>✏️</span>
      </div>
    </div>
  );
}

function PileDetailsForm({ pile, onUpdate }) {
  const set=(f,v)=>onUpdate({...pile,[f]:v});
  const inp=FIELD_INP;
  const lbl=FIELD_LBL;
  let project = {};
  try {
    const s = JSON.parse(localStorage.getItem("acip_store"));
    const act = s && s.projects && (s.projects.find(e=>e.id===s.activeId) || s.projects[0]);
    project = (act && act.project) || {};
  } catch(e) {}
  const derived = calcDerived(pile, project);
  return (
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 12px"}}>
      <div style={{ marginBottom:10 }}>
        <div style={lbl}>Pile Type <span style={{color:"#4a7fa5",fontWeight:400}}>(remembers its typical values)</span></div>
        <input value={pile.pileType} onChange={e=>{
          const applied = applyTypeMemory(pile, e.target.value);
          onUpdate(applied);
        }} style={inp}/>
      </div>
      <Field obj={pile} set={set} label="Pile Diameter (in)" field="pileDiameter" type="number"/>
      <Field obj={pile} set={set} label="Ground Elevation (ft)" field="groundElevation" type="number"/>
      <Field obj={pile} set={set} label="Pile Capacity (kips)" field="pileCapacity" type="number"/>
      <Field obj={pile} set={set} label="Pile Cap Thickness (ft)" field="capThickness" type="number"/>
      <ComputedField label="Pile Length (ft)" field="pileLength" pile={pile} onUpdate={onUpdate} computedValue={derived.pileLength}/>
      <Field obj={pile} set={set} label="Drill Depth (ft)" field="drillDepth" type="number"/>
      <ComputedField label="Tip Elevation (ft)" field="tipElevation" pile={pile} onUpdate={onUpdate} computedValue={derived.tipElevation}/>
      <ComputedField label="Cutoff Elevation (ft)" field="cutoffElevation" pile={pile} onUpdate={onUpdate} computedValue={derived.cutoffElevation}/>
      <ComputedField label="Theoretical Vol. (ft³)" field="theoreticalVol" pile={pile} onUpdate={onUpdate} computedValue={derived.theoretical}/>
      <Field obj={pile} set={set} label="Total Strokes Pumped" field="totalStrokes" type="number"/>
      <ComputedField label="Actual Volume (ft³)" field="actualVolume" pile={pile} onUpdate={onUpdate} computedValue={derived.actual} unit={derived.calibFactor?"":" (needs pump calib.)"}/>
      <ComputedField label="Grout Factor" field="groutFactor" pile={pile} onUpdate={onUpdate} computedValue={derived.groutFactor}/>
      <Field obj={pile} set={set} label="Reinforcing Steel" field="reinfSteel"/><Field obj={pile} set={set} label="Grout Strength" field="groutStrength"/>
      <Field obj={pile} set={set} label="Grout Supplier" field="groutSupplier"/><Field obj={pile} set={set} label="Product Code" field="productCode"/>
      <Field obj={pile} set={set} label="Flow (s) / Spread (in)" field="flow"/>
      <Field obj={pile} set={set} label="Slurry @ (ft)" field="slurryAt"/><Field obj={pile} set={set} label="Grout @ (ft)" field="groutAt"/>
      <Field obj={pile} set={set} label="Drill Start (editable)" field="drillStart"/><Field obj={pile} set={set} label="Drill End (editable)" field="drillEnd"/>
      <Field obj={pile} set={set} label="Grout Start (editable)" field="groutStart"/><Field obj={pile} set={set} label="Grout End (editable)" field="groutEnd"/>
      <Field obj={pile} set={set} label="Batch Time / Water" field="batchTime"/>
      <div style={{gridColumn:"1/-1",marginBottom:10}}>
        <div style={lbl}>Notes</div>
        <textarea value={pile.notes||""} onChange={e=>set("notes",e.target.value)} rows={3}
          style={{...inp,resize:"vertical"}} placeholder="General notes…"/>
      </div>
    </div>
  );
}

// ── Pile Panel ────────────────────────────────────────────────────────────────
// Pile settings modal — pile type, recording interval, grout spacing, and the
// Not Installed toggle. Shared by the pile detail page header.
function PileSettingsModal({ pile, index, onUpdate, onClose }) {
  const phase = pile.groutEnd?"complete":pile.groutStart?"grouting":pile.drillEnd?"grouting-ready":pile.drillStart?"drilling":"setup";
  // Settings (recording interval, ACIP/RI) can only be changed before
  // drilling starts — changing mid-pile would corrupt the depth math.
  const settingsLocked = phase !== "setup";
  return (
    <div style={{ position:"fixed", top:0, left:0, width:"100vw", height:"100dvh", background:"rgba(0,0,0,0.8)", zIndex:300, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }} onClick={onClose}>
      <div style={{ background:"#132536", borderRadius:18, padding:22, maxWidth:340, width:"100%" }} onClick={e=>e.stopPropagation()}>
        <div style={{ color:"#fff", fontWeight:900, fontSize:17, marginBottom:4 }}>⚙️ Pile #{index+1} Settings</div>
        {settingsLocked ? (
          <div style={{ color:"#f0c040", fontSize:12, marginBottom:16 }}>Pile type & grout spacing lock once drilling starts. Recording interval can still be switched mid-pile (e.g. drop to 1ft near a depth that isn't a multiple of 5).</div>
        ) : (
          <div style={{ color:"#a8c0d9", fontSize:12, marginBottom:16 }}>Applies to this pile. Carries forward to the next new pile automatically.</div>
        )}

        <div style={{ color:"#a8c0d9", fontSize:12, fontWeight:700, marginBottom:6 }}>Pile Type</div>
        <div style={{ display:"flex", gap:8, marginBottom:16 }}>
          {[["ACIP","Augercast (reinforced)"],["RI","Rigid Inclusion (unreinforced)"]].map(([k,label])=>(
            <button key={k} disabled={settingsLocked} onClick={()=>onUpdate({...pile,pileKind:k})} style={{
              flex:1, padding:"10px 6px", borderRadius:10, border: pile.pileKind===k ? "2px solid #2ecc71" : "1px solid #2d4a5c",
              background: pile.pileKind===k ? "#1a4a2e" : "#0d2236", color:"#fff", fontSize:12, fontWeight:700,
              cursor: settingsLocked ? "default" : "pointer", opacity: settingsLocked ? 0.6 : 1
            }}>{label}</button>
          ))}
        </div>

        <div style={{ color:"#a8c0d9", fontSize:12, fontWeight:700, marginBottom:6 }}>Record seconds/torque every <span style={{color:"#2ecc71",fontWeight:400}}>(switchable mid-pile)</span></div>
        <div style={{ display:"flex", gap:8, marginBottom:16 }}>
          {[[1,"1 ft (standard)"],[5,"5 ft (reduced)"]].map(([n,label])=>(
            <button key={n} onClick={()=>onUpdate({...pile,footInterval:n})} style={{
              flex:1, padding:"10px 6px", borderRadius:10, border: pile.footInterval===n ? "2px solid #2ecc71" : "1px solid #2d4a5c",
              background: pile.footInterval===n ? "#1a4a2e" : "#0d2236", color:"#fff", fontSize:12, fontWeight:700,
              cursor:"pointer"
            }}>{label}</button>
          ))}
        </div>

        <div style={{ color:"#a8c0d9", fontSize:12, fontWeight:700, marginBottom:6 }}>Grout band spacing</div>
        <div style={{ display:"flex", gap:8, marginBottom:20 }}>
          {[[5,"Every 5 ft (standard)"],[10,"Every 10 ft (reduced)"]].map(([n,label])=>(
            <button key={n} disabled={settingsLocked} onClick={()=>onUpdate({...pile,groutInterval:n})} style={{
              flex:1, padding:"10px 6px", borderRadius:10, border: pile.groutInterval===n ? "2px solid #2ecc71" : "1px solid #2d4a5c",
              background: pile.groutInterval===n ? "#1a4a2e" : "#0d2236", color:"#fff", fontSize:12, fontWeight:700,
              cursor: settingsLocked ? "default" : "pointer", opacity: settingsLocked ? 0.6 : 1
            }}>{label}</button>
          ))}
        </div>

        <div style={{ color:"#a8c0d9", fontSize:12, fontWeight:700, marginBottom:6 }}>Installation status</div>
        <button onClick={()=>onUpdate({...pile,notInstalled:!pile.notInstalled})} style={{
          width:"100%", padding:"10px 6px", borderRadius:10, marginBottom:20,
          border: pile.notInstalled ? "2px solid #e74c3c" : "1px solid #2d4a5c",
          background: pile.notInstalled ? "#4a1510" : "#0d2236", color: pile.notInstalled ? "#e74c3c" : "#fff",
          fontSize:12, fontWeight:700, cursor:"pointer"
        }}>
          {pile.notInstalled ? "⛔ NOT INSTALLED — will show in summary (tap to undo)" : "Mark as Not Installed (pile to be redrilled)"}
        </button>

        <button onClick={onClose} style={{ width:"100%", padding:13, borderRadius:10, border:"none", background:"#27ae60", color:"#fff", fontSize:15, fontWeight:800, cursor:"pointer" }}>Done</button>
      </div>
    </div>
  );
}

// PilePanel is now pure content for the dedicated pile page — header, nav,
// settings gear, and delete all live in PileDetailPage instead.
function PilePanel({ pile, index, onUpdate }) {
  const phase = pile.groutEnd?"complete":pile.groutStart?"grouting":pile.drillEnd?"grouting-ready":pile.drillStart?"drilling":"setup";
  const [tab, setTab] = useState("log");
  const [editFoot, setEditFoot] = useState(null); // edit drill feet after completion
  const [showFillSecs, setShowFillSecs] = useState(false);
  const [redistributeMode, setRedistributeMode] = useState(false);
  // Toggling redistribute mode re-renders the foot rows (different row style
  // and heights), which resets the INNER scrollable foot list back to the
  // top — that list has its own scrollbox (maxHeight 260), so preserving
  // window.scrollY alone wasn't enough. Capture both the window position and
  // the inner list's scrollTop before the toggle and restore them right
  // after, so the feet the user was looking at stay put.
  const footListRef = useRef(null);
  const scrollYRef = useRef(0);
  const footListScrollRef = useRef(0);
  const pendingRestoreRef = useRef(false);
  const toggleRedistribute = () => {
    scrollYRef.current = window.scrollY;
    footListScrollRef.current = footListRef.current ? footListRef.current.scrollTop : 0;
    pendingRestoreRef.current = true;
    setRedistributeMode(m => !m);
    setRedistributeSel([]);
  };
  useLayoutEffect(() => {
    if (!pendingRestoreRef.current) return; // don't scroll-jump on mount
    pendingRestoreRef.current = false;
    window.scrollTo(0, scrollYRef.current);
    if (footListRef.current) footListRef.current.scrollTop = footListScrollRef.current;
  }, [redistributeMode]);
  const [redistributeSel, setRedistributeSel] = useState([]); // array of foot numbers selected
  // Completed sections (drilling / grouting) start collapsed on a finished
  // pile so the page opens short — tap to expand either one.
  const [drillOpen, setDrillOpen] = useState(phase !== "complete");
  const [groutOpen, setGroutOpen] = useState(phase !== "complete");
  const prevPhase = useRef(phase);
  // Auto-collapse the moment a pile completes mid-session (the useState
  // initial value above only applies on mount, so this catches the
  // transition when it happens without navigating away and back).
  useEffect(() => {
    if (prevPhase.current !== "complete" && phase === "complete") {
      setDrillOpen(false);
      setGroutOpen(false);
    }
    prevPhase.current = phase;
  }, [phase]);

  return (
    <div>
      {/* Times strip */}
      {(pile.drillStart||pile.drillEnd||pile.groutStart||pile.groutEnd)&&(
        <div style={{background:"#071520",display:"flex",flexWrap:"wrap"}}>
          {[["Drill Start",pile.drillStart],["Drill End",pile.drillEnd],["Grout Start",pile.groutStart],["Grout End",pile.groutEnd]].map(([l,v])=>v?(
            <div key={l} style={{padding:"5px 12px",borderRight:"1px solid #1a3a5c"}}>
              <div style={{color:"#4a7fa5",fontSize:9}}>{l}</div>
              <div style={{color:"#fff",fontSize:11,fontWeight:700}}>{v}</div>
            </div>
          ):null)}
        </div>
      )}

      <div style={{display:"flex",borderBottom:"1px solid #1a3a5c"}}>
        {[["log","📊 Log"],["details","📋 Details"]].map(([k,l])=>(
          <button key={k} onClick={()=>setTab(k)} style={{
            flex:1,padding:"10px 0",border:"none",cursor:"pointer",fontSize:13,fontWeight:tab===k?800:400,
            background:tab===k?"#1a3a5c":"#132536",color:tab===k?"#fff":"#4a7fa5",
            borderBottom:tab===k?"3px solid #4fc3f7":"3px solid transparent"
          }}>{l}</button>
        ))}
      </div>

      <div style={{padding:14}}>
        {tab==="log"&&(
          <>
            {(phase==="setup"||phase==="drilling")&&<DrillScreen pile={pile} onUpdate={onUpdate}/>}
            {(phase==="grouting-ready"||phase==="grouting")&&<GroutScreen pile={pile} onUpdate={onUpdate}/>}
            {phase==="complete"&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                {/* Completion banner */}
                <div style={{background:"#0d2a1a",borderRadius:12,padding:"12px 16px",display:"flex",alignItems:"center",gap:12}}>
                  <span style={{fontSize:28}}>✅</span>
                  <div>
                    <div style={{fontSize:16,fontWeight:900,color:"#2ecc71"}}>Pile Complete</div>
                    <div style={{color:"#a8c0d9",fontSize:12}}>{depthFt(pile)} ft drilled · Grout {pile.groutStart} → {pile.groutEnd}</div>
                  </div>
                </div>

                {/* Drill log — full, editable even after completion; collapses by default */}
                <div style={{background:"#071520",borderRadius:12,padding:"10px 12px"}}>
                  <div onClick={()=>setDrillOpen(o=>!o)} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom: drillOpen?6:0,flexWrap:"wrap",gap:6,cursor:"pointer"}}>
                    <span style={{color:"#4a7fa5",fontSize:11,fontWeight:700}}>🔩 Drill log — {depthFt(pile)} ft {drillOpen?"▲":"▼"}</span>
                    {drillOpen && (
                    <div style={{display:"flex",gap:6}}>
                      {missingFeet(pile).length>0 && !redistributeMode && (
                        <button onClick={(e)=>{e.stopPropagation();setShowFillSecs(true);}} style={{background:"#7a5c00",border:"1px solid #f0c040",borderRadius:8,color:"#ffd700",fontSize:12,fontWeight:800,padding:"6px 12px",cursor:"pointer"}}>
                          ⏱ Fill missing seconds ({missingFeet(pile).length})
                        </button>
                      )}
                      {(pile.feet||[]).length>1 && (
                        <button onClick={(e)=>{e.stopPropagation();toggleRedistribute();}} style={{
                          background: redistributeMode ? "#5c2d91" : "transparent", border:"1px solid #8e44ad", borderRadius:8,
                          color: redistributeMode ? "#fff" : "#c39bd3", fontSize:12, fontWeight:800, padding:"6px 12px", cursor:"pointer"
                        }}>
                          {redistributeMode ? "✕ Cancel" : "⚖️ Redistribute"}
                        </button>
                      )}
                    </div>
                    )}
                  </div>
                  {drillOpen && (<>
                  {redistributeMode && (
                    <div style={{color:"#c39bd3",fontSize:11,marginBottom:8,lineHeight:1.4}}>
                      Select a run of consecutive feet below, then split their combined seconds evenly. Use this if the stopwatch got tapped late or early on some taps but the drilling was actually steady.
                    </div>
                  )}
                  <div ref={footListRef} style={{maxHeight:260,overflowY:"auto"}}>
                    {(pile.feet||[]).map((f,fi)=>{
                      const hi=f.knm&&parseInt(f.knm)>75;
                      const selected = redistributeSel.includes(f.foot);
                      // Only allow selecting a contiguous run — tapping a foot that isn't
                      // adjacent to the current selection starts a new selection instead.
                      const toggleSelect = () => {
                        setRedistributeSel(sel => {
                          if (sel.includes(f.foot)) return sel.filter(x=>x!==f.foot);
                          if (sel.length === 0) return [f.foot];
                          const idxs = sel.map(s => pile.feet.findIndex(pf=>pf.foot===s));
                          const minI = Math.min(...idxs), maxI = Math.max(...idxs);
                          if (fi === minI-1 || fi === maxI+1) return [...sel, f.foot].sort((a,b)=>a-b);
                          return [f.foot]; // non-adjacent tap restarts the selection
                        });
                      };
                      if (redistributeMode) {
                        return (
                          <div key={f.foot} onClick={toggleSelect} style={{display:"flex",gap:8,alignItems:"center",padding:"6px 4px",borderBottom:"1px solid #0d2236",background:selected?"rgba(142,68,173,0.25)":"transparent",borderRadius:selected?6:0,cursor:"pointer"}}>
                            <span style={{width:20,height:20,borderRadius:5,border:`2px solid ${selected?"#c39bd3":"#2d4a5c"}`,background:selected?"#8e44ad":"transparent",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,color:"#fff",flexShrink:0}}>{selected?"✓":""}</span>
                            <span style={{color:"#4fc3f7",fontWeight:700,width:36,fontSize:12}}>{f.foot}ft</span>
                            <span style={{color:"#fff",fontWeight:700,width:32,fontSize:12}}>{f.seconds!=null?`${f.seconds}s`:"—"}</span>
                            {f.knm
                              ?<span style={{color:hi?"#e74c3c":"#a8c0d9",fontWeight:hi?800:400,fontSize:11,width:46}}>{f.knm}K{hi?" ⚠":""}</span>
                              :<span style={{width:46}}/>
                            }
                          </div>
                        );
                      }
                      return (
                        <div key={f.foot} onClick={()=>setEditFoot({...f})} style={{display:"flex",gap:8,alignItems:"center",padding:"11px 6px",borderBottom:"1px solid #0d2236",cursor:"pointer"}}>
                          <span style={{color:"#4fc3f7",fontWeight:700,width:40,fontSize:14}}>{f.foot}ft</span>
                          <span style={{color:"#fff",fontWeight:700,width:38,fontSize:14}}>{f.seconds!=null?`${f.seconds}s`:"—"}</span>
                          {f.knm
                            ?<span style={{color:hi?"#e74c3c":"#a8c0d9",fontWeight:hi?800:400,fontSize:12,width:50}}>{f.knm}K{hi?" ⚠":""}</span>
                            :<span style={{width:50}}/>
                          }
                          <span style={{color:"#f0c040",fontSize:11,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{f.note||""}</span>
                          <span style={{ color:"#4a7fa5", fontSize:13, flexShrink:0 }}>✏️ ›</span>
                          <button onClick={(e)=>{
                            e.stopPropagation();
                            if(!window.confirm(`Delete the ${f.foot}ft entry? Other feet keep their own depths — this doesn't shift them.`)) return;
                            // Depths are no longer count×interval — each foot stores its own
                            // true depth, so deleting one just removes it (no renumbering needed,
                            // which also makes this safe for piles with mixed 5ft/1ft intervals).
                            const remaining = (pile.feet||[]).filter((_,i)=>i!==fi);
                            const newDepth = remaining.length ? remaining[remaining.length-1].foot : 0;
                            const oldBands = pile.groutBands || [];
                            const newBands = buildGroutBands(newDepth, pile.groutInterval || 5).map(nb => {
                              const match = oldBands.find(ob => ob.depth === nb.depth);
                              return match ? { ...nb, strokes: match.strokes } : nb;
                            });
                            onUpdate({ ...pile, feet: remaining, groutBands: newBands });
                          }} style={{background:"#3d1a15",border:"none",borderRadius:8,color:"#e74c3c",fontSize:14,padding:"8px 12px",cursor:"pointer",flexShrink:0}}>🗑</button>
                        </div>
                      );
                    })}
                  </div>

                  {redistributeMode && redistributeSel.length>=2 && (() => {
                    const selFeet = pile.feet.filter(f=>redistributeSel.includes(f.foot));
                    const total = selFeet.reduce((s,f)=>s+(f.seconds||0),0);
                    const n = selFeet.length;
                    const base = Math.floor(total/n), extra = total - base*n;
                    return (
                      <div style={{marginTop:10,background:"#1a0f26",border:"1px solid #8e44ad",borderRadius:10,padding:"10px 12px"}}>
                        <div style={{color:"#c39bd3",fontSize:12,marginBottom:8}}>
                          {n} feet selected · total <b>{total}s</b> · will become ~<b>{base}{extra?`–${base+1}`:""}s</b> each
                        </div>
                        <button onClick={()=>{
                          // Distribute the total as evenly as possible; any remainder
                          // (from non-divisible totals) goes to the first few feet so
                          // the sum stays exactly correct.
                          const selFootNums = new Set(redistributeSel);
                          let assigned = 0;
                          const newFeet = pile.feet.map(f => {
                            if (!selFootNums.has(f.foot)) return f;
                            const i = selFeet.findIndex(sf=>sf.foot===f.foot);
                            const val = base + (i < extra ? 1 : 0);
                            assigned++;
                            return { ...f, seconds: val };
                          });
                          onUpdate({ ...pile, feet: newFeet });
                          setRedistributeSel([]);
                          setRedistributeMode(false);
                        }} style={{width:"100%",padding:12,borderRadius:10,border:"none",background:"#8e44ad",color:"#fff",fontWeight:800,fontSize:14,cursor:"pointer"}}>
                          ⚖️ Split {total}s evenly across {n} feet
                        </button>
                      </div>
                    );
                  })()}
                  {redistributeMode && redistributeSel.length===1 && (
                    <div style={{marginTop:8,color:"#7a6a8a",fontSize:11,textAlign:"center"}}>Select at least one more adjacent foot to redistribute.</div>
                  )}

                  {!redistributeMode && (
                  <button onClick={()=>{
                    // Default the new entry to +1ft past the last logged depth —
                    // this is the common case (finishing off a non-multiple-of-5
                    // depth after 5ft-interval recording). Edit the foot number
                    // afterward via ✏️ if a different step is needed.
                    const lastDepth = depthFt(pile);
                    const newFoot = { foot: lastDepth + 1, seconds: null, knm: "", note: "" };
                    const newFeet = [...(pile.feet||[]), newFoot];
                    const newDepth = newFoot.foot;
                    const oldBands = pile.groutBands || [];
                    const newBands = buildGroutBands(newDepth, pile.groutInterval || 5).map(nb => {
                      const match = oldBands.find(ob => ob.depth === nb.depth);
                      return match ? { ...nb, strokes: match.strokes } : nb;
                    });
                    onUpdate({ ...pile, feet: newFeet, groutBands: newBands });
                    setEditFoot({ ...newFoot });
                  }} style={{width:"100%",marginTop:8,padding:10,borderRadius:10,border:"2px dashed #2d6a9f",background:"transparent",color:"#4a7fa5",fontWeight:700,fontSize:12,cursor:"pointer"}}>
                    + Add Foot ({depthFt(pile)+1}ft)
                  </button>
                  )}
                  </>)}
                </div>

                {/* Grout log — reuse grout screen in done state (band grid, slurry/grout, trucks); collapses by default */}
                <div style={{background:"#071520",borderRadius:12,padding:"10px 12px"}}>
                  <div onClick={()=>setGroutOpen(o=>!o)} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom: groutOpen?6:0,cursor:"pointer"}}>
                    <span style={{color:"#4a7fa5",fontSize:11,fontWeight:700}}>💉 Grouting — bands, trucks, notes {groutOpen?"▲":"▼"}</span>
                  </div>
                  {groutOpen && <GroutScreen pile={pile} onUpdate={onUpdate}/>}
                </div>

                {showFillSecs && (
                  <FillSecondsModal pile={pile} onUpdate={onUpdate} onClose={()=>setShowFillSecs(false)}/>
                )}

                {/* Edit foot modal (post-completion) */}
                {editFoot && (
                  <FootEditModal pile={pile} foot={editFoot} feetList={pile.feet||[]} onUpdate={onUpdate} onClose={() => setEditFoot(null)} />
                )}
              </div>
            )}
          </>
        )}
        {tab==="details"&&<PileDetailsForm pile={pile} onUpdate={onUpdate}/>}
      </div>
    </div>
  );
}

// ── Project Form ──────────────────────────────────────────────────────────────
function ProjectForm({ project, onChange }) {
  const set=(f,v)=>onChange({...project,[f]:v});
  const inp={width:"100%",padding:"9px 10px",borderRadius:8,border:"1px solid #2d4a5c",background:"#071520",color:"#fff",fontSize:14,boxSizing:"border-box"};
  const lbl={fontSize:11,fontWeight:700,color:"#a8c0d9",marginBottom:3};
  return (
    <div style={{background:"#132536",borderRadius:12,padding:16,marginBottom:14,boxShadow:"0 2px 10px rgba(0,0,0,0.3)"}}>
      <div style={{fontWeight:800,fontSize:15,color:"#fff",marginBottom:12}}>Project Information</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 12px"}}>
        <Field obj={project} set={set} label="Project Name" field="projectName"/><Field obj={project} set={set} label="Project No." field="projectNo"/>
        <Field obj={project} set={set} label="Location" field="location"/>
        <Field obj={project} set={set} label="Piling Contractor" field="pilingContractor"/><Field obj={project} set={set} label="Inspector" field="inspector"/>
        <Field obj={project} set={set} label="Equipment" field="equipment"/>
      </div>
      <div style={{borderTop:"1px solid #1a3a5c",marginTop:6,paddingTop:12}}>
        <div style={{fontWeight:800,fontSize:13,color:"#fff",marginBottom:10}}>Pump Calibration <span style={{color:"#4a7fa5",fontWeight:400,fontSize:11}}>(used to auto-compute Actual Volume & Grout Factor)</span></div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 12px"}}>
          <Field obj={project} set={set} label="Calibration (ft³/stroke)" field="pumpCalibFactor"/>
          <Field obj={project} set={set} label="Date of Calibration" field="lastCalibDate"/>
        </div>
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
// ── Pile List Page (compact rows — tap to open the dedicated pile page) ────────
function PileListPage({ piles, project, onOpen, onAdd, onRemove }) {
  const phaseOf = (pile) => pile.groutEnd?"complete":pile.groutStart?"grouting":pile.drillEnd?"grouting-ready":pile.drillStart?"drilling":"setup";
  const phaseColor={setup:"#1a3a5c",drilling:"#1a5c2e",["grouting-ready"]:"#5c2d91",grouting:"#5c2d91",complete:"#0d2a1a"};
  const phaseLabel={setup:"Setup",drilling:"🔩 Drilling",["grouting-ready"]:"Ready to Grout",grouting:"💉 Grouting",complete:"✓ Done"};

  return (
    <div>
      {piles.map((pile, i) => {
        const phase = phaseOf(pile);
        const isDupNo = !!pile.pileNo && piles.filter(x=>x.pileNo&&x.pileNo.trim()===pile.pileNo.trim()).length>1;
        const derived = phase==="complete" ? calcDerived(pile, project) : null;
        const gfLow = derived && derived.groutFactor && parseFloat(derived.groutFactor) < 1;
        return (
          <div key={pile.id} onClick={()=>onOpen(pile.id)} style={{
            background:"#132536", borderRadius:14, boxShadow:"0 2px 14px rgba(0,0,0,0.3)",
            marginBottom:10, cursor:"pointer", overflow:"hidden", borderLeft:`5px solid ${phaseColor[phase]==="#132536"?"#1a3a5c":phaseColor[phase]}`
          }}>
            <div style={{ padding:"13px 14px", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
              <span style={{color:"#fff",fontWeight:900,fontSize:15}}>#{i+1}</span>
              <span style={{color:"#fff",fontWeight:800,fontSize:15}}>{pile.pileNo || "(no number)"}</span>
              <span style={{color:"#a8c0d9",fontSize:11,background:"#0d2236",padding:"3px 8px",borderRadius:6}}>{phaseLabel[phase]}</span>
              {phase!=="setup" && <span style={{color:"#4a7fa5",fontSize:12}}>{depthFt(pile)} ft</span>}
              {derived && derived.groutFactor && (
                <span style={{color: gfLow ? "#e74c3c" : "#2ecc71", fontSize:12, fontWeight:700}}>GF {derived.groutFactor}</span>
              )}
              {pile.pileKind==="RI"&&<span style={{background:"#2d6a4f",color:"#fff",fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:6}}>RI</span>}
              {pile.notInstalled&&<span style={{background:"#c0392b",color:"#fff",fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:6}}>⛔ NOT INSTALLED</span>}
              {isDupNo&&<span style={{background:"#b7791f",color:"#fff",fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:6}}>⚠ Dup No.</span>}
              {pile.refusalDepth&&<span style={{background:"#c0392b",color:"#fff",fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:6}}>⛔ {pile.refusalDepth}ft</span>}
              <span style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:8}}>
                {onRemove && (
                  <button onClick={e=>{e.stopPropagation();onRemove(pile.id);}} style={{background:"#922b21",border:"none",color:"#fff",borderRadius:6,padding:"4px 9px",cursor:"pointer",fontSize:12}}>✕</button>
                )}
                <span style={{color:"#4a7fa5",fontSize:16}}>›</span>
              </span>
            </div>
          </div>
        );
      })}
      <button onClick={onAdd} style={{width:"100%",padding:16,borderRadius:12,border:"2px dashed #2d6a9f",background:"transparent",color:"#4a7fa5",fontWeight:700,fontSize:14,cursor:"pointer"}}>
        + New Pile
      </button>
    </div>
  );
}

// ── Pile Detail Page (dedicated page for one pile, with Prev/Next nav) ─────────
function PileDetailPage({ piles, pileId, onUpdate, onRemove, onBack, onNavigate }) {
  const idx = piles.findIndex(p => p.id === pileId);
  const pile = piles[idx];
  const [showSettings, setShowSettings] = useState(false);
  if (!pile) return null;

  const phase = pile.groutEnd?"complete":pile.groutStart?"grouting":pile.drillEnd?"grouting-ready":pile.drillStart?"drilling":"setup";
  const phaseColor={setup:"#1a3a5c",drilling:"#1a5c2e",["grouting-ready"]:"#5c2d91",grouting:"#5c2d91",complete:"#0d2a1a"};
  const phaseLabel={setup:"Setup",drilling:"🔩 Drilling",["grouting-ready"]:"Ready to Grout",grouting:"💉 Grouting",complete:"✓ Done"};
  const isDupNo = !!pile.pileNo && piles.filter(x=>x.pileNo&&x.pileNo.trim()===pile.pileNo.trim()).length>1;
  const atFirst = idx <= 0, atLast = idx >= piles.length-1;

  return (
    <div>
      {/* Back / Prev / Next */}
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,flexWrap:"wrap"}}>
        <button onClick={onBack} style={{padding:"8px 12px",borderRadius:8,border:"1px solid #2d4a5c",background:"transparent",color:"#a8c0d9",fontSize:13,cursor:"pointer",fontWeight:700}}>← All Piles</button>
        <button disabled={atFirst} onClick={()=>onNavigate(piles[idx-1].id)} style={{padding:"8px 12px",borderRadius:8,border:"1px solid #2d4a5c",background: atFirst?"#0a1a29":"#132536",color: atFirst?"#2d4a5c":"#a8c0d9",fontSize:13,cursor: atFirst?"default":"pointer",fontWeight:700}}>◀ Prev</button>
        <button disabled={atLast} onClick={()=>onNavigate(piles[idx+1].id)} style={{padding:"8px 12px",borderRadius:8,border:"1px solid #2d4a5c",background: atLast?"#0a1a29":"#132536",color: atLast?"#2d4a5c":"#a8c0d9",fontSize:13,cursor: atLast?"default":"pointer",fontWeight:700}}>Next ▶</button>
      </div>

      {/* Quick-jump pile tab strip */}
      {piles.length>1 && (
        <div style={{display:"flex",gap:6,overflowX:"auto",paddingBottom:8,marginBottom:8}}>
          {piles.map((p,i)=>(
            <button key={p.id} onClick={()=>onNavigate(p.id)} style={{
              flexShrink:0,padding:"7px 12px",borderRadius:8,border: p.id===pileId?"2px solid #4fc3f7":"1px solid #1a3a5c",
              background: p.id===pileId?"#1a3a5c":"#132536",color: p.id===pileId?"#fff":"#4a7fa5",fontSize:12,fontWeight:p.id===pileId?800:400,cursor:"pointer",whiteSpace:"nowrap"
            }}>#{i+1}{p.pileNo?` ${p.pileNo}`:""}</button>
          ))}
        </div>
      )}

      <div style={{background:"#132536",borderRadius:14,boxShadow:"0 2px 14px rgba(0,0,0,0.3)",overflow:"hidden"}}>
        <div style={{background:phaseColor[phase],padding:"11px 14px",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
          <span style={{color:"#fff",fontWeight:900,fontSize:15}}>Pile #{idx+1}</span>
          <input value={pile.pileNo} onChange={e=>onUpdate({...pile,pileNo:e.target.value})} placeholder="No."
            style={{padding:"5px 8px",borderRadius:6,border:"none",fontSize:16,fontWeight:700,width:72}}/>
          <span style={{color:"#a8c0d9",fontSize:11}}>{phaseLabel[phase]}</span>
          {pile.pileKind==="RI"&&<span style={{background:"#2d6a4f",color:"#fff",fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:6}}>RI</span>}
          {pile.notInstalled&&<span style={{background:"#c0392b",color:"#fff",fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:6}}>⛔ NOT INSTALLED</span>}
          {isDupNo&&<span style={{background:"#b7791f",color:"#fff",fontSize:11,fontWeight:700,padding:"2px 7px",borderRadius:6}}>⚠ Duplicate No.</span>}
          {pile.refusalDepth&&<span style={{background:"#c0392b",color:"#fff",fontSize:11,fontWeight:700,padding:"2px 7px",borderRadius:6}}>⛔ {pile.refusalDepth}ft</span>}
          <span style={{marginLeft:"auto",display:"flex",gap:8}}>
            <button onClick={()=>setShowSettings(true)} title="Pile settings" style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:6,padding:"5px 9px",cursor:"pointer",fontSize:14}}>⚙️</button>
            <button onClick={()=>onRemove(pile.id)} style={{background:"#922b21",border:"none",color:"#fff",borderRadius:6,padding:"5px 10px",cursor:"pointer",fontSize:13}}>✕</button>
          </span>
        </div>
        {showSettings && <PileSettingsModal pile={pile} index={idx} onUpdate={onUpdate} onClose={()=>setShowSettings(false)}/>}
        <PilePanel key={pile.id} pile={pile} index={idx} onUpdate={onUpdate}/>
      </div>
    </div>
  );
}

function App() {
  // ── Multi-project store: projects[] each with own info + piles ──
  // Migrates the old single-project storage automatically on first load.
  // Fields a new pile inherits from the previous one (manual, non-computed inputs).
  const INHERIT_FIELDS = ["pileKind","footInterval","groutInterval","pileType","pileDiameter","groundElevation","pileCapacity","capThickness","reinfSteel","groutStrength","groutSupplier","productCode","flow"];
  const inheritedPile = (fromPile) => {
    const np = emptyPile();
    if (fromPile) INHERIT_FIELDS.forEach(k => { if (fromPile[k]) np[k] = fromPile[k]; });
    return np;
  };
  const freshDay = (seedPile) => ({ id: Date.now()+Math.random(), date: new Date().toLocaleDateString("en-US"), piles: [seedPile || emptyPile()] });

  // Normalize any older store shape (projects without days) into project→days→piles
  const normalizeEntry = (e) => {
    // Repair any feet corrupted by the old Prev/Next overwrite bug on load
    const fixDays = (days) => days.map(d => ({ ...d, piles: (d.piles||[]).map(repairFeet) }));
    if (Array.isArray(e.days) && e.days.length) return { ...e, days: fixDays(e.days) };
    const day = { id: (e.id||Date.now())+1, date: (e.project&&e.project.date) || new Date().toLocaleDateString("en-US"), piles: (Array.isArray(e.piles)&&e.piles.length)?e.piles.map(repairFeet):[emptyPile()] };
    return { id: e.id, project: e.project||emptyProject(), days: [day], activeDayId: day.id };
  };

  const [store, setStore] = useState(() => {
    try {
      const s = JSON.parse(localStorage.getItem("acip_store"));
      if (s && Array.isArray(s.projects) && s.projects.length) {
        return { ...s, projects: s.projects.map(normalizeEntry) };
      }
    } catch(e) {}
    // Migrate legacy single-project data if present
    try {
      const p = JSON.parse(localStorage.getItem("acip_project"));
      const pl = JSON.parse(localStorage.getItem("acip_piles"));
      if (p || (Array.isArray(pl) && pl.length)) {
        const entry = normalizeEntry({ id: Date.now(), project: p || emptyProject(), piles: (Array.isArray(pl)&&pl.length)?pl:[emptyPile()] });
        return { projects: [entry], activeId: entry.id };
      }
    } catch(e) {}
    const entry = normalizeEntry({ id: Date.now(), project: emptyProject() });
    return { projects: [entry], activeId: entry.id };
  });

  useEffect(() => {
    try { localStorage.setItem("acip_store", JSON.stringify(store)); } catch(e) {}
  }, [store]);

  const active = store.projects.find(e => e.id === store.activeId) || store.projects[0];
  const project = active.project;
  const activeDay = active.days.find(d => d.id === active.activeDayId) || active.days[active.days.length-1];
  const piles = activeDay.piles;
  // PDFs use the active day's date
  const projectForPdf = { ...project, date: activeDay.date };

  const setProject = (proj) => setStore(s => ({ ...s,
    projects: s.projects.map(e => e.id === active.id ? { ...e, project: typeof proj === "function" ? proj(e.project) : proj } : e)
  }));
  const setPiles = (updater) => setStore(s => ({ ...s,
    projects: s.projects.map(e => e.id !== active.id ? e : {
      ...e, days: e.days.map(d => d.id !== activeDay.id ? d : { ...d, piles: typeof updater === "function" ? updater(d.piles) : updater })
    })
  }));

  const addProject = () => {
    const entry = normalizeEntry({ id: Date.now(), project: emptyProject() });
    setStore(s => ({ projects: [...s.projects, entry], activeId: entry.id }));
    setShowProject(true);
    setOpenPileId(null);
  };
  const switchProject = (id) => { setStore(s => ({ ...s, activeId: id })); setOpenPileId(null); };
  const deleteProject = (id) => {
    if (!window.confirm("Delete this project and ALL its days & piles? Make sure you've downloaded its PDFs first.")) return;
    if (!window.confirm("Are you sure? This cannot be undone.")) return;
    setStore(s => {
      const remaining = s.projects.filter(e => e.id !== id);
      const projects = remaining.length ? remaining : [normalizeEntry({ id: Date.now(), project: emptyProject() })];
      return { projects, activeId: projects[0].id };
    });
    setOpenPileId(null);
  };

  // ── Day management ──
  const addDay = () => {
    // Seed the new day's first pile with setup inherited from yesterday's last pile
    const lastPile = activeDay.piles[activeDay.piles.length-1];
    const day = freshDay(inheritedPile(lastPile));
    setStore(s => ({ ...s, projects: s.projects.map(e => e.id !== active.id ? e : { ...e, days: [...e.days, day], activeDayId: day.id }) }));
    setOpenPileId(null);
  };
  const switchDay = (id) => { setStore(s => ({ ...s, projects: s.projects.map(e => e.id !== active.id ? e : { ...e, activeDayId: id }) })); setOpenPileId(null); };
  const deleteDay = (id) => {
    const d = active.days.find(x => x.id === id);
    if (!window.confirm(`Delete the ${d?.date||""} day and its ${d?.piles.length||0} pile(s)? Make sure you've downloaded that day's PDF first.`)) return;
    if (!window.confirm("Are you sure? This cannot be undone.")) return;
    setStore(s => ({ ...s, projects: s.projects.map(e => {
      if (e.id !== active.id) return e;
      const remaining = e.days.filter(x => x.id !== id);
      const days = remaining.length ? remaining : [freshDay()];
      return { ...e, days, activeDayId: days[days.length-1].id };
    })}));
  };
  const [generating, setGenerating] = useState(false);
  const [showProject, setShowProject] = useState(true);
  const [sunMode, setSunMode] = useState(false);
  const [importError, setImportError] = useState("");
  const [openPileId, setOpenPileId] = useState(null); // which pile is showing as a dedicated page (null = list view)
  const [showAppSettings, setShowAppSettings] = useState(false); // app-level settings modal (Export/Import)

  // Export all data as JSON file for backup/transfer to new hosting
  const handleExport = () => {
    try {
      const dataStr = JSON.stringify(store, null, 2);
      const blob = new Blob([dataStr], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const now = new Date();
      const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
      a.download = `acip_backup_${dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch(e) {
      alert("Export failed: " + e.message);
    }
  };

  // Import data from JSON backup file
  const handleImport = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const imported = JSON.parse(ev.target.result);
          // Validate the structure has minimal required fields
          if (!imported.projects || !Array.isArray(imported.projects)) throw new Error("Invalid backup format");
          if (imported.projects.length === 0) throw new Error("Backup contains no projects");
          if (!imported.activeId) throw new Error("Missing activeId");
          // Replace the entire store with imported data
          setStore(imported);
          setImportError("");
          alert("Data imported successfully! Your piles and projects are now in the app.");
        } catch(err) {
          const msg = "Import failed: " + err.message;
          setImportError(msg);
          alert(msg);
        }
      };
      reader.readAsText(file);
    };
    input.click();
  };

  // Keep screen awake so the tablet doesn't sleep mid-pile
  useEffect(() => {
    let lock = null;
    const acquire = async () => {
      try { if ("wakeLock" in navigator) lock = await navigator.wakeLock.request("screen"); } catch(e) {}
    };
    acquire();
    const onVis = () => { if (document.visibilityState === "visible") acquire(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { document.removeEventListener("visibilitychange", onVis); try{ lock && lock.release(); }catch(e){} };
  }, []);
  const [pdfUrl, setPdfUrl] = useState(null);
  const [pdfPages, setPdfPages] = useState([]); // rendered page images (dataURLs)
  const [pdfRendering, setPdfRendering] = useState(false);

  // Render PDF pages to images — works on ALL browsers (iOS Safari only shows
  // page 1 in iframes; Android Chrome often shows nothing)
  const renderPdfPages = async (url) => {
    if (!window.pdfjsLib) return; // fallback: iframe still shown if pdf.js missing
    setPdfRendering(true);
    try {
      const doc = await pdfjsLib.getDocument(url).promise;
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const viewport = page.getViewport({ scale: 1.4 }); // lighter = much faster on tablets
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width; canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        const img = canvas.toDataURL("image/jpeg", 0.85);
        setPdfPages(prev => [...prev, img]); // show each page as soon as it's ready
      }
    } catch(e) { console.error("pdf render", e); }
    setPdfRendering(false);
  };

  const addPile=()=>{
    const np = inheritedPile(piles[piles.length-1]);
    setPiles(p=>[...p, np]);
    setShowProject(false);
    setOpenPileId(np.id); // jump straight into the new pile's page
  };
  const removePile=(id)=>{
    const p = piles.find(x=>x.id===id);
    const label = p?.pileNo ? `Pile No. ${p.pileNo}` : "this pile";
    const hasData = p && (p.drillStart || (p.feet&&p.feet.length));
    if (!window.confirm(`Delete ${label}${hasData?" and its ENTIRE log":""}? This cannot be undone.`)) return;
    setPiles(pl=>pl.filter(x=>x.id!==id));
    if (openPileId === id) setOpenPileId(null); // back out to the list if the open pile was deleted
  };
  const updatePile=(id,u)=>setPiles(p=>p.map(x=>x.id===id?u:x));

  // Build the requested filename format: YYYY-MM-DD-ACIP/RI-ProjectName-Initials
  const buildPdfFilename = (suffix) => {
    // Date → YYYY-MM-DD regardless of how activeDay.date is stored
    let datePart = activeDay.date;
    const parsed = new Date(activeDay.date);
    if (!isNaN(parsed)) {
      const y = parsed.getFullYear(), m = String(parsed.getMonth()+1).padStart(2,"0"), d = String(parsed.getDate()).padStart(2,"0");
      datePart = `${y}-${m}-${d}`;
    } else {
      datePart = String(activeDay.date).replace(/\//g,"-");
    }
    // Kind — RI only if every pile that day is RI; otherwise default ACIP
    const kindPart = piles.length && piles.every(p => p.pileKind === "RI") ? "RI" : "ACIP";
    // Project name → strip to letters/numbers/spaces, collapse spaces to nothing (CamelCase-ish token)
    const projName = (project.projectName || "Project").trim();
    const namePart = projName.replace(/[^a-zA-Z0-9 ]/g,"").split(/\s+/).join("") || "Project";
    // Inspector initials from full name
    const initials = (project.inspector || "").trim().split(/\s+/).filter(Boolean).map(w=>w[0].toUpperCase()).join("") || "XX";
    return `${datePart}-${kindPart}-${namePart}-${initials}${suffix}.pdf`;
  };

  const [pdfName, setPdfName] = useState("");
  const handlePDF=async()=>{
    setGenerating(true);
    try{
      const url = await generatePDF(projectForPdf,piles);
      setPdfName(buildPdfFilename(""));
      setPdfUrl(url);
      setPdfPages([]);
      renderPdfPages(url); // async; images appear as they render
    }
    catch(e){alert("PDF error: "+e.message);}
    finally{setGenerating(false);}
  };
  const handleSummary=async()=>{
    setGenerating(true);
    try{
      const url = await generateSummaryPDF(projectForPdf,piles);
      setPdfName(buildPdfFilename("-Summary"));
      setPdfUrl(url);
      setPdfPages([]);
      renderPdfPages(url);
    }
    catch(e){alert("PDF error: "+e.message);}
    finally{setGenerating(false);}
  };

  return (
    <div style={{minHeight:"100vh",background:"#0d2236",fontFamily:"'Segoe UI',Arial,sans-serif",filter:sunMode?"invert(1) hue-rotate(180deg) contrast(1.05)":"none"}}>
      <div style={{background:"#071520",padding:"0 14px",display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:100,boxShadow:"0 2px 10px rgba(0,0,0,0.6)"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,padding:"11px 0"}}>
          <span style={{color:"#fff",fontWeight:900,fontSize:17,letterSpacing:1}}>LANGAN</span>
          <span style={{color:"#4a7fa5",fontSize:11}}>ACIP Log</span>
        </div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={()=>setSunMode(s=>!s)} style={{padding:"7px 11px",borderRadius:7,border:"1px solid #2d4a5c",cursor:"pointer",background:sunMode?"#ffd700":"transparent",color:sunMode?"#333":"#a8c0d9",fontSize:12,fontWeight:700}}>{sunMode?"🌙":"☀️"}</button>
          <button onClick={()=>setShowProject(s=>!s)} style={{padding:"7px 11px",borderRadius:7,border:"1px solid #2d4a5c",cursor:"pointer",background:"transparent",color:"#a8c0d9",fontSize:12}}>📋 Project</button>
          <button onClick={handleSummary} disabled={generating} style={{padding:"7px 11px",borderRadius:7,border:"1px solid #e67e22",cursor:"pointer",background:"transparent",color:"#e6a35c",fontWeight:700,fontSize:12}}>
            {generating?"…":"📑 Summary"}
          </button>
          <button onClick={handlePDF} disabled={generating} style={{padding:"7px 11px",borderRadius:7,border:"none",cursor:"pointer",background:generating?"#444":"#e67e22",color:"#fff",fontWeight:700,fontSize:12}}>
            {generating?"…":"📄 PDF"}
          </button>
          <button onClick={()=>setShowAppSettings(true)} style={{padding:"7px 11px",borderRadius:7,border:"1px solid #2d4a5c",cursor:"pointer",background:"transparent",color:"#a8c0d9",fontSize:12}}>⚙️ Settings</button>
        </div>
      </div>

      {showAppSettings && (
        <div style={{ position:"fixed", top:0, left:0, width:"100vw", height:"100dvh", background:"rgba(0,0,0,0.8)", zIndex:300, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }} onClick={()=>setShowAppSettings(false)}>
          <div style={{ background:"#132536", borderRadius:18, padding:22, maxWidth:340, width:"100%" }} onClick={e=>e.stopPropagation()}>
            <div style={{ color:"#fff", fontWeight:900, fontSize:17, marginBottom:16 }}>⚙️ App Settings</div>
            <div style={{ color:"#a8c0d9", fontSize:12, fontWeight:700, marginBottom:6 }}>Data backup</div>
            <button onClick={handleExport} style={{width:"100%",padding:"12px 6px",borderRadius:10,border:"1px solid #4a7fa5",background:"transparent",color:"#4a7fa5",fontWeight:700,fontSize:13,cursor:"pointer",marginBottom:8}}>💾 Export all data to file</button>
            <button onClick={handleImport} style={{width:"100%",padding:"12px 6px",borderRadius:10,border:"1px solid #2ecc71",background:"transparent",color:"#2ecc71",fontWeight:700,fontSize:13,cursor:"pointer",marginBottom:20}}>📂 Import from backup file</button>
            <button onClick={()=>setShowAppSettings(false)} style={{ width:"100%", padding:13, borderRadius:10, border:"none", background:"#27ae60", color:"#fff", fontSize:15, fontWeight:800, cursor:"pointer" }}>Done</button>
          </div>
        </div>
      )}

      <div style={{maxWidth:680,margin:"0 auto",padding:"12px 10px 60px"}}>
        {/* ── Project switcher ── */}
        <div style={{display:"flex",gap:8,overflowX:"auto",paddingBottom:10,alignItems:"center"}}>
          {store.projects.map(e=>(
            <div key={e.id} onClick={()=>switchProject(e.id)} style={{
              display:"flex",alignItems:"center",gap:6,padding:"8px 12px",borderRadius:10,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0,
              background: e.id===active.id?"#2d6a9f":"#132536",
              border: e.id===active.id?"2px solid #4fc3f7":"1px solid #1a3a5c"
            }}>
              <span style={{color:e.id===active.id?"#fff":"#a8c0d9",fontWeight:e.id===active.id?800:400,fontSize:13}}>
                📁 {e.project.projectName||"Untitled project"}
              </span>
              <span style={{color:"#4a7fa5",fontSize:11}}>{(e.days||[]).reduce((n,d)=>n+d.piles.length,0)}</span>
              {store.projects.length>1 && e.id===active.id && (
                <button onClick={ev=>{ev.stopPropagation();deleteProject(e.id);}} style={{background:"none",border:"none",color:"#c0392b",cursor:"pointer",fontSize:12,padding:0}}>✕</button>
              )}
            </div>
          ))}
          <button onClick={addProject} style={{padding:"8px 12px",borderRadius:10,border:"1px dashed #2d6a9f",background:"transparent",color:"#4a7fa5",fontSize:13,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0}}>
            + New Project
          </button>
        </div>

        {/* ── Day switcher (within active project) ── */}
        <div style={{display:"flex",gap:8,overflowX:"auto",paddingBottom:10,alignItems:"center"}}>
          {active.days.map(d=>(
            <div key={d.id} onClick={()=>switchDay(d.id)} style={{
              display:"flex",alignItems:"center",gap:6,padding:"7px 11px",borderRadius:10,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0,
              background: d.id===activeDay.id?"#1a5c2e":"#132536",
              border: d.id===activeDay.id?"2px solid #2ecc71":"1px solid #1a3a5c"
            }}>
              <span style={{color:d.id===activeDay.id?"#fff":"#a8c0d9",fontWeight:d.id===activeDay.id?800:400,fontSize:12}}>
                📅 {d.date}
              </span>
              <span style={{color:"#4a7fa5",fontSize:11}}>{d.piles.length}</span>
              {active.days.length>1 && d.id===activeDay.id && (
                <button onClick={ev=>{ev.stopPropagation();deleteDay(d.id);}} style={{background:"none",border:"none",color:"#c0392b",cursor:"pointer",fontSize:12,padding:0}}>✕</button>
              )}
            </div>
          ))}
          <button onClick={addDay} style={{padding:"7px 11px",borderRadius:10,border:"1px dashed #2ecc71",background:"transparent",color:"#5fae7e",fontSize:12,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0}}>
            + New Day
          </button>
        </div>

        {showProject&&<ProjectForm project={project} onChange={setProject}/>}
        {openPileId ? (
          <PileDetailPage
            piles={piles}
            pileId={openPileId}
            onUpdate={u=>updatePile(openPileId,u)}
            onRemove={removePile}
            onBack={()=>setOpenPileId(null)}
            onNavigate={setOpenPileId}
          />
        ) : (
          <PileListPage
            piles={piles}
            project={project}
            onOpen={setOpenPileId}
            onAdd={addPile}
            onRemove={piles.length>1?removePile:null}
          />
        )}
      </div>

      {/* ── PDF Viewer Modal ── */}
      {pdfUrl && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",zIndex:500,display:"flex",flexDirection:"column"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 16px",background:"#071520",flexShrink:0}}>
            <span style={{color:"#fff",fontWeight:800,fontSize:15}}>📄 Inspection Log PDF</span>
            <div style={{display:"flex",gap:10}}>
              <a href={pdfUrl} download={pdfName||"Langan_ACIP.pdf"}
                style={{padding:"8px 14px",borderRadius:8,background:"#27ae60",color:"#fff",fontWeight:700,fontSize:13,textDecoration:"none"}}>
                ⬇ Download
              </a>
              <button onClick={()=>{URL.revokeObjectURL(pdfUrl);setPdfUrl(null);setPdfPages([]);}} style={{padding:"8px 14px",borderRadius:8,border:"none",background:"#922b21",color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer"}}>
                ✕ Close
              </button>
            </div>
          </div>
          <div style={{flex:1,overflowY:"auto",background:"#333",padding:"10px 6px"}}>
            {pdfRendering && pdfPages.length===0 && (
              <div style={{color:"#aaa",textAlign:"center",padding:40,fontSize:15}}>Rendering preview…</div>
            )}
            {pdfPages.map((src,i)=>(
              <img key={i} src={src} alt={`Page ${i+1}`} style={{width:"100%",display:"block",marginBottom:10,borderRadius:4,boxShadow:"0 2px 12px rgba(0,0,0,0.5)"}}/>
            ))}
            {!pdfRendering && pdfPages.length===0 && (
              <iframe src={pdfUrl} style={{border:"none",width:"100%",height:"100%",minHeight:500,filter:sunMode?"invert(1) hue-rotate(180deg)":"none"}} title="PDF Preview"/>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
