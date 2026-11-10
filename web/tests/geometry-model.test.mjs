import test from 'node:test';
import assert from 'node:assert/strict';
import {MODEL_TEMPLATES,dimensionInMm,suggestMapping,createConstrainedModel,modelSTL,modelSCAD,modelSVG,projectedModelSVG,compareGeometry,reconstructionPanel} from '../geometry-model.mjs';

const sha='d'.repeat(64);
const parameter=(key,nominal,extra={})=>({key,id:key,label:key,instance_label:'同一部位',component:'端子本体',view:'主视图',status:'candidate',nominal_raw:String(nominal),value_raw:`${nominal} mm`,unit_raw:'mm',tolerance_raw:null,limit:null,evidence_text:`原图明确标注 ${nominal} mm`,...extra});
const result=parameters=>({schema_version:'geometry-2.0',document_sha256:sha,page:2,parameters});
const boxResult=(height='3')=>result([parameter('total_length','30'),parameter('total_width','20'),parameter('total_height',height)]);
const ringResult=()=>result([parameter('tongue_width','13.49'),parameter('mounting_hole_diameter','8.33',{tolerance_raw:'±0.13'}),parameter('tongue_thickness','1.2')]);
const model=(r,template='ring')=>createConstrainedModel(r,{template,mapping:suggestMapping(r,template)});
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const volume=triangles=>triangles.reduce((s,[a,b,c])=>s+dot(a,cross(b,c))/6,0);
function watertight(triangles){
 const edges=new Map(),point=p=>p.map(v=>Object.is(v,-0)?'0':String(v)).join(',');
 for(const triangle of triangles){
  assert.equal(triangle.length,3);
  for(const p of triangle){assert.equal(p.length,3);assert(p.every(Number.isFinite));}
  assert(Math.hypot(...cross(sub(triangle[1],triangle[0]),sub(triangle[2],triangle[0])))>0,'no zero-area face');
  for(let i=0;i<3;i++){
   const a=point(triangle[i]),b=point(triangle[(i+1)%3]);assert.notEqual(a,b);
   const key=[a,b].sort().join('|'),entry=edges.get(key)||[];entry.push([a,b]);edges.set(key,entry);
  }
 }
 for(const directions of edges.values()){
  assert.equal(directions.length,2,'each edge must have exactly two incident faces');
  assert.deepEqual(directions[0],[directions[1][1],directions[1][0]],'adjacent faces must wind oppositely along shared edges');
 }
 assert(volume(triangles)>0,'outward winding must give positive volume');
}
function parseSTL(text){
 const vertices=[...text.matchAll(/^  vertex (.+)$/gm)].map(m=>m[1].split(' ').map(Number));
 const triangles=[];for(let i=0;i<vertices.length;i+=3)triangles.push(vertices.slice(i,i+3));
 const normals=[...text.matchAll(/^facet normal (.+)$/gm)].map(m=>m[1].split(' ').map(Number));
 assert.equal(normals.length,triangles.length);
 normals.forEach((normal,i)=>{assert(normal.every(Number.isFinite));assert(Math.abs(Math.hypot(...normal)-1)<1e-9);assert(dot(normal,cross(sub(triangles[i][1],triangles[i][0]),sub(triangles[i][2],triangles[i][0])))>0);});
 return triangles;
}

test('only a bounded, explicit candidate linear nominal may become millimetres',()=>{
 assert.equal(dimensionInMm(parameter('total_length','.5',{unit_raw:'in'})).value,12.7);
 assert.equal(dimensionInMm(parameter('total_length','2',{unit_raw:'毫米'})).value,2);
 for(const extra of [{status:'unknown'},{status:'not_provided'},{limit:'max'},{limit:'min'},{limit:'range'},{unit_raw:null},{unit_raw:'mm²'},{unit_raw:'AWG'},{unit_raw:'degree'}])assert.throws(()=>dimensionInMm(parameter('total_length','5',extra)));
 for(const nominal of ['0','-1','1e3','10–20','10 + 3','NaN','Infinity','100001','0.00000001'])assert.throws(()=>dimensionInMm(parameter('total_length',nominal)));
});

test('semantic parameter kind prevents tolerances, area, thread and composite labels becoming solids',()=>{
 for(const key of ['smd_pin_coplanarity','base_flatness_straightness','conductor_cross_section','thread_designation','bend_slot_angle','enamel_wire_outlet_size_angle'])assert.throws(()=>dimensionInMm(parameter(key,'2',{unit_raw:'mm'})),/尺寸|长度|类型|参数/);
 const r=ringResult();r.parameters[2]=parameter('smd_pin_coplanarity','.1');
 const m=createConstrainedModel(r,{template:'ring',mapping:{outer:'tongue_width',inner:'mounting_hole_diameter',height:'smd_pin_coplanarity'}});
 assert.equal(m.status,'blocked');assert.deepEqual(m.triangles,[]);
});

test('suggestions do not choose between repeated instances and use current tube taxonomy',()=>{
 const r=ringResult();r.parameters.push(parameter('mounting_hole_diameter','5',{id:'second-hole'}));
 assert.equal(suggestMapping(r,'ring').inner,undefined);
 const tube=result([parameter('crimp_barrel_outer_diameter','5'),parameter('crimp_barrel_inner_diameter','3'),parameter('crimp_barrel_length','10')]);
 assert.deepEqual(suggestMapping(tube,'tube'),{outer:'crimp_barrel_outer_diameter',inner:'crimp_barrel_inner_diameter',height:'crimp_barrel_length'});
 assert.equal(model(tube,'tube').status,'reference_only');
});

test('missing thickness, limit-only length and unitless diameter block generation and exports',()=>{
 const cases=[ringResult(),boxResult(),ringResult()];cases[0].parameters.pop();cases[1].parameters[0].limit='max';cases[2].parameters[1].unit_raw=null;
 cases.forEach((r,i)=>{const m=model(r,i===1?'box':'ring');assert.equal(m.status,'blocked');assert.deepEqual(m.triangles,[]);assert.throws(()=>modelSTL(m));assert.throws(()=>modelSCAD(m));assert.equal(modelSVG(m),'');assert.equal(projectedModelSVG(m),'');});
});

test('same annotation, contradictory radii and dimensions from different components cannot form a solid',()=>{
 const r=ringResult();
 const reused=createConstrainedModel(r,{template:'ring',mapping:{outer:'tongue_width',inner:'tongue_width',height:'tongue_thickness'}});assert.equal(reused.status,'blocked');assert.match(reused.issues.join(' '),/重复/);
 for(const diameter of ['13.49','14','13.489999999']){const rr=ringResult();rr.parameters[1].nominal_raw=diameter;assert.equal(model(rr).status,'blocked');}
 r.parameters[2].component='独立塑料外壳';assert.equal(model(r).status,'blocked');assert.match(model(r).issues.join(' '),/不同部件/);
});

test('model preserves source identity, unit conversion and tolerance without granting approval',()=>{
 const r=boxResult();r.parameters[0]=parameter('total_length','1',{unit_raw:'in',value_raw:'1.00 ±.01 IN',tolerance_raw:'±.01',evidence_text:'1.00 ±.01 IN'});const before=structuredClone(r),m=model(r,'box');
 assert.deepEqual(r,before);assert.equal(m.document_sha256,sha);assert.equal(m.page,2);assert.equal(m.units,'mm');assert.equal(m.dimensions.length,25.4);assert.equal(m.engineering_approval,false);assert.equal(m.status,'reference_only');
 const s=m.sources.find(s=>s.slot==='length');assert.equal(s.parameter_id,'total_length');assert.equal(s.source_page,2);assert.equal(s.conversion_factor_to_mm,25.4);assert.equal(s.tolerance_raw,'±.01');assert.equal(s.evidence_text,'1.00 ±.01 IN');assert.equal(s.component,'端子本体');assert.match(m.assumptions.join(' '),/不模拟公差/);
});

test('box mesh and exported STL are closed, consistently oriented and have exact positive volume',()=>{
 const m=model(boxResult(),'box');assert.equal(m.triangles.length,12);watertight(m.triangles);assert.equal(volume(m.triangles),30*20*3);
 const mesh=parseSTL(modelSTL(m));watertight(mesh);assert.equal(volume(mesh),1800);assert.match(modelSCAD(m),/cube\(\[30,20,3\]\)/);
});

test('annulus and tube stay hollow, watertight and outward-facing after STL serialization',()=>{
 const r=ringResult(),tube=result([parameter('crimp_barrel_outer_diameter','10'),parameter('crimp_barrel_inner_diameter','6'),parameter('crimp_barrel_length','12')]);
 for(const m of [model(r),model(tube,'tube')]){
  assert.equal(m.triangles.length,512);watertight(m.triangles);watertight(parseSTL(modelSTL(m)));
  const analytic=Math.PI*(m.dimensions.outer**2-m.dimensions.inner**2)*m.dimensions.height/4;
  assert(Math.abs(volume(m.triangles)/analytic-1)<.002,'64-sided circle approximation stays within 0.2% volume');
  for(const triangle of m.triangles){const centroid=triangle.reduce((s,p)=>s.map((v,i)=>v+p[i]/3),[0,0,0]);const normal=cross(sub(triangle[1],triangle[0]),sub(triangle[2],triangle[0]));if(Math.abs(normal[2])>1e-9)continue;const radii=triangle.map(p=>Math.hypot(p[0],p[1]));const radial=dot(normal,[centroid[0],centroid[1],0]);if(Math.abs(radii[0]-m.dimensions.outer/2)<1e-8)assert(radial>0);else assert(radial<0,'inner wall normals must face the hole');}
  assert.match(modelSCAD(m),/difference\(\)/);assert.match(modelSCAD(m),/非制造模型/);
 }
});

test('minimum accepted dimensions do not round to zero in exports',()=>{
 const m=model(boxResult('0.00001'),'box');assert.equal(m.status,'reference_only');const triangles=parseSTL(modelSTL(m));watertight(triangles);assert(Math.abs(volume(triangles)-.006)<1e-12);assert.match(modelSCAD(m),/0\.00001/);
});

test('2D non-square envelope dimensions follow their actual axes and 3D rotation changes projection',()=>{
 const m=model(boxResult(),'box'),svg=modelSVG(m);
 assert.match(svg,/长 30/);assert.match(svg,/宽 20/);assert.match(svg,/高度\/轴向长度 3/);
 const width=svg.match(/<path d="M([\d.e+-]+),([\d.e+-]+)v([\d.e+-]+)"[^>]+\/><text transform="translate\([^)]+\) rotate\(-90\)"[^>]*>宽 20<\/text>/);assert(width,'width uses vertical endpoints and rotated label');assert(Math.abs(Number(width[3])-20*230/30)<1e-9);
 assert.notEqual(projectedModelSVG(m,0,45),projectedModelSVG(m,70,45));assert.throws(()=>projectedModelSVG(m,NaN));assert.throws(()=>projectedModelSVG(m,0,Infinity));assert.match(svg,/非制造图/);
});

test('display text and labels cannot insert markup or geometry commands',()=>{
 const r=boxResult();r.parameters[0].label='<script>bad()</script>';r.parameters[0].evidence_text='<img src=x onerror=bad()>';
 const html=reconstructionPanel(r,{template:'box'});assert(!html.includes('<script>'));assert(!html.includes('<img src=x'));assert.match(html,/&lt;script&gt;/);assert.match(html,/&lt;img src=x/);
 const m=model(r,'box');m.template_label='<svg onload=bad()>';assert(!modelSVG(m).includes('<svg onload'));assert(!projectedModelSVG(m).includes('<svg onload'));
 r.parameters[0].nominal_raw='1]); import("evil.stl");';assert.equal(model(r,'box').status,'blocked');
});

test('reuse comparison distinguishes unit-normalized nominals from engineering compatibility',()=>{
 const a=result([parameter('total_length','1',{unit_raw:'in'})]),b=result([parameter('total_length','25.4')]);let [row]=compareGeometry(a,b);assert.equal(row.status,'nominal_equal');assert.equal(row.delta_mm,0);assert.match(row.message,/公差与工艺仍待确认/);
 b.parameters[0].nominal_raw='25.5';[row]=compareGeometry(a,b);assert.equal(row.status,'different');assert(Math.abs(row.delta_mm-.1)<1e-12);
 b.parameters[0].limit='max';assert.equal(compareGeometry(a,b)[0].status,'unresolved');b.parameters[0].limit=null;b.parameters.push(parameter('total_length','25.4',{id:'other'}));assert.equal(compareGeometry(a,b)[0].status,'ambiguous');
 assert.equal(compareGeometry(a,result([]))[0].status,'ambiguous');
});
