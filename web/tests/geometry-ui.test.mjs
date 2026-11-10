import test from 'node:test';
import assert from 'node:assert/strict';
import {geometryPanel,validateGeometryImport,GEOMETRY_PARAMETERS} from '../geometry-ui.mjs';
const sha='b'.repeat(64),box={x:.2,y:.2,width:.1,height:.1};
const doc=()=>({contentId:sha,pages:[{page:2,preview:'data:image/png;base64,dGVzdA=='}],fields:[{name:'preserve me'}]});
const result=()=>({schema_version:'geometry-1.0',document_sha256:sha,page:2,observations:[{id:'o1',raw_text:'9.50 ±0.20 mm',region:box}],parameters:[{key:'mounting_hole_diameter',label:'custom name',value_raw:'9.50 ±0.20',unit_raw:'mm',nominal_raw:'9.50',tolerance_raw:'±0.20',limit:null,annotation_region:box,object_region:{x:.4,y:.3,width:.15,height:.2},reason:'尺寸引线指向安装孔的内圆。',evidence_text:'9.50 ±0.20 mm',evidence_ids:['o1'],leader_points:[{x:.25,y:.25},{x:.47,y:.4}],status:'candidate'}]});
test('semantic import binds file and page, copies only candidate data, preserves source doc',()=>{
 const d=doc(),before=structuredClone(d),input=result(),r=validateGeometryImport(d,input);
 assert.deepEqual(d,before);assert.equal(r.parameters[0].label,'螺栓安装通孔内径');assert.equal(r.parameters[0].status,'candidate');assert.notEqual(r.parameters[0],input.parameters[0]);
 input.parameters[0].object_region.x=.8;assert.equal(r.parameters[0].object_region.x,.4);
 const other=result();other.document_sha256='a'.repeat(64);assert.throws(()=>validateGeometryImport(d,other),/SHA/);
 other.document_sha256=sha;other.page=1;assert.throws(()=>validateGeometryImport(d,other),/来源页/);
});
test('rejects invented values, units, bounds and engineering approvals',()=>{
 for(const mutate of [p=>p.nominal_raw='19.50',p=>p.unit_raw='inch',p=>p.tolerance_raw='±0.30',p=>p.object_region.width=1,p=>p.status='approved',p=>p.leader_points[0].x=1.5]){const r=result();mutate(r.parameters[0]);assert.throws(()=>validateGeometryImport(doc(),r));}
 const r=result();r.parameters[0].evidence_ids=['nonexistent'];assert.throws(()=>validateGeometryImport(doc(),r),/原文引用/);
});
test('never converts missing geometry into zero and does not mistake conductor area for insulation diameter',()=>{
 const r=result();r.parameters=[{key:'wire_insulation_diameter',status:'unknown',reason:'只有导体截面积，未识别绝缘外径。'}];
 const mapped=validateGeometryImport(doc(),r);assert.equal(mapped.parameters[0].value_raw,null);assert.equal(mapped.parameters[0].unit_raw,null);
 const html=geometryPanel({...doc(),geometryResult:mapped},'wire_insulation_diameter');assert.match(html,/只有导体截面积/);assert.match(html,/未识别/);assert(!/geometry-(?:card|detail)-value[^>]*>0(?:<|\s)/.test(html));
 const wrong=result();wrong.parameters[0].key='wire_insulation_diameter';wrong.parameters[0].value_raw='9.50 mm²';wrong.parameters[0].evidence_text='9.50 mm² ±0.20 mm';assert.throws(()=>validateGeometryImport(doc(),wrong),/截面积/);
});
test('only extracted cards link to regions while the full catalogue stays optional',()=>{
 const r=result();r.parameters.push({key:'wire_insulation_diameter',value_raw:'.120–.240',nominal_raw:null,unit_raw:null,tolerance_raw:null,limit:null,annotation_region:box,object_region:box,reason:'独立说明标出允许的绝缘层直径范围。',evidence_text:'INSULATION DIA .120–.240',status:'candidate'});
 const html=geometryPanel({...doc(),geometryResult:r},'wire_insulation_diameter');
 assert.equal(GEOMETRY_PARAMETERS.length,115);assert(html.includes('查看 115 类中文参数目录'));
 assert.equal((html.match(/data-geometry-key=/g)||[]).length,2);assert.match(html,/单位待确认/);assert.match(html,/\.120–\.240/);assert.match(html,/viewBox="0 0 1000 1000"/);assert.match(html,/geometry-annotation/);assert.match(html,/geometry-object/);assert.match(html,/geometry-leader/);assert.match(html,/preserveAspectRatio="none"/);
});
test('renders explicit lower/upper limit and diameter notation without deriving unprinted bounds',()=>{
 const r=result();let html=geometryPanel({...doc(),geometryResult:r});assert.match(html,/Ø 9.50/);assert(!html.includes('9.30'));
 r.parameters[0].key='insulation_length';r.parameters[0].limit='MIN';html=geometryPanel({...doc(),geometryResult:r});assert.match(html,/≥ 9.50/);
 r.parameters[0].key='total_length';r.parameters[0].limit='MAX';html=geometryPanel({...doc(),geometryResult:r});assert.match(html,/≤ 9.50/);
});
test('untrusted text stays escaped and missing/source-invalid results cannot look recognized',()=>{
 const r=result();r.parameters[0].reason='<script>alert(1)</script>';const d={...doc(),geometryResult:r};let html=geometryPanel(d);assert(!html.includes('<script>'));assert.match(html,/&lt;script&gt;/);
 d.pages[0].preview='javascript:alert(1)';html=geometryPanel(d);assert(!html.includes('src="javascript:'));assert.match(html,/请先导入/);
 d.geometryResult.document_sha256='a'.repeat(64);html=geometryPanel(d);assert.match(html,/SHA/);assert(!html.includes('Ø 9.50'));
});

test('high resolution transient preview uses its own rotation and zoom while metadata is whitelisted',()=>{
 const d=doc(),r=result();r.model='test-model';r.elapsed_seconds=1.2;r.api_key='must-not-copy';d.pages[0].rotation=90;d.geometryPreview={page:2,data:'data:image/png;base64,aGlyZXM=',rotation:0};d.geometryResult=r;
 const validated=validateGeometryImport(d,r);assert.equal(validated.model,'test-model');assert.equal(validated.elapsed_seconds,1.2);assert(!Object.hasOwn(validated,'api_key'));
 const html=geometryPanel(d);assert.match(html,/src="data:image\/png;base64,aGlyZXM="/);assert.match(html,/id="geometryZoom"/);assert.match(html,/value="1.5"/);assert.match(html,/geometry-image-viewport/);assert.match(html,/x="200" y="200"/);
 r.parameters[0].limit='max 12.5';assert.throws(()=>validateGeometryImport(d,r),/限值类型/);
});
