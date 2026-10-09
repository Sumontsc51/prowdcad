"""Mouse/keyboard checks: TUKA keymap Move Points by rectangle, Program by area, point naming."""
import os, pathlib, re
from playwright.sync_api import sync_playwright
HTML=pathlib.Path(__file__).resolve().parent.parent/"prowdcad.html"; OUT=HTML.parent/"test"/"out"; OUT.mkdir(exist_ok=True)
with sync_playwright() as pw:
    b=pw.chromium.launch(); pg=b.new_page(viewport={"width":1500,"height":900}); errs=[]
    pg.on("pageerror",lambda e:errs.append(str(e)))
    pg.goto(HTML.as_uri()); pg.wait_for_timeout(400)
    pg.evaluate("()=>{const W=WP;const p=W.newPattern('T','M');const pc=W.newPiece('LEG');pc.points=[W.newPoint(0,0),W.newPoint(300,0),W.newPoint(260,1000),W.newPoint(40,1000)];pc.grain={x1:150,y1:100,x2:150,y2:900};p.pieces=[pc];W.S.patterns.push(p);W.S.activePatternId=p.id;W.S.keymap='tuka';W.S.units='inch';W.fitView('design');W.render();}")
    box=pg.locator("#svg").bounding_box()
    to_screen=pg.evaluate("()=>{const r=document.querySelector('#svg').getBoundingClientRect(),V=WP.S.vb.design;return {x:r.left,y:r.top,w:r.width,h:r.height,vx:V.x,vy:V.y,vw:V.w,vh:V.h};}")
    def S(x,y): t=to_screen; return (t["x"]+(x-t["vx"])/t["vw"]*t["w"], t["y"]+(y-t["vy"])/t["vh"]*t["h"])
    # Move Points tool via TUKA key Ctrl+Shift+U, drag rectangle around hem (y=1000)
    pg.mouse.click(*S(-200,-200)); pg.keyboard.press("Control+Shift+U")
    print("tool:",pg.evaluate("()=>WP.S.tool"))
    a=S(-50,950); c=S(350,1050); pg.mouse.move(*a); pg.mouse.down(); pg.mouse.move(*c,steps=6); pg.mouse.up(); pg.wait_for_timeout(150)
    print("dialog:",pg.inner_text("#dialog header"),"|",pg.inner_text("#dialog .body p").strip())
    pg.fill("#mv-dy","-1"); pg.screenshot(path=str(OUT/"06_movepoints.png")); pg.click("#dialog footer .primary")
    ys=pg.evaluate("()=>WP.activePattern().pieces[0].points.map(p=>+(p.y/25.4).toFixed(3))"); print("y after −1in:",ys)
    # Program by area: Shift+R, rectangle around hem, new param "Inseam", quick +Y
    pg.keyboard.press("Shift+R"); pg.mouse.move(*a); pg.mouse.down(); pg.mouse.move(*c,steps=6); pg.mouse.up(); pg.wait_for_timeout(150)
    pg.select_option("#pg-m","new:"); pg.fill("#pg-new","08 Inseam"); pg.click("#dialog [data-q='0,1']"); pg.click("#dialog footer .primary")
    print("rule:",pg.evaluate("()=>{const p=WP.activePattern();return [p.measurements.map(m=>m.name),p.pieces[0].points.map(q=>JSON.stringify(q.grade))]}"))
    # name a point via F2 after selecting it with click
    pg.keyboard.press("End")  # select tool in tuka map
    pg.mouse.click(*S(150,500)); pg.wait_for_timeout(80); pg.mouse.click(*S(0,0)); pg.wait_for_timeout(80)
    print("selected point:",pg.evaluate("()=>WP.S.sel.point"))
    pg.keyboard.press("F2"); pg.fill("#prompt-input","08 Inseam/m/q1"); pg.click("#dialog footer .primary")
    print("chart:",pg.evaluate("()=>WP.measureRows(WP.activePattern()).map(r=>[r.name,+(r.value/25.4).toFixed(3)])"))
    # rectangle select on empty canvas (select tool) then Delete is guarded (>3 pts)
    pg.keyboard.press("Home"); pg.keyboard.press("Control+Z"); print("undo →",pg.evaluate("()=>WP.activePattern().pieces[0].points[0].name||'(no name)'"))
    pg.screenshot(path=str(OUT/"07_ui.png"))
    print("errors:",errs or "none"); b.close()
