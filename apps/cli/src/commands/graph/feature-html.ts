import { createHash } from "node:crypto";

import { createCategoryClusterLayout } from "./category-clusters.js";
import { createFeatureThread, createFeatureWoolLayout, projectFeaturePoint } from "./feature-3d.js";
import { createFeatureClusterLayout } from "./feature-clusters.js";
import type { FeatureMapGraphV1, FeatureMapNodeV1 } from "./feature-model.js";
import { createFeatureUntangleMotion } from "./feature-untangle-motion.js";

/** Overflow gets its own column, so nodes never wrap onto an occupied lane position. */
export function createFeatureLaneLayout(nodes: readonly Pick<FeatureMapNodeV1, "id" | "kind">[]): {
  positions: Record<string, { x: number; y: number }>;
  width: number;
  height: number;
} {
  const positions: Record<string, { x: number; y: number }> = Object.create(null) as Record<
    string,
    { x: number; y: number }
  >;
  let cursor = 70;
  for (const kind of ["owner", "intent", "feature", "code", "test", "unmapped"]) {
    const group = nodes
      .filter((node) => node.kind === kind)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (group.length === 0) continue;
    const rows = kind === "feature" ? 10 : 22;
    const columnWidth = kind === "feature" ? 300 : 28;
    const rowHeight = kind === "feature" ? 70 : 32;
    group.forEach((node, index) => {
      positions[node.id] = {
        x: cursor + Math.floor(index / rows) * columnWidth,
        y: 65 + (index % rows) * rowHeight,
      };
    });
    cursor += Math.max(180, Math.ceil(group.length / rows) * columnWidth + 70);
  }
  const width = Math.max(1300, cursor + 30);
  const shift = Math.max(0, (1300 - cursor - 30) / 2);
  if (shift > 0) for (const point of Object.values(positions)) point.x += shift;
  return { positions, width, height: 820 };
}

/** Readable group context is separate from the scale-dependent diagram labels. */
export function createFeatureGroupIndex(
  groups: readonly {
    id: string;
    kind: "feature" | "category" | "shared" | "unassigned";
    label?: string;
    featureId?: string;
    memberIds: readonly string[];
  }[],
  nodes: readonly Pick<FeatureMapNodeV1, "id" | "label">[],
  visibleIds: readonly string[],
): { id: string; label: string; visible: number; total: number }[] {
  const labels = new Map(nodes.map((node) => [node.id, node.label]));
  const visible = new Set(visibleIds);
  return groups.flatMap((group) => {
    const count = group.memberIds.filter((id) => visible.has(id)).length;
    if (count === 0) return [];
    return [
      {
        id: group.id,
        label:
          group.label ||
          (group.featureId && labels.get(group.featureId)) ||
          (group.kind === "shared" ? "Shared context" : "Unassigned"),
        visible: count,
        total: group.memberIds.length,
      },
    ];
  });
}

const GROUPINGS = [
  {
    id: "feature",
    label: "Features",
    action: "Untangle by feature",
    subject: "declared feature scopes",
    complete: "Declared feature scopes. Shared context and unassigned files stay visible. ",
  },
  {
    id: "code",
    label: "Code areas",
    action: "Untangle code areas",
    subject: "code directories",
    complete: "Code directories. Shared and unmatched context stay visible. ",
  },
  {
    id: "test",
    label: "Test areas",
    action: "Untangle test areas",
    subject: "test directories",
    complete: "Test directories. Shared and unmatched context stay visible. ",
  },
  {
    id: "owner",
    label: "Ownership",
    action: "Untangle ownership",
    subject: "declared ownership context",
    complete: "Declared owner context via features. Shared context is separate. ",
  },
  {
    id: "intent",
    label: "Vision / Spec",
    action: "Untangle vision / spec",
    subject: "declared document context",
    complete: "Declared document context via features. Shared context is separate. ",
  },
  {
    id: "unmapped",
    label: "Unassigned",
    action: "Untangle unassigned",
    subject: "unassigned file directories",
    complete: "Unassigned files by directory; declared context stays separate. ",
  },
] as const;

const STYLE = String.raw`
:root{color-scheme:light;--paper:#f8f5ed;--white:#fff;--ink:#173734;--soft:#405c57;--line:#ccd5cb;--patina:#27685d;--orange:#b44d1f;--focus:#a74316;font-family:"Avenir Next",Avenir,"Segoe UI",system-ui,sans-serif;color:var(--ink);background:var(--paper)}
*{box-sizing:border-box}body{margin:0}button,input,select{font:inherit;color:inherit}button,select,input{background:var(--white);border:1px solid #7a948b;border-radius:5px;min-height:38px}button{padding:6px 12px;cursor:pointer}button:hover{background:#e2eee8}button:disabled{opacity:.5;cursor:default}button[aria-pressed=true]{background:var(--ink);color:var(--white)}:focus-visible{outline:3px solid var(--focus);outline-offset:3px}input{padding:7px 10px;caret-color:var(--orange)}::selection{background:#d4e8dc;color:var(--ink)}html{scrollbar-color:var(--patina) var(--paper)}a{color:var(--patina);text-underline-offset:.2em}.skip{position:absolute;left:12px;top:-80px;padding:10px;background:#fff;z-index:5}.skip:focus{top:12px}header{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:19px 25px;border-bottom:1px solid var(--line);background:#fff}h1{margin:0;font-size:1.65rem;letter-spacing:-.02em}header p{margin:3px 0 0;color:var(--soft);font-size:.88rem}.brand{display:flex;gap:12px;align-items:center}.brand svg{width:42px;height:42px;flex:none}.snapshot{font-family:"SFMono-Regular",Consolas,monospace;font-size:.75rem;overflow-wrap:anywhere}.toolbar{display:flex;align-items:end;flex-wrap:wrap;gap:12px;padding:15px 25px;background:#fff;border-bottom:1px solid var(--line)}.field{display:grid;gap:4px;font-size:.8rem}.field input{width:min(34vw,350px)}.toolbar label{font-weight:600}.toolbar select{padding:6px 25px 6px 9px}.scope{margin:0;padding:10px 25px;color:var(--soft);font-size:.85rem;line-height:1.5;border-bottom:1px solid var(--line)}.scope[data-incomplete=true]{background:#fff0df;color:#783b15}.workspace{display:grid;grid-template-columns:minmax(0,1fr) 355px;height:calc(100dvh - 220px);min-height:460px}.map-region{position:relative;min-width:0;overflow:hidden;touch-action:none;background:var(--paper)}#viewport{height:100%;min-height:400px;outline-offset:-5px}#map{display:block;width:100%;height:100%;user-select:none}#map .edge{fill:none;stroke-width:1.3;opacity:.42}#map .edge.ownership{stroke:#2e7968;stroke-dasharray:4 4}#map .edge.intent{stroke:#7a6e92;stroke-dasharray:2 5}#map .edge.test{stroke:#477896}#map .edge.code{stroke:#bd632e}#map .edge.dependency{stroke:#903d24;stroke-width:2.5}#map .node{cursor:pointer}#map .node.selected .shape{stroke:#152f2c;stroke-width:4}#map .node .shape{stroke:#4d6a5c;stroke-width:1.4;fill:#fff}#map .node.feature .shape{fill:#edb68e;stroke:#9d4c26}#map .node.owner .shape{fill:#d3e7dc;stroke:#2c6d5e}#map .node.test .shape{fill:#d9e9ef;stroke:#3e7187}#map .node.intent .shape{fill:#e6e0ee;stroke:#74618b}#map .node.unmapped .shape{fill:#eeeae2;stroke:#77776b;stroke-dasharray:3 3}#map text{fill:#183733;font:12px "Avenir Next",Avenir,system-ui,sans-serif;paint-order:stroke;stroke:var(--paper);stroke-width:3px;stroke-linejoin:round;pointer-events:none}#map .feature text{font-weight:700;font-size:13px}.zoom{position:absolute;bottom:17px;left:20px;display:flex;gap:6px;background:var(--paper);padding:6px;border-radius:7px}.legend{position:absolute;top:12px;left:20px;display:flex;gap:14px;flex-wrap:wrap;padding:5px 0;font-size:.75rem;max-width:90%;color:var(--soft)}.legend span::before{content:"";display:inline-block;width:9px;height:9px;border:1px solid #4d6a5c;border-radius:50%;margin-right:5px;vertical-align:baseline;background:#edb68e}.legend .code::before{background:#fff}.legend .test::before{background:#d9e9ef}.legend .owner::before{background:#d3e7dc;border-radius:0}.legend .intent::before{background:#e6e0ee;border-radius:0;transform:rotate(45deg)}.legend .unmapped::before{background:#eeeae2;border-style:dashed}.aside{border-left:1px solid var(--line);background:#fff;overflow:auto;padding:21px;overscroll-behavior:contain}.aside h2{margin:0 0 10px;font-size:1.08rem;overflow-wrap:anywhere}.aside h3{margin:22px 0 8px;font-size:.9rem}.aside p,.aside li{font-size:.85rem;line-height:1.55;overflow-wrap:anywhere}.aside p{color:var(--soft);margin:8px 0}.aside ul{padding-left:20px}.aside .status{color:#773b19}.aside pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.74rem;line-height:1.5;background:var(--paper);padding:10px}.aside code,.path{font-family:"SFMono-Regular",Consolas,monospace;font-size:.78rem}.path{width:100%;min-width:0}.node-list{display:flex;flex-direction:column;gap:4px;margin:9px 0 0}.node-list button{text-align:left;font-size:.8rem;line-height:1.35;overflow-wrap:anywhere;min-height:34px}.node-list button[aria-current=true]{background:#dfece3;border-color:var(--patina)}.section-line{display:flex;align-items:center;justify-content:space-between;gap:10px}.section-line h2{margin:0}.muted{color:var(--soft)}.empty{position:absolute;top:35%;left:8%;right:8%;max-width:48ch;text-align:center;margin:auto}.empty h2{font-size:1.5rem;letter-spacing:-.02em}.empty p{line-height:1.65;color:var(--soft)}.empty[hidden]{display:none}.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}details{margin-top:22px;font-size:.83rem}details summary{cursor:pointer}footer{padding:11px 25px;background:#fff;border-top:1px solid var(--line);font-size:.75rem;color:var(--soft)}.selection-tools{display:flex;gap:6px;margin:10px 0;flex-wrap:wrap}
@media(max-width:850px){header{padding:15px 16px;align-items:flex-start}header .snapshot{max-width:120px}h1{font-size:1.5rem}.toolbar{padding:12px 16px;gap:9px}.field input{width:100%}.field{flex:1 1 140px}.field-search{flex:1 1 100%}.toolbar>button{flex:1 1 120px}.scope{padding:9px 16px}.workspace{grid-template-columns:1fr;height:auto;min-height:0}.map-region{height:55dvh;min-height:360px}.aside{border-left:0;border-top:1px solid var(--line);height:auto;max-height:65dvh;padding:18px 16px}footer{padding:12px 16px}.legend{left:15px;gap:8px;font-size:.7rem}.zoom{left:12px;bottom:10px}#viewport{min-height:360px}}
.untangle-action{position:absolute;right:20px;bottom:17px;max-width:170px;min-height:44px;padding:8px 13px;border-color:var(--patina);background:var(--ink);color:var(--white);font-weight:650}.untangle-action:hover{background:#27685d}.untangle-note{position:absolute;left:20px;right:20px;bottom:75px;max-width:75ch;margin:0;pointer-events:none;font-size:.8rem;line-height:1.45;color:var(--soft);background:var(--paper)}#map .cluster-zone{fill:#deebe4;fill-opacity:.28;stroke:#8aa99c;stroke-width:1;stroke-dasharray:3 3}#map .cluster-context .cluster-zone{fill:#e6e0ee;stroke:#9d91ae}#map .cluster-unassigned .cluster-zone{fill:#eeeae2;stroke:#99978a}#map .cluster-title{font-size:12px;font-weight:700;text-anchor:middle}#map .cluster-count{font-size:10px;text-anchor:middle}#map[data-clustered=true] .node.feature text{display:none}.cluster-regions{pointer-events:none}
@media(max-width:850px){.untangle-action{right:12px;bottom:10px;max-width:165px;font-size:.85rem}.untangle-note{left:15px;right:15px;bottom:71px;font-size:.75rem}.zoom{padding:4px;gap:4px}.zoom button{padding:6px 10px;min-width:34px}}
#map[data-grouping=test] .cluster-category .cluster-zone{fill:#d9e9ef;stroke:#779cab}#map[data-grouping=owner] .cluster-category .cluster-zone{fill:#d3e7dc;stroke:#669685}#map[data-grouping=intent] .cluster-category .cluster-zone{fill:#e6e0ee;stroke:#9d91ae}#map[data-grouping=unmapped] .cluster-category .cluster-zone{fill:#eeeae2;stroke:#99978a}
#group-index summary{min-height:44px;padding:10px 0;font-size:.9rem;font-weight:650}.map-region{display:grid;grid-template-rows:auto minmax(0,1fr) 135px}.map-region .legend{position:static;max-width:none;margin:12px 20px 8px}#viewport{height:100%;min-height:0;position:relative}.empty{top:50%;transform:translateY(-50%)}@media(max-width:850px){.map-region .legend{margin:12px 15px 8px}}
@media(prefers-reduced-motion:no-preference){button{transition:background-color .15s ease-out}}
`;

const SCRIPT = String.raw`
(function(){
"use strict";
var raw=atob(document.getElementById("map-data").textContent.trim());
var data=JSON.parse(new TextDecoder().decode(Uint8Array.from(raw,function(c){return c.charCodeAt(0)})));
var svg=document.getElementById("map"),world=document.createElementNS("http://www.w3.org/2000/svg","g"),viewport=document.getElementById("viewport");svg.appendChild(world);
var state={selected:null,query:"",kind:"all",isolate:false,layout:"wool",grouping:"feature",zoom:1,dx:0,dy:0,yaw:.35,pitch:-.22,spinning:false},positions=new Map(),visibleNodes=[],drag=null,bounds={width:1300,height:820};
var laneLayout=${createFeatureLaneLayout.toString()};
var createFeatureWoolLayout=${createFeatureWoolLayout.toString()};
var createFeatureClusterLayout=${createFeatureClusterLayout.toString()};
var createCategoryClusterLayout=${createCategoryClusterLayout.toString()};
var createFeatureGroupIndex=${createFeatureGroupIndex.toString()};
var groupingChoices=${JSON.stringify(GROUPINGS)},groupingSelect=document.getElementById("grouping");
var createFeatureUntangleMotion=${createFeatureUntangleMotion.toString()};
var projectFeaturePoint=${projectFeaturePoint.toString()};
var createFeatureThread=${createFeatureThread.toString()};
var labels={feature:"Feature",code:"Code",test:"Test",owner:"Ownership",intent:"Vision / Spec",unmapped:"Unassigned"};
var relations={code:"Code scope",test:"Test scope",ownership:"Declared ownership",intent:"Intent",dependency:"Declared feature dependency"};
var byId=new Map(data.nodes.map(function(n){return[n.id,n]}));
var nodeElements=new Map(),edgeElements=new Map(),projected=new Map();
function groupingChoice(){return groupingChoices.find(function(choice){return choice.id===state.grouping})}
function createGrouping(){return state.grouping==="feature"?createFeatureClusterLayout(data.nodes,data.edges):createCategoryClusterLayout(data.nodes,data.edges,state.grouping)}
var clusterLayout=createGrouping(),clusterAmount=0,groupElements=new Map(),mapVisible=true,untangleMotion=null;
var untangleButton=document.getElementById("untangle"),untangleNote=document.getElementById("untangle-note");
var motion=typeof matchMedia==="function"?matchMedia("(prefers-reduced-motion: reduce)"):null;
var frame=null,lastFrame=0,rotationStarted=0,rotationButton=document.getElementById("rotation");
function el(name,attrs){var e=document.createElementNS("http://www.w3.org/2000/svg",name);Object.keys(attrs||{}).forEach(function(k){e.setAttribute(k,String(attrs[k]))});return e}
function para(text,cls){var p=document.createElement("p");p.textContent=text;if(cls)p.className=cls;return p}
function neighbors(id){var ids=new Set([id]);data.edges.forEach(function(e){if(e.from===id)ids.add(e.to);if(e.to===id)ids.add(e.from)});return ids}
function seed(id){var value=2166136261;for(var i=0;i<id.length;i++)value=Math.imul(value^id.charCodeAt(i),16777619);return(value>>>0)/4294967296}
function layout(){
 positions.clear();
 if(state.layout==="lanes"){
  var lanes=laneLayout(data.nodes);Object.keys(lanes.positions).forEach(function(id){positions.set(id,{x:lanes.positions[id].x,y:lanes.positions[id].y,z:0})});bounds={width:lanes.width,height:lanes.height};
 }else{
  clusterAmount=state.layout==="clusters"?1:0;
  var clustered=state.layout==="clusters"?clusterLayout.positions:null;
  var wool=clustered||createFeatureWoolLayout(data.nodes,data.edges);Object.keys(wool).forEach(function(id){positions.set(id,wool[id])});bounds={width:1300,height:820};
 }
 if(state.layout==="lanes")clusterAmount=0;
 svg.setAttribute("viewBox","0 0 "+bounds.width+" "+bounds.height);rotationButton.disabled=state.layout==="lanes"||Boolean(motion&&motion.matches);
}
function transform(){var x=bounds.width/2,y=bounds.height/2;world.setAttribute("transform","translate("+state.dx+" "+state.dy+") translate("+x+" "+y+") scale("+state.zoom+") translate("+(-x)+" "+(-y)+")")}
function nodeRadius(n){return n.kind==="feature"?Math.min(29,14+Math.sqrt(Math.max(0,n.cognitive||0))*1.1):n.kind==="code"||n.kind==="unmapped"?5.5:8}
function focusedControl(){
 var active=document.activeElement;if(!active||!active.closest)return null;
 for(var kind of ["graph","list","relation"]){var owner=active.closest("[data-"+kind+"-node]");if(owner)return{kind:kind,id:owner.getAttribute("data-"+kind+"-node")}}
 return null;
}
function restoreFocus(previous){
 if(!previous)return;
 var target=previous.kind==="graph"?svg.querySelector('[data-graph-node="'+previous.id+'"]'):document.getElementById("node-list").querySelector('[data-list-node="'+previous.id+'"]');
 if(!target&&previous.kind!=="graph")target=svg.querySelector('[data-graph-node="'+previous.id+'"]');
 (target||viewport).focus({preventScroll:true});
}
function paintGroups(){
 var opacity=Math.max(0,Math.min(1,(clusterAmount-.45)/.55));
 groupElements.forEach(function(item){
  var points=item.group.memberIds.map(function(id){return projected.get(id)}).filter(Boolean);
  item.element.style.opacity=String(opacity);item.element.style.display=state.layout==="lanes"||!points.length||!opacity?"none":"";
  if(!points.length||!opacity)return;
  var xs=points.map(function(p){return p.x}),ys=points.map(function(p){return p.y}),left=Math.min.apply(null,xs),right=Math.max.apply(null,xs),top=Math.min.apply(null,ys),bottom=Math.max.apply(null,ys),x=(left+right)/2;
  item.zone.setAttribute("cx",x);item.zone.setAttribute("cy",(top+bottom)/2);item.zone.setAttribute("rx",Math.max(26,(right-left)/2+11));item.zone.setAttribute("ry",Math.max(22,(bottom-top)/2+11));
  var feature=item.group.featureId&&byId.get(item.group.featureId),label=item.group.label||(feature?feature.label:item.group.kind==="shared"?"Shared context":"Unassigned");
  item.title.textContent=label.length>23&&(item.group.kind==="feature"||item.group.kind==="category")?label.slice(0,20)+"…":label;item.title.setAttribute("x",x);item.title.setAttribute("y",top-18);item.count.textContent=points.length+" nodes";item.count.setAttribute("x",x);item.count.setAttribute("y",top-5);
 });
}
function paint(){
 var related=state.selected?neighbors(state.selected):null;
 projected.clear();
 visibleNodes.forEach(function(n){var p=positions.get(n.id);projected.set(n.id,state.layout!=="lanes"?projectFeaturePoint(p,state):{x:p.x,y:p.y,depth:0,scale:1})});
 paintGroups();svg.setAttribute("data-clustered",String(clusterAmount>.6));svg.setAttribute("data-grouping",state.grouping);
 edgeElements.forEach(function(line,id){var edge=line.edge,a=projected.get(edge.from),b=projected.get(edge.to),from=positions.get(edge.from),to=positions.get(edge.to);var curve;
  if(state.layout!=="lanes")curve=createFeatureThread(from,to,state,seed(id)*2-1,clusterAmount);
  else{var bend=(seed(id)-.5)*150;curve="M"+a.x+","+a.y+" C"+(bounds.width/2+bend)+","+(a.y+bend)+" "+(bounds.width/2-bend)+","+(b.y-bend)+" "+b.x+","+b.y}
  line.element.setAttribute("d",curve);var depth=Math.max(.25,Math.min(.8,.52+(a.depth+b.depth)/1800));line.element.style.opacity=String(related&&edge.from!==state.selected&&edge.to!==state.selected?0.08:depth);
 });
 visibleNodes.forEach(function(n){var p=projected.get(n.id),g=nodeElements.get(n.id);g.setAttribute("transform","translate("+p.x+" "+p.y+")"+(state.layout!=="lanes"?" scale("+(p.scale*(1-clusterAmount*.35))+")":""));var depth=Math.max(.4,Math.min(1,.78+p.depth/1200));g.style.opacity=String(related&&!related.has(n.id)?0.22:depth)});
 transform();
}
function draw(previous){
 if(previous===undefined)previous=focusedControl();
 while(world.firstChild)world.removeChild(world.firstChild);nodeElements.clear();edgeElements.clear();groupElements.clear();
 var groupLayer=el("g",{"class":"cluster-regions","aria-hidden":"true"});world.appendChild(groupLayer);
 clusterLayout.groups.forEach(function(group){var g=el("g",{"class":group.kind==="shared"?"cluster-context":group.kind==="unassigned"?"cluster-unassigned":group.kind==="category"?"cluster-category":"cluster-feature"}),zone=el("ellipse",{"class":"cluster-zone"}),title=el("text",{"class":"cluster-title"}),count=el("text",{"class":"cluster-count"});g.appendChild(zone);g.appendChild(title);g.appendChild(count);groupLayer.appendChild(g);groupElements.set(group.id,{element:g,zone:zone,title:title,count:count,group:group})});
 var related=state.selected?neighbors(state.selected):null;
 visibleNodes=data.nodes.filter(function(n){return(state.kind==="all"||n.kind===state.kind||(Array.isArray(n.details.roles)&&n.details.roles.includes(state.kind)))&&(!state.query||(n.label+" "+(n.path||"")+" "+JSON.stringify(n.details)).toLowerCase().includes(state.query))&&(!state.isolate||!related||related.has(n.id))});
 var ids=new Set(visibleNodes.map(function(n){return n.id}));
 data.edges.forEach(function(edge){if(!ids.has(edge.from)||!ids.has(edge.to))return;var line=el("path",{"class":"edge "+edge.kind,"data-edge":edge.id});var title=el("title",{});title.textContent=relations[edge.kind];line.appendChild(title);world.appendChild(line);edgeElements.set(edge.id,{element:line,edge:edge})});
 var ordered=visibleNodes.slice();if(state.layout!=="lanes")ordered.sort(function(a,b){return projectFeaturePoint(positions.get(a.id),state).depth-projectFeaturePoint(positions.get(b.id),state).depth});
 ordered.forEach(function(n){var r=nodeRadius(n);var g=el("g",{"class":"node "+n.kind+(state.selected===n.id?" selected":""),tabindex:"0",role:"button","data-graph-node":n.id,"aria-label":labels[n.kind]+": "+n.label+"; "+n.status});
  var shape;if(n.kind==="owner")shape=el("rect",{x:-r,y:-r,width:r*2,height:r*2,"class":"shape"});else if(n.kind==="intent")shape=el("path",{d:"M0,-"+(r+3)+" L"+(r+3)+",0 L0,"+(r+3)+" L-"+(r+3)+",0 Z","class":"shape"});else shape=el("circle",{r:r,"class":"shape"});g.appendChild(shape);
  var title=el("title",{});title.textContent=n.label+" ("+n.status+")"+(typeof n.cognitive==="number"?" — cognitive execution_unit "+n.cognitive:"");g.appendChild(title);
  if(n.kind==="feature"||state.selected===n.id){var text=el("text",{x:r+7,y:4});text.textContent=n.label.length>40?n.label.slice(0,37)+"…":n.label;g.appendChild(text)}
  g.addEventListener("focus",function(){settleUntangling();stopRotation()});g.addEventListener("click",function(e){e.stopPropagation();select(n.id,{kind:"graph",id:n.id})});g.addEventListener("keydown",function(e){if(e.key==="Enter"||e.key===" "){e.preventDefault();select(n.id)}});world.appendChild(g);nodeElements.set(n.id,g);
 });paint();updateList();updateGroupIndex();
 document.getElementById("visible-count").textContent=visibleNodes.length+" / "+data.summary.totalNodes+" nodes";
 var empty=document.getElementById("empty");empty.hidden=visibleNodes.length!==0;
 document.getElementById("empty-title").textContent=data.nodes.length?"No match in this snapshot":"No declared feature map yet";
 document.getElementById("empty-text").textContent=data.nodes.length?"Reset the filters or search for another path.":"This does not mean the code is simple or correct. Declare feature boundaries, tests and ownership, then generate the map again.";
 restoreFocus(previous);
}
function updateList(){var list=document.getElementById("node-list");while(list.firstChild)list.removeChild(list.firstChild);visibleNodes.slice(0,200).forEach(function(n){var b=document.createElement("button");b.type="button";b.textContent=labels[n.kind]+" · "+n.label;b.setAttribute("data-list-node",n.id);b.setAttribute("aria-current",String(n.id===state.selected));b.addEventListener("click",function(){select(n.id,{kind:"list",id:n.id})});list.appendChild(b)});document.getElementById("list-note").textContent=visibleNodes.length>200?"The list shows 200 matches. Narrow the search to reach another node.":"The same nodes as the diagram. Select with Tab and Enter."}
function updateGroupIndex(){
 var groups=createFeatureGroupIndex(clusterLayout.groups,data.nodes,visibleNodes.map(function(node){return node.id})),list=document.getElementById("group-list");
 while(list.firstChild)list.removeChild(list.firstChild);
 groups.forEach(function(group){var item=document.createElement("li");item.setAttribute("data-group-id",group.id);item.textContent=group.label+" · "+(group.visible===group.total?group.total+" nodes":group.visible+" / "+group.total+" nodes visible");list.appendChild(item)});
 document.getElementById("group-count").textContent="("+groups.length+")";
 document.getElementById("group-note").textContent=groupingChoice().label+". Counts describe snapshot nodes; filters affect the visible count. Full feature metrics remain in the details.";
}
function heading(parent,text){var h=document.createElement("h3");h.textContent=text;parent.appendChild(h)}
function json(parent,value){var pre=document.createElement("pre");pre.textContent=JSON.stringify(value,null,2);parent.appendChild(pre)}
function select(id,previous){
 settleUntangling();stopRotation();if(previous===undefined)previous=focusedControl();
 state.selected=id;var n=byId.get(id),detail=document.getElementById("detail");while(detail.firstChild)detail.removeChild(detail.firstChild);
 var h=document.createElement("h2");h.textContent=n.label;detail.appendChild(h);detail.appendChild(para(labels[n.kind]+" · "+n.status,"status"));
 if(n.path){var input=document.createElement("input");input.className="path";input.value=n.path;input.readOnly=true;input.setAttribute("aria-label","Repository-relative path");input.addEventListener("focus",function(){input.select()});detail.appendChild(input);detail.appendChild(para("Select and copy this path to use it in your editor or agent."))}
 if(n.kind==="feature"){
  if(n.details.metrics){heading(detail,"Complete feature complexity");detail.appendChild(para("Cognitive: execution_unit "+n.details.metrics.cognitive.execution_unit+", self "+n.details.metrics.cognitive.self+", top_level "+n.details.metrics.cognitive.top_level+". "+n.details.metrics.files+" complete code files; "+n.details.metrics.sloc+" SLOC."));detail.appendChild(para("Shared files count in full within each declared feature. Do not add feature readings to produce a repository total."))}else detail.appendChild(para("Complexity is incomplete. Missing measurements are neither zero nor a passed result."));
  heading(detail,"Test evidence");json(detail,n.details.testEvidence);heading(detail,"Agent hints");json(detail,n.details.agentHints);
 }
 heading(detail,"Direct relationships");var ul=document.createElement("ul");data.edges.filter(function(e){return e.from===id||e.to===id}).slice(0,100).forEach(function(e){var other=byId.get(e.from===id?e.to:e.from);if(!other)return;var li=document.createElement("li"),b=document.createElement("button");b.type="button";b.setAttribute("data-relation-node",other.id);b.textContent=relations[e.kind]+": "+other.label;b.addEventListener("click",function(){select(other.id,{kind:"relation",id:other.id})});li.appendChild(b);ul.appendChild(li)});detail.appendChild(ul);
 heading(detail,"Source evidence");json(detail,n.details);document.getElementById("selected-status").textContent=labels[n.kind]+" selected: "+n.label;draw(previous);
}
function stopRotation(){state.spinning=false;if(frame!==null&&typeof cancelAnimationFrame==="function")cancelAnimationFrame(frame);frame=null;lastFrame=0;rotationButton.textContent="Start rotation";rotationButton.setAttribute("aria-pressed","false")}
function animate(timestamp){
 if(!state.spinning)return;
 if(document.hidden||(motion&&motion.matches)||state.layout==="lanes"||!mapVisible||timestamp-rotationStarted>=90000){stopRotation();return}
 var interval=Math.max(33,Math.min(160,edgeElements.size/12));if(!lastFrame||timestamp-lastFrame>=interval){var elapsed=lastFrame?Math.min(100,timestamp-lastFrame):0;state.yaw+=elapsed*.00013;lastFrame=timestamp;paint()}
 frame=requestAnimationFrame(animate);
}
function startRotation(){
 settleUntangling();if(state.layout==="lanes"||!mapVisible||(motion&&motion.matches)||typeof requestAnimationFrame!=="function")return;
 state.spinning=true;rotationStarted=typeof performance!=="undefined"?performance.now():0;lastFrame=0;rotationButton.textContent="Pause rotation";rotationButton.setAttribute("aria-pressed","true");frame=requestAnimationFrame(animate);
}
function reset(){settleUntangling();stopRotation();state.selected=null;state.query="";state.kind="all";state.isolate=false;state.zoom=1;state.dx=0;state.dy=0;state.yaw=.35;state.pitch=-.22;document.getElementById("search").value="";document.getElementById("kind").value="all";document.getElementById("isolate").setAttribute("aria-pressed","false");document.getElementById("detail").textContent="Select a feature or file. Its complete measurements and relationships appear here.";draw()}
function zoom(f){settleUntangling();state.zoom=Math.max(.25,Math.min(4,state.zoom*f));transform()}
function moveCamera(dx,dy){settleUntangling();state.yaw+=dx;state.pitch=Math.max(-1.45,Math.min(1.45,state.pitch+dy));paint()}
function settleUntangling(){if(untangleMotion){var phase=untangleMotion.getState().phase;if(phase==="running"||phase==="paused")untangleMotion.finish()}}
function updateUntangleAction(current){
 var running=current.phase==="running",paused=current.phase==="paused",choice=groupingChoice();
 untangleButton.textContent=running?"Pause untangling":paused?"Resume untangling":clusterAmount>.5?"Show tangle":choice.action;
 untangleButton.setAttribute("data-phase",current.phase);untangleButton.disabled=!data.nodes.length;
 rotationButton.disabled=state.layout==="lanes"||Boolean(motion&&motion.matches)||running||paused;
 untangleNote.textContent=(paused?"Untangling paused. Resume when ready. ":running?"Grouping "+choice.subject+". ":clusterAmount>.5?choice.complete:"Group the wool map by "+choice.subject+". ")+"Code and metrics are unchanged.";
}
untangleMotion=createFeatureUntangleMotion({
 requestFrame:typeof requestAnimationFrame==="function"?function(callback){return requestAnimationFrame(callback)}:undefined,
 cancelFrame:typeof cancelAnimationFrame==="function"?function(id){cancelAnimationFrame(id)}:undefined,
 reducedMotion:function(){return Boolean(motion&&motion.matches)},visible:function(){return !document.hidden&&mapVisible},
 frameIntervalMs:Math.max(33,Math.min(160,data.edges.length/12)),
 onFrame:function(next,amount){positions=new Map(Object.keys(next).map(function(id){return[id,next[id]]}));clusterAmount=amount;paint()},onState:updateUntangleAction
});
untangleButton.addEventListener("click",function(){
 stopRotation();var current=untangleMotion.getState();
 if(current.phase==="running"){untangleMotion.pause();return}if(current.phase==="paused"){untangleMotion.resume();return}
 if(!data.nodes.length)return;
 if(state.layout==="lanes"){state.layout="wool";layout();draw()}
 var target=clusterAmount>.5?"wool":"clusters",from=Object.fromEntries(positions),to=target==="clusters"?clusterLayout.positions:createFeatureWoolLayout(data.nodes,data.edges);
 state.layout=target;document.getElementById("layout").textContent="Arrange by layer";
 untangleMotion.start({from:from,to:to,fromAmount:clusterAmount,toAmount:target==="clusters"?1:0,target:target});
});
groupingSelect.value=state.grouping;
groupingSelect.addEventListener("change",function(){
 if(!groupingChoices.some(function(choice){return choice.id===groupingSelect.value})){groupingSelect.value=state.grouping;return}
 settleUntangling();stopRotation();untangleMotion.cancel();state.grouping=groupingSelect.value;clusterLayout=createGrouping();state.layout="wool";document.getElementById("layout").textContent="Arrange by layer";layout();draw();updateUntangleAction(untangleMotion.getState());
});
layout();draw();updateUntangleAction(untangleMotion.getState());
var summary=data.summary;document.getElementById("snapshot").textContent="Source "+data.sourceTreeDigest.slice(0,12);document.getElementById("scope").textContent=summary.features+" declared features · "+summary.mappedCodeFiles+" mapped code files · "+summary.unmappedCodeFiles+" unassigned · Status: "+summary.status+(summary.truncated?" · BOUNDED SNAPSHOT: "+summary.shownNodes+" / "+summary.totalNodes+" nodes, "+summary.shownEdges+" / "+summary.totalEdges+" edges":"");document.getElementById("scope").dataset.incomplete=String(summary.truncated||summary.status!=="evidence_consistent");
if(summary.features===0){var intro=document.getElementById("detail");intro.appendChild(para("No declared feature map yet. These files are unassigned; missing complexity readings are not zero."));heading(intro,"Declare a feature boundary");intro.appendChild(para("Use product to propose a scope, save only report.draft as .untangle/features.json, then explicitly review code, tests and ownership. Run graph features again."));var command=document.createElement("pre");command.textContent="untangle product --draft --feature=<id> --path=<file> --format=json";intro.appendChild(command)}
var issues=document.getElementById("issues");data.issues.concat(data.limitations).forEach(function(issue){var li=document.createElement("li");li.textContent=issue;issues.appendChild(li)});if(data.dependencyCycles.length)issues.appendChild(para("Declared feature cycles: "+JSON.stringify(data.dependencyCycles)));
 document.getElementById("search").addEventListener("input",function(e){settleUntangling();stopRotation();state.query=e.target.value.toLowerCase();draw()});document.getElementById("kind").addEventListener("change",function(e){settleUntangling();stopRotation();state.kind=e.target.value;draw()});
 document.getElementById("isolate").addEventListener("click",function(){settleUntangling();stopRotation();state.isolate=!state.isolate;this.setAttribute("aria-pressed",String(state.isolate));draw()});document.getElementById("layout").addEventListener("click",function(){stopRotation();untangleMotion.cancel();state.layout=state.layout==="lanes"?"wool":"lanes";this.textContent=state.layout==="wool"?"Arrange by layer":"Show 3D wool map";state.zoom=1;state.dx=0;state.dy=0;layout();draw();updateUntangleAction(untangleMotion.getState())});document.getElementById("reset").addEventListener("click",reset);document.getElementById("rotation").addEventListener("click",function(){if(state.spinning)stopRotation();else startRotation()});document.getElementById("zoom-in").addEventListener("click",function(){stopRotation();zoom(1.2)});document.getElementById("zoom-out").addEventListener("click",function(){stopRotation();zoom(1/1.2)});document.getElementById("zoom-reset").addEventListener("click",function(){settleUntangling();stopRotation();state.zoom=1;state.dx=0;state.dy=0;state.yaw=.35;state.pitch=-.22;paint()});
 viewport.addEventListener("wheel",function(e){e.preventDefault();stopRotation();zoom(e.deltaY<0?1.1:1/1.1)},{passive:false});
 viewport.addEventListener("pointerdown",function(e){if(e.target.closest(".node")||e.target.closest("button"))return;settleUntangling();stopRotation();drag={id:e.pointerId,x:e.clientX,y:e.clientY,dx:state.dx,dy:state.dy,yaw:state.yaw,pitch:state.pitch,pan:e.shiftKey||state.layout==="lanes"};viewport.setPointerCapture(e.pointerId)});viewport.addEventListener("pointermove",function(e){if(!drag||e.pointerId!==drag.id)return;var rect=svg.getBoundingClientRect(),scale=Math.max(.01,Math.min(rect.width/bounds.width,rect.height/bounds.height));if(drag.pan){state.dx=drag.dx+(e.clientX-drag.x)/scale;state.dy=drag.dy+(e.clientY-drag.y)/scale;transform()}else{state.yaw=drag.yaw+(e.clientX-drag.x)*.008;state.pitch=Math.max(-1.45,Math.min(1.45,drag.pitch+(e.clientY-drag.y)*.008));paint()}});viewport.addEventListener("pointerup",function(e){if(drag&&e.pointerId===drag.id)drag=null});viewport.addEventListener("pointercancel",function(){drag=null});viewport.addEventListener("lostpointercapture",function(){drag=null});
 viewport.addEventListener("keydown",function(e){if(e.target!==viewport)return;var moved=true;settleUntangling();stopRotation();if(e.key==="+"||e.key==="=")zoom(1.2);else if(e.key==="-")zoom(1/1.2);else if(e.key==="ArrowLeft"){if(e.shiftKey||state.layout==="lanes")state.dx-=35;else moveCamera(-.12,0)}else if(e.key==="ArrowRight"){if(e.shiftKey||state.layout==="lanes")state.dx+=35;else moveCamera(.12,0)}else if(e.key==="ArrowUp"){if(e.shiftKey||state.layout==="lanes")state.dy-=35;else moveCamera(0,-.12)}else if(e.key==="ArrowDown"){if(e.shiftKey||state.layout==="lanes")state.dy+=35;else moveCamera(0,.12)}else if(e.key==="Escape")reset();else moved=false;if(moved){e.preventDefault();transform()}});
 if(typeof document.addEventListener==="function")document.addEventListener("visibilitychange",function(){if(document.hidden){stopRotation();untangleMotion.pause()}});
 if(motion&&typeof motion.addEventListener==="function")motion.addEventListener("change",function(){stopRotation();if(motion.matches)settleUntangling();updateUntangleAction(untangleMotion.getState())});
 if(typeof IntersectionObserver==="function"){var visibilityObserver=new IntersectionObserver(function(entries){entries.forEach(function(entry){if(entry.target!==viewport)return;mapVisible=entry.isIntersecting;if(!mapVisible){stopRotation();untangleMotion.pause()}})},{threshold:0});visibilityObserver.observe(viewport)}
 if(typeof addEventListener==="function")addEventListener("pagehide",function(){stopRotation();untangleMotion.pause()});
 document.getElementById("ready").textContent="Local 3D map ready. No network connection.";
})();
`;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("base64");
}

/** Static assets are CSP-hashed. Untrusted graph text is inert base64 and textContent only. */
export function createFeatureMapHtml(graph: FeatureMapGraphV1): string {
  const encoded = Buffer.from(JSON.stringify(graph), "utf8").toString("base64");
  const csp = [
    "default-src 'none'",
    `script-src 'sha256-${hash(SCRIPT)}'`,
    `style-src 'sha256-${hash(STYLE)}'`,
    "connect-src 'none'",
    "img-src 'none'",
    "font-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>Untangle · Feature map</title><style>${STYLE}</style></head><body>
<a class="skip" href="#viewport">Skip to feature map</a>
<header><div class="brand"><svg aria-hidden="true" viewBox="0 0 48 48" fill="none" stroke="#b44d1f" stroke-width="2.4"><circle cx="23" cy="23" r="17"/><path d="M8 14c11-7 31 7 30 16M8 23c9-7 24-3 31 7M14 8c-4 10 6 28 15 31M23 6c-5 13 3 25 12 30M9 32c5-10 22-17 29-15M36 36c7 2 8 6 6 9"/></svg><div><h1>Untangle · Feature map</h1><p>Trace declared features, code, tests and ownership.</p></div></div><p id="snapshot" class="snapshot">Local source snapshot</p></header>
<section class="toolbar" aria-label="Feature map controls"><div class="field field-search"><label for="search">Find a feature, path or owner</label><input id="search" type="search" placeholder="e.g. search or src/account.ts" autocomplete="off"></div><div class="field"><label for="kind">Layer</label><select id="kind"><option value="all">All layers</option><option value="feature">Features</option><option value="code">Code</option><option value="test">Tests</option><option value="owner">Ownership</option><option value="intent">Vision / Spec</option><option value="unmapped">Unassigned</option></select></div><div class="field"><label for="grouping">Untangle by</label><select id="grouping" aria-describedby="grouping-help">${GROUPINGS.map((choice) => `<option value="${choice.id}">${choice.label}</option>`).join("")}</select></div><button id="isolate" type="button" aria-pressed="false">Direct neighbors only</button><button id="layout" type="button">Arrange by layer</button><button id="rotation" type="button" aria-pressed="false" aria-describedby="motion-note">Start rotation</button><button id="reset" type="button">Reset filters</button></section>
<p id="grouping-help" class="sr">Choose a grouping independently of the layer filter. Code and test areas use file directories. Ownership and document context follow declared feature links; they do not infer file ownership or specification conformance. Changing the grouping returns to the tangle without starting motion.</p><p id="scope" class="scope" role="status">Loading source-bound snapshot</p><main class="workspace"><section id="untangle-view" class="map-region" aria-label="3D feature and code wool map"><div class="legend" aria-label="Legend"><span>Feature</span><span class="code">Code</span><span class="test">Test</span><span class="owner">Owner</span><span class="intent">Intent</span><span class="unmapped">Unassigned</span></div><div id="viewport" tabindex="0" role="region" aria-label="Interactive 3D feature map" aria-describedby="help"><svg id="map" xmlns="http://www.w3.org/2000/svg" role="group" aria-label="Feature, code and ownership relationships"></svg><div id="empty" class="empty" hidden><h2 id="empty-title"></h2><p id="empty-text"></p></div></div><div class="zoom" aria-label="Map zoom"><button id="zoom-out" type="button" aria-label="Zoom out">−</button><button id="zoom-reset" type="button">1:1</button><button id="zoom-in" type="button" aria-label="Zoom in">+</button></div><button id="untangle" class="untangle-action" type="button" aria-describedby="untangle-note">Untangle by feature</button><p id="untangle-note" class="untangle-note" role="status" aria-live="polite">Group the wool map by declared feature scopes. Code and metrics are unchanged.</p><p id="motion-note" class="sr">Rotation starts only on request, pauses after 90 seconds or when you interact, and stays off with reduced motion.</p><p id="help" class="sr">Drag or use arrow keys to rotate the 3D map. Hold Shift to pan. Use plus and minus to zoom. Select nodes with Tab and Enter; the same nodes are available in the list.</p></section><aside class="aside" aria-label="Details and accessible node list"><section id="detail" aria-live="polite"><h2>Follow a relationship. Inspect the full scope.</h2><p>Select a feature or file to inspect its complete measurements, test evidence and relationships.</p><p>Feature node size shows measured complexity. Spatial proximity is a layout choice, not evidence of semantic similarity or ownership.</p></section><details><summary>Measurement limits and open evidence</summary><ul id="issues"></ul></details><details id="group-index"><summary>Groups <span id="group-count"></span></summary><p id="group-note"></p><ul id="group-list"></ul></details><section><h3>Node list <span id="visible-count" class="muted"></span></h3><p id="list-note"></p><div id="node-list" class="node-list"></div></section></aside></main><footer><span id="ready">Local HTML · no external services</span> · Feature dependencies are declarations, not runtime calls. <span id="selected-status" class="sr" aria-live="polite"></span></footer><script type="application/json" id="map-data">${encoded}</script><script>${SCRIPT}</script></body></html>\n`;
}
