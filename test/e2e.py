"""ProwdCAD PRO end-to-end test (headless Chromium via Playwright).
Builds a jeans-style pattern, names measurements, imports an order Excel,
auto-alters, shrinks, nests and exports. Run:  python3 test/e2e.py [order.xlsx]"""
import sys, os, json, pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
HTML = ROOT / "prowdcad.html"
OUT = ROOT / "test" / "out"; OUT.mkdir(exist_ok=True)
XLSX = sys.argv[1] if len(sys.argv) > 1 else None

BUILD = r"""
() => {
  const W=window.WP, S=W.S;
  const p=W.newPattern("JEANS BASE","32");
  const IN=25.4;
  // simplified front leg: waist 10", hip 10.5", thigh 12", knee 8.5", hem 7", inseam 29", rise 11
  function leg(name, ox, wTop, wHip, wThigh, wKnee, wHem, inseam, rise, mult){
    const pc=W.newPiece(name); pc.seam=10; pc.qty=1; pc.oppositeX=true; pc.rotationAllow=true;
    const y0=0, yHip=4*IN, yCr=rise*IN, yKnee=yCr+(inseam*IN)*0.45, yHem=yCr+inseam*IN;
    const P=(x,y,c,nm)=>{const q=W.newPoint(ox+x,y,c); if(nm)q.name=nm; return q;};
    pc.points=[
      P(0,y0,false,"01 High Waist/m/q"+mult),          // 0 waist left (side seam top)
      P(wTop*IN,y0,false),                               // 1 waist right (CF/CB top)
      P(wTop*IN+0.3*IN,yHip,true),                       // 2 hip curve
      P(wHip*IN+1.5*IN,yCr,false),                       // 3 crotch point
      P(wThigh*IN,yCr+1.2*IN,false,"04 Upper thigh/m/q"+mult), // 4 inside thigh  (thigh line)
      P(wKnee*IN*0.95,yKnee,false,"06 Knee/m/q"+mult),   // 5 inseam knee
      P(wHem*IN,yHem,false,"07 Ankle/m/q"+mult),         // 6 hem inside
      P(0,yHem,false,"08 Inseam/m/q1"),                  // 7 hem outside  → contour to next grade pt = outseam.. (named for test)
      P(-0.3*IN,yKnee,false),                            // 8 outseam knee
      P(0.2*IN,yCr+1.2*IN,false),                        // 9 outseam thigh
      P(-0.2*IN,yHip,true),                              // 10 hip curve out
    ];
    pc.grain={x1:ox+3*IN,y1:yHip,x2:ox+3*IN,y2:yHem-2*IN};
    return pc;
  }
  const F=leg("FRONT",0, 9.2,10.2,11.2,8.2,6.8,29,11.05,2);
  const B=leg("BACK",14*IN, 10.0,11.3,13.6,8.8,7.2,29,14.5,2);
  F.points[7].name="";B.points[7].name="";F.points[4].name=B.points[4].name="";F.points[5].name=B.points[5].name="";F.points[6].name=B.points[6].name="";
  p.pieces=[F,B];
  // girths as straight lines across each panel (×2 for left/right), lengths along the contour
  const girth=(name,i,j)=>({id:name,name,parts:[F,B].map(pc=>({type:"line",a:{pc:pc.id,id:pc.points[i].id},b:{pc:pc.id,id:pc.points[j].id},q:2}))});
  p.poms=[girth("03 Hip",10,2),girth("04 Upper thigh",9,4),girth("06 Knee",8,5),girth("07 Ankle",7,6),
   {id:"ins",name:"08 Inseam",parts:[{type:"contour",dir:1,a:{pc:F.id,id:F.points[3].id},b:{pc:F.id,id:F.points[6].id},q:1}]},
   {id:"fr",name:"Front Rise",parts:[{type:"contour",dir:1,a:{pc:F.id,id:F.points[1].id},b:{pc:F.id,id:F.points[3].id},q:1}]}];
  const addM=(name)=>{const m={id:"m_"+name,name,base:0};p.measurements.push(m);return m;};
  const mHip=addM("03 Hip"), mKnee=addM("06 Knee"), mAnk=addM("07 Ankle"), mIns=addM("08 Inseam"), mThigh=addM("04 Upper thigh"), mFR=addM("Front Rise"), mW=addM("01 High Waist");
  const rule=(pt,m,dx,dy)=>{pt.grade=pt.grade||{};pt.grade[m.id]={dx,dy};};
  for(const pc of [F,B]){
    rule(pc.points[1],mW,0.25,0); rule(pc.points[2],mHip,0.25,0); rule(pc.points[3],mHip,0.25,0);
    rule(pc.points[4],mThigh,0.25,0); rule(pc.points[3],mThigh,0.25,0); rule(pc.points[5],mKnee,0.25,0); rule(pc.points[6],mAnk,0.25,0);
    rule(pc.points[6],mIns,0,1); rule(pc.points[7],mIns,0,1); rule(pc.points[5],mIns,0,0.45); rule(pc.points[8],mIns,0,0.45);
  }
  rule(F.points[1],mFR,0,-1); rule(F.points[0],mFR,0,-1); rule(F.points[10],mFR,0,-0.6);
  S.patterns.push(p); S.activePatternId=p.id; W.fitView("design"); W.render();
  const rows=W.measureRows(p); const base={}; rows.forEach(r=>base[r.key]=r.value);
  // set the parameter base values = current measured values
  p.measurements.forEach(m=>{const r=rows.find(x=>x.key===W.normMeas(m.name)); if(r)m.base=r.value;});
  return rows.map(r=>[r.name,+(r.value/25.4).toFixed(3)]);
}
"""

with sync_playwright() as pw:
    b = pw.chromium.launch(); pg = b.new_page(viewport={"width":1500,"height":900})
    errors=[]; pg.on("pageerror", lambda e: errors.append(str(e))); pg.on("console", lambda m: errors.append("console."+m.type+": "+m.text) if m.type=="error" else None)
    LIBS=os.environ.get("PROWD_LIBS")
    if LIBS:  # sandbox without CDN access: serve the same versions from a local npm install
        pg.route("**/jspdf.umd.min.js", lambda r: r.fulfill(path=os.path.join(LIBS,"jspdf/dist/jspdf.umd.min.js"), content_type="application/javascript"))
        pg.route("**/xlsx.full.min.js", lambda r: r.fulfill(path=os.path.join(LIBS,"xlsx/dist/xlsx.full.min.js"), content_type="application/javascript"))
    pg.goto(HTML.as_uri()); pg.wait_for_timeout(600)
    rows = pg.evaluate(BUILD)
    print("chart rows:", rows)
    pg.screenshot(path=str(OUT/"01_pattern.png"))

    # Measurement chart dialog
    pg.evaluate("()=>WP.showMeasurementChart()"); pg.wait_for_timeout(200)
    pg.screenshot(path=str(OUT/"02_chart.png")); pg.evaluate("()=>document.querySelector('#overlay').classList.remove('show')")

    # undo/redo on a point move
    before = pg.evaluate("()=>WP.activePattern().pieces[0].points[6].x")
    pg.evaluate("()=>{const p=WP.activePattern();WP.movePointsBy(p,{pts:[{pc:p.pieces[0].id,i:6}],ints:[]},25.4,0);WP.render();}")
    pg.evaluate("()=>WP.undo()"); after_undo = pg.evaluate("()=>WP.activePattern().pieces[0].points[6].x")
    pg.evaluate("()=>WP.redo()"); after_redo = pg.evaluate("()=>WP.activePattern().pieces[0].points[6].x")
    print("undo ok:", abs(after_undo-before)<1e-6, "redo ok:", abs(after_redo-before-25.4)<1e-6)
    pg.evaluate("()=>WP.undo()")

    # order excel
    if XLSX:
        pg.evaluate("()=>{window.__o=null;}")
        pg.set_input_files("#fileinput", XLSX)
        # trigger the change handler path used by openFile: call importOrderFile directly
        pg.evaluate("()=>{const f=document.querySelector('#fileinput').files[0]; const rd=new FileReader(); rd.onload=()=>{const wb=XLSX.read(rd.result,{type:'array'}); window.__o=WP.parseOrderWorkbook(wb); window.__o.file=f.name;}; rd.readAsArrayBuffer(f);}")
        pg.wait_for_timeout(800)
        o = pg.evaluate("()=>window.__o")
        print("order:", o["title"], "|", o["name"], "| rows", [(r["label"],r["target"]) for r in o["rows"]], "| warp", o["warp"], "weft", o["weft"], "fabric", o["fabricWidth"])
        # apply targets + alter
        rep = pg.evaluate("""()=>{const p=WP.activePattern();const o=window.__o;const T=WP.targetsOf(p);p.tolerance=0.3*25.4;
          for(const r of o.rows){T[r.key]={target:r.target*25.4,label:r.label,tol:0.3*25.4};}
          p.order={number:o.number,name:o.name,warp:o.warp,weft:o.weft,fabricWidth:o.fabricWidth*25.4,units:'inch',baseName:(o.number+'_'+(o.name||'').replace(/\\s+/g,''))};
          const res=WP.alterToTargets(p);return res.report.map(x=>({name:x.name,start:+(x.start/25.4).toFixed(3),target:+(x.target/25.4).toFixed(3),result:+(x.result/25.4).toFixed(3),ok:x.ok,prog:x.programmed}));}""")
        for r in rep: print("  ", r)
        pg.evaluate("()=>WP.runAutoAlter(WP.activePattern())"); pg.wait_for_timeout(200)
        pg.screenshot(path=str(OUT/"03_alter_report.png")); pg.evaluate("()=>document.querySelector('#overlay').classList.remove('show')")
        # full chain from the base
        pg.evaluate("()=>{WP.S.activePatternId=WP.S.patterns[0].id;WP.render();WP.runOrderChain();}"); pg.wait_for_timeout(300)
        st = pg.evaluate("()=>({patterns:WP.S.patterns.map(p=>p.name),marker:WP.S.marker.placements.length,len:WP.markerLength()/25.4,util:WP.markerUtilization(),fw:WP.S.marker.fabricWidth/25.4})")
        print("chain:", st)
        pg.screenshot(path=str(OUT/"04_marker.png"))
        # shrink check: postshrink vs preshrink inseam
        chk = pg.evaluate("""()=>{const pre=WP.S.patterns.find(p=>/Preshrink/.test(p.name)),post=WP.S.patterns.find(p=>/Postshrink/.test(p.name));
          const bb=pc=>WP.polyBBox(WP.samplePiece(pc));const a=bb(pre.pieces[0]),b=bb(post.pieces[0]);
          return {heightRatio:b.h/a.h,expectWarp:1/(1-pre.order.warp),widthRatio:b.w/a.w,expectWeft:1/(1-pre.order.weft)};}""")
        print("shrink:", chk)
    # DXF round trip: export AAMA then re-import via importDXF2 (flat) — and a synthetic block DXF
    dxf = pg.evaluate("""()=>{const p=WP.S.patterns[0];WP.S.activePatternId=p.id;WP.render();
       // build a block-style DXF like TUKA/Gerber export
       const L=['0','SECTION','2','BLOCKS'];
       for(const pc of p.pieces){L.push('0','BLOCK','8','0','2',pc.name,'70','0','10','0','20','0','3',pc.name);
         const poly=WP.samplePiece(pc);L.push('0','POLYLINE','8','1','66','1','70','1');for(const q of poly)L.push('0','VERTEX','8','1','10',q.x.toFixed(3),'20',(-q.y).toFixed(3));L.push('0','SEQEND');
         for(const pt of pc.points){if(!pt.curve)L.push('0','POINT','8','2','10',pt.x.toFixed(3),'20',(-pt.y).toFixed(3));}
         L.push('0','TEXT','8','15','10',pc.points[0].x.toFixed(2),'20',(-pc.points[0].y).toFixed(2),'40','5','1','Piece Name: '+pc.name+'_X');
         if(pc.grain)L.push('0','LINE','8','7','10',pc.grain.x1.toFixed(2),'20',(-pc.grain.y1).toFixed(2),'11',pc.grain.x2.toFixed(2),'21',(-pc.grain.y2).toFixed(2));
         L.push('0','ENDBLK');}
       L.push('0','ENDSEC','0','SECTION','2','ENTITIES');
       for(const pc of p.pieces)L.push('0','INSERT','8','0','2',pc.name,'10','0','20','0','50','0');
       L.push('0','ENDSEC','0','EOF');
       const n=WP.S.patterns.length;WP.importDXF2(L.join('\\n'),'blocktest.dxf');document.querySelector('#overlay').classList.remove('show');
       const np=WP.S.patterns[WP.S.patterns.length-1];return {added:WP.S.patterns.length-n,pieces:np.pieces.map(pc=>[pc.name,pc.points.length,pc.points.filter(q=>q.curve).length,!!pc.grain])};}""")
    print("block dxf import:", dxf)
    # PLT export content check (no download in headless: call internals)
    plt = pg.evaluate("""()=>{if(!WP.S.marker)return null;let out='';const d=window.download;window.download=(n,c)=>{out=c};WP.exportPLT('t.plt');window.download=d;return out.slice(0,80)+' ... lines='+out.split('\\n').length;}""")
    print("plt:", plt)
    # keymap switch + hotkeys dialog
    pg.evaluate("()=>{WP.S.keymap='tuka';WP.render();}"); pg.keyboard.press("Shift+M"); pg.wait_for_timeout(200)
    print("chart opened by Shift+M (tuka map):", pg.evaluate("()=>document.querySelector('#overlay').classList.contains('show')"))
    pg.evaluate("()=>document.querySelector('#overlay').classList.remove('show')")
    pg.evaluate("()=>{WP.S.workspace='design';WP.S.activePatternId=WP.S.patterns[0].id;WP.render();}")
    pg.screenshot(path=str(OUT/"05_tuka_keys.png"))
    print("page errors:", errors or "none")
    b.close()
