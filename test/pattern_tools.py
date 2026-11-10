"""ProwdCAD 2.1 pattern-making tools — geometry checks in headless Chromium.
Each check compares against a value worked out by hand. Run: python3 test/pattern_tools.py"""
import os, pathlib, math
from playwright.sync_api import sync_playwright
HTML = pathlib.Path(__file__).resolve().parent.parent / "prowdcad.html"
OUT = HTML.parent / "test" / "out"; OUT.mkdir(exist_ok=True)
results = []
def check(name, ok, info=""):
    results.append(ok); print(("PASS " if ok else "FAIL ") + name + (f"  [{info}]" if info else ""))

SETUP = r"""(kind)=>{const W=WP;W.S.patterns.length=0;const p=W.newPattern("T","M");
  const pc=W.newPiece("REC");
  if(kind==="rect")pc.points=[W.newPoint(0,0),W.newPoint(300,0),W.newPoint(300,1000),W.newPoint(0,1000)];
  if(kind==="leg")pc.points=[W.newPoint(0,0),W.newPoint(300,0),W.newPoint(260,1000),W.newPoint(40,1000)];
  if(kind==="ellipse"){W.S.shapeKind="ellipse";}
  pc.seam=0;pc.grain={x1:150,y1:100,x2:150,y2:900};p.pieces=[pc];W.S.patterns.push(p);W.S.activePatternId=p.id;W.S.sel.piece=pc.id;W.fitView("design");W.render();return true;}"""
AREA = "()=>WP.activePattern().pieces.map(pc=>Math.abs(WP.polyArea(WP.samplePiece(pc))))"

with sync_playwright() as pw:
    b = pw.chromium.launch(); pg = b.new_page(viewport={"width": 1500, "height": 900}); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(HTML.as_uri()); pg.wait_for_timeout(400)
    ev = pg.evaluate

    # 1 Draft by mouse (4 clicks + click start) and Tab exact entry
    ev(SETUP, "rect"); ev("()=>{WP.S.patterns[0].pieces=[];WP.S.vb.design={x:-100,y:-100,w:1500,h:900};WP.setTool('draft');WP.render();}")
    t = ev("()=>{const r=document.querySelector('#svg').getBoundingClientRect(),V=WP.S.vb.design;return {x:r.left,y:r.top,w:r.width,h:r.height,vx:V.x,vy:V.y,vw:V.w,vh:V.h};}")
    S = lambda x, y: (t["x"] + (x - t["vx"]) / t["vw"] * t["w"], t["y"] + (y - t["vy"]) / t["vh"] * t["h"])
    for (x, y) in [(300, 100), (700, 100), (700, 700)]:
        pg.mouse.click(*S(x, y)); pg.wait_for_timeout(500)
    pg.keyboard.press("Tab"); pg.fill("#dx-a", str(400 / 25.4 if ev("()=>WP.S.units") == "inch" else 40)); pg.fill("#dx-b", "180"); pg.click("#dialog footer .primary")
    pg.wait_for_timeout(500); pg.mouse.click(*S(300, 100)); pg.wait_for_timeout(200)
    pcs = ev("()=>WP.activePattern().pieces.map(pc=>[pc.points.length,Math.round(Math.abs(WP.polyArea(WP.samplePiece(pc))))])")
    check("Draft: new piece by clicks + Tab exact length/angle", pcs == [[4, 240000]], pcs)

    # 2 Seam per segment + mirror hem corner
    ev(SETUP, "leg")
    r = ev("""()=>{const pc=WP.activePattern().pieces[0];pc.seam=10;pc.seamSeg={[pc.points[2].id]:25.4};
      const miter=WP.seamPolygon(pc);pc.corner={[pc.points[2].id]:"mirrorNext",[pc.points[3].id]:"mirrorPrev"};const mir=WP.seamPolygon(pc);
      const bb=WP.polyBBox(miter);return {ymax:bb.y2,ymin:bb.y1,onFold:mir.filter(q=>Math.abs(q.y-1000)<0.01).length,n1:miter.length,n2:mir.length,
        foot:mir.filter(q=>q.y>1000.5).map(q=>[+q.x.toFixed(2),+q.y.toFixed(2)])}}""")
    check("Seam: hem 1\" + sides 10mm (cut line reaches y=1025.4)", abs(r["ymax"] - 1025.4) < 0.01 and abs(r["ymin"] + 10) < 0.01, r)
    # mirror: side seam reflected across hem line → at hem cut line the x must equal reflection of the slanted seam line
    # right side seam line offset: from (300,0)->(260,1000), outward normal; reflect across y=1000, evaluate at y=1025.4
    ex, ey = -40, 1000; l = math.hypot(ex, ey); nx, ny = ey / l, -ex / l   # outward (right) normal for this winding
    ax, ay = 300 + nx * 10, 0 + ny * 10
    s_q = (1000 - ay) / ey; qx = ax + ex * s_q                       # where offset side seam hits the fold line
    rx = qx + (-ex) * (25.4 / ey)                                     # reflected line slope: dx/dy = -ex/ey
    got = [p for p in r["foot"] if p[0] > 150]
    check("Seam: mirror corner reflects side seam across hem fold", got and abs(got[0][0] - rx) < 0.05 and r["onFold"] >= 2, f"expect x={rx:.2f} got {got}")

    # 3 Notch types
    r = ev("""()=>{const pc=WP.activePattern().pieces[0];const out={};for(const t of ["slit","v","t","castle"])out[t]=WP.notchGeom(pc,{seg:0,t:.5,type:t},1).length;return out;}""")
    check("Notch types slit/V/T/castle", r == {"slit": 1, "v": 2, "t": 2, "castle": 3}, r)

    # 4 Add point keeps a bézier curve exactly
    ev(SETUP, "rect")
    r = ev("""()=>{const p=WP.activePattern();WP.S.shapeKind="ellipse";WP.commitShape({start:{x:0,y:0},cur:{x:400,y:200},square:false});
      const pc=p.pieces[p.pieces.length-1];const a0=Math.abs(WP.polyArea(WP.samplePiece(pc)));const n0=pc.points.length;
      WP.insertPointExact(pc,1,0.37,true);WP.insertPointExact(pc,3,0.5,true);const a1=Math.abs(WP.polyArea(WP.samplePiece(pc)));return {n0,n1:pc.points.length,rel:Math.abs(a1-a0)/a0};}""")
    check("Add Point: bézier split keeps the curve", r["n1"] == r["n0"] + 2 and r["rel"] < 0.002, r)

    # 5 Segment length — all TUKA methods hit the target
    out = {}
    for m in ["1-H", "2-H", "1-V", "2-V", "1-D", "2-D"]:
        ev(SETUP, "rect")
        out[m] = ev(f"""()=>{{const pc=WP.activePattern().pieces[0];const run=WP.runFromSeg(pc,{1 if 'V' in m else 0});
          const ok=WP.setRunLength(pc,run,{1100 if 'V' in m else 330},"{m}");return [ok,+WP.runLength(pc,run).toFixed(3)];}}""")
    ev(SETUP, "rect")
    out["curve"] = ev("""()=>{const p=WP.activePattern();WP.S.shapeKind="ellipse";WP.commitShape({start:{x:0,y:0},cur:{x:400,y:200},square:false});
      const pc=p.pieces[p.pieces.length-1];const run=WP.runFromSeg(pc,0);const L0=WP.runLength(pc,run);const ok=WP.setRunLength(pc,run,L0*1.05,"curve");return [ok,+(WP.runLength(pc,run)/L0).toFixed(4)];}""")
    check("Segment Length: 1/2-H, 1/2-V, 1/2-D, Curve", all(v[0] for v in out.values()) and all(abs(v[1] - (1100 if "V" in k else 330)) < 0.01 for k, v in out.items() if k != "curve") and abs(out["curve"][1] - 1.05) < 0.001, out)

    # 6 Cut piece: areas add up; 7 Join back
    ev(SETUP, "rect")
    ev("""()=>{const pc=WP.activePattern().pieces[0];pc.seam=10;pc.notches=[{seg:0,t:.25},{seg:2,t:.25}];pc.internals=[{x1:50,y1:500,x2:80,y2:500,kind:"drill"},{x1:250,y1:200,x2:260,y2:200}];
      WP.S.op={kind:"cut",piece:pc,a:{x:150,y:0},cur:{x:0,y:0}};
      const hit={x:150,y:1000};WP.cutClick(hit);}""")
    r = ev("()=>({areas:WP.activePattern().pieces.map(pc=>Math.round(Math.abs(WP.polyArea(WP.samplePiece(pc))))),notches:WP.activePattern().pieces.map(pc=>pc.notches.length),ints:WP.activePattern().pieces.map(pc=>pc.internals.length)})")
    check("Cut: rectangle split in two, areas 150000+150000, notches & internals kept", sorted(r["areas"]) == [150000, 150000] and sum(r["notches"]) == 2 and sum(r["ints"]) == 2, r)
    ev("()=>WP.undo()"); n_after_undo = ev("()=>WP.activePattern().pieces.length")
    check("Undo restores the uncut piece", n_after_undo == 1, n_after_undo); ev("()=>WP.redo()")
    r = ev("""()=>{const p=WP.activePattern();const [A,B]=p.pieces;
      const iA=A.points.findIndex(q=>Math.abs(q.x-150)<0.01&&Math.abs(q.y)<0.01);const runA=WP.runFromSeg(A,(A.points.length+iA-1)%A.points.length);
      const midA=WP.pointOnSegment(A,runA.segs[0],0.5);
      const iB=B.points.findIndex(q=>Math.abs(q.x-150)<0.01&&Math.abs(q.y-1000)<0.01);const midB=WP.pointOnSegment(B,WP.runFromSeg(B,iB).segs[0],0.5);
      // move B away + rotate it, then join
      WP.S.sel.piece=B.id;WP.rotatePieces(90);
      const bb=WP.polyBBox(WP.samplePiece(B));const mB=WP.nearestOnPiece(B,{x:(bb.x1+bb.x2)/2,y:(bb.y1+bb.y2)/2});
      WP.S.op=null;const cA=WP.pointOnSegment(A,runA.segs[0],0.5);
      // pick the cut edge on A (x=150) and the cut edge on B
      const edgeA=A.points.map((q,i)=>i).find(i=>{const m=WP.pointOnSegment(A,i,.5);return Math.abs(m.x-150)<0.01;});
      WP.joinClick(WP.pointOnSegment(A,edgeA,.5));
      const edgeB=B.points.map((q,i)=>i).find(i=>{const a=B.points[i],c=B.points[(i+1)%B.points.length];return Math.hypot(c.x-a.x,c.y-a.y)>999&&WP.S.patterns&&true&&(()=>{const m=WP.pointOnSegment(B,i,.5);return !WP.pointInPolyCheck;})();});
      // B's cut edge is the 1000-long edge whose midpoint is nearest the old shared line (after rotation): choose by seam id key
      let best=null,bd=1e9;B.points.forEach((q,i)=>{const nq=B.points[(i+1)%B.points.length];if(Math.hypot(nq.x-q.x,nq.y-q.y)<999)return;const m=WP.pointOnSegment(B,i,.5);const d=(B.seamSeg[q.id]!=null&&B.seamSeg[q.id]===10?0:0);if(best==null||i===best){};});
      return {edgeA};}""")
    # simpler: join using the edge ids we can reason about — B's edge whose start point is B.points[last]
    r = ev("""()=>{const p=WP.activePattern();const [A,B]=p.pieces;const k=B.points.length-1;
      WP.joinClick(WP.pointOnSegment(B,k,.5));
      const J=p.pieces[0];return {pieces:p.pieces.length,area:Math.round(Math.abs(WP.polyArea(WP.samplePiece(J)))),pts:J.points.length,notches:J.notches.length,ints:J.internals.length,name:J.name};}""")
    check("Join: rotated half re-joined, area 300000, notches & internals kept", r["pieces"] == 1 and abs(r["area"] - 300000) <= 2 and r["notches"] == 2 and r["ints"] == 2, r)

    # 8 Fullness: parallel spread 25.4 and pivot spread
    ev(SETUP, "rect")
    r = ev("""()=>{const pc=WP.activePattern().pieces[0];const a0=Math.abs(WP.polyArea(WP.samplePiece(pc)));
      WP.spreadPiece(pc,{x:150,y:0},{x:150,y:1000},25.4,25.4,2);const a1=Math.abs(WP.polyArea(WP.samplePiece(pc)));
      const bb=WP.polyBBox(WP.samplePiece(pc));return {gain:+(a1-a0).toFixed(2),w:+bb.w.toFixed(2),pts:pc.points.length};}""")
    check("Fullness: parallel spread 1\" adds 25.4 × 1000 mm²", abs(r["gain"] - 25400) < 1 and abs(r["w"] - 325.4) < 0.01, r)
    ev(SETUP, "rect")
    r = ev("""()=>{const pc=WP.activePattern().pieces[0];WP.spreadPiece(pc,{x:150,y:0},{x:150,y:1000},0,50,2);
      const pts=WP.samplePiece(pc);const bot=pts.filter(q=>Math.abs(q.y-1000)<5||q.y>990);const top=pc.points.filter(q=>Math.abs(q.y)<0.5).length;
      const bb=WP.polyBBox(pts);return {hemWidth:+bb.w.toFixed(2),topPts:top};}""")
    check("Fullness: pivot at top, 50 mm opening at hem (flare)", r["hemWidth"] > 349 and r["hemWidth"] < 352, r)

    # 9 Dart with cap
    ev(SETUP, "rect")
    r = ev("""()=>{const pc=WP.activePattern().pieces[0];const n0=pc.points.length;const top0=WP.runLength(pc,WP.runFromSeg(pc,0));
      WP.createDart(pc,{x:150,y:0,seg:0,t:.5},{x:150,y:120},25.4,1,12.7);
      const cap=pc.points.find(q=>Math.abs(q.x-150)<1&&q.y<0);const legs=pc.points.filter(q=>Math.abs(q.y)<0.01&&Math.abs(Math.abs(q.x-150)-12.7)<0.05).length;
      return {added:pc.points.length-n0,capY:cap?+cap.y.toFixed(3):null,legs,dartLines:pc.internals.filter(i=>i.name==="dart").length,drills:pc.internals.filter(i=>i.kind==="drill").length,notches:pc.notches.length};}""")
    check("Dart: legs at ±12.7, cap above edge, 2 leg lines + drill + 2 notches", r["added"] == 3 and r["legs"] == 2 and r["capY"] is not None and r["capY"] < 0 and r["dartLines"] == 2 and r["drills"] == 1 and r["notches"] == 2, r)

    # 10 Round corner: area loss r²(1−π/4)
    ev(SETUP, "rect")
    r = ev("()=>{const pc=WP.activePattern().pieces[0];const a0=Math.abs(WP.polyArea(WP.samplePiece(pc)));WP.roundCorner(pc,1,40);return a0-Math.abs(WP.polyArea(WP.samplePiece(pc)));}")
    expect = 40 * 40 * (1 - math.pi / 4)
    check("Round corner r=40: area loss = r²(1−π/4)", abs(r - expect) / expect < 0.02, f"{r:.1f} vs {expect:.1f}")

    # 11 Compare length rows
    ev(SETUP, "rect")
    r = ev("""()=>{const pc=WP.activePattern().pieces[0];WP.S.compare=[{pc:pc.id,a:pc.points[0].id,sign:1},{pc:pc.id,a:pc.points[1].id,sign:-1}];
      const rows=WP.compareRows();return rows.map(x=>Math.round(x.len)*x.c.sign);}""")
    check("Compare length: +300 −1000", r == [300, -1000], r)

    # 12 Exports: DXF has cut (1), sew (14), notch (4), drill (13)
    ev(SETUP, "rect")
    dxf = ev("""()=>{const pc=WP.activePattern().pieces[0];pc.seam=10;pc.notches=[{seg:0,t:.5}];pc.internals=[{x1:150,y1:500,x2:150,y2:500,kind:"drill"}];
      let out="";const d=window.download;window.download=(n,c)=>{out=c};document.querySelector('#svg');
      try{WP.exportDXF?WP.exportDXF("aama"):null;}catch(e){}window.download=d;return out;}""")
    if not dxf:
        dxf = ev("""()=>{let out="";const d=window.download;window.download=(n,c)=>{out=c};exportDXF("aama");window.download=d;return out;}""")
    lay = lambda L: f"\r\n8\r\n{L}\r\n" in dxf
    check("DXF AAMA: layers 1 cut, 14 sew, 4 notch, 13 drill", all(lay(L) for L in ["1", "14", "4", "13"]), [L for L in ["1", "14", "4", "13"] if lay(L)])

    # screenshot with tools visible
    ev(SETUP, "leg")
    ev("""()=>{const pc=WP.activePattern().pieces[0];pc.seam=9.525;pc.seamSeg={[pc.points[2].id]:25.4};pc.corner={[pc.points[2].id]:"mirrorNext",[pc.points[3].id]:"mirrorPrev"};
      pc.notches=[{seg:1,t:.3,type:"v"},{seg:3,t:.3,type:"castle"},{seg:0,t:.5}];WP.createDart(pc,{x:150,y:0,seg:0,t:.5},{x:150,y:110},20,1,12.7);
      WP.S.view.measurements=false;WP.fitView("design");WP.setTool("seam");WP.render();}""")
    pg.screenshot(path=str(OUT / "10_pattern_tools.png"))
    check("No page errors", not errs, errs)
    print(f"\n{sum(results)}/{len(results)} passed")
    b.close()
