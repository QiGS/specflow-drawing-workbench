import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {GEOMETRY_PARAMETERS,geometryPanel,validateGeometryImport} from '../geometry-ui.mjs';
const sha='c'.repeat(64),box={x:.1,y:.2,width:.1,height:.1};
const doc=()=>({contentId:sha,pages:[{page:1,text:'',preview:'data:image/png;base64,dGVzdA=='}],fields:[]});
const candidate=(id,key='mounting_hole_diameter',value='4.20')=>({id,key,instance_label:'左侧螺栓安装孔',component:'端子主体',view:'俯视图',status:'candidate',value_raw:value,nominal_raw:value,unit_raw:'mm',tolerance_raw:null,limit:null,annotation_region:box,object_region:box,leader_points:[{x:.2,y:.3},{x:.4,y:.3}],reason:'尺寸箭头指向左侧安装孔的内圆。',evidence_text:value+' mm',evidence_ids:[id+'_o']});
const result=()=>{const p=candidate('left');return {schema_version:'geometry-2.0',document_sha256:sha,page:1,part_description:'两端带安装孔的连接端子',parameters:[p],observations:[{id:'left_o',raw_text:'4.20 mm',region:box}],unmapped_annotations:[]};};
function add(r,p){r.parameters.push(p);r.observations.push({id:p.evidence_ids[0],raw_text:p.evidence_text,region:box});return r;}
test('115 category catalogue is complete, unique and matches the shared backend file',async()=>{
 const source=JSON.parse(await readFile(new URL('../parameter-catalog.json',import.meta.url),'utf8'));
 assert.deepEqual(GEOMETRY_PARAMETERS,source);assert.equal(GEOMETRY_PARAMETERS.length,115);
 assert.equal(new Set(GEOMETRY_PARAMETERS.map(d=>d.key)).size,115);
 assert.deepEqual(GEOMETRY_PARAMETERS.map(d=>d.id),Array.from({length:115},(_,i)=>i+1));
 for(const d of GEOMETRY_PARAMETERS){assert.match(d.label,/[\u3400-\u9fff]/u);assert.match(d.group,/[\u3400-\u9fff]/u);}
});
test('same semantic dimension on separate parts remains two independent selectable instances',()=>{
 const r=result(),right=candidate('right','mounting_hole_diameter','5.10');right.instance_label='右侧螺栓安装孔';right.component='另一端子';right.reason='尺寸箭头指向右侧安装孔的内圆。';add(r,right);
 const validated=validateGeometryImport(doc(),r);assert.equal(validated.parameters.length,2);assert.equal(validated.parameters[0].id,'left');assert.equal(validated.parameters[1].id,'right');
 const html=geometryPanel({...doc(),geometryResult:r},'right');assert.match(html,/data-geometry-id="right"[^>]*aria-pressed="true"/);assert.match(html,/左侧螺栓安装孔/);assert.match(html,/右侧螺栓安装孔/);assert.equal((html.match(/data-geometry-key="mounting_hole_diameter"/g)||[]).length,2);
 r.parameters[1].id='left';assert.throws(()=>validateGeometryImport(doc(),r),/重复/);
});
test('new dimensions outside the old six display Chinese names, groups and limit labels',()=>{
 const r=result(),p=candidate('pitch','terminal_pitch','2.50');p.instance_label='第一排相邻引脚';p.reason='尺寸界线连接第一排相邻引脚中心。';p.value_raw='2.50 MAX';p.limit='max';p.evidence_text='2.50 MAX mm';add(r,p);
 const t=candidate('thickness','material_thickness','0.80');t.instance_label='端子料厚';t.reason='技术说明明确给出材料的标称厚度。';t.evidence_text='MATERIAL THICKNESS 0.80 mm';t.evidence_mode='explicit_note';t.object_region=null;t.leader_points=[];add(r,t);
 const parsed=validateGeometryImport(doc(),r);assert.equal(parsed.parameters.length,3);
 const html=geometryPanel({...doc(),geometryResult:r},'pitch');assert.match(html,/端子引脚间距 \/ 节距/);assert.match(html,/材料厚度 \/ 料厚/);assert.match(html,/≤ 2.50/);assert.match(html,/最大值/);assert.match(html,/上限/);assert.match(html,/<details class="geometry-evidence">/);
});
test('search and category filter operate on actual measured instances and preserve optional catalogue',()=>{
 const r=result(),p=candidate('pitch','terminal_pitch','2.50');p.instance_label='引脚相邻中心';p.reason='尺寸界线连接该排相邻的引脚中心。';add(r,p);
 const d={...doc(),geometryResult:r},html=geometryPanel(d,'',{query:'节距'});
 assert.match(html,/data-geometry-id="pitch"/);assert(!html.includes('data-geometry-id="left"'));assert.match(html,/显示 1 \/ 2 项候选/);
 const filtered=geometryPanel(d,'',{group:'间距与阵列'});assert.match(filtered,/data-geometry-id="pitch"/);assert(!filtered.includes('data-geometry-id="left"'));
});
test('missing, not applicable and ambiguous states never supply invented numeric cards',()=>{
 const r=result();r.parameters=[{...candidate('missing','tongue_thickness'),status:'not_provided',value_raw:null,nominal_raw:null,unit_raw:null,tolerance_raw:null,limit:null,annotation_region:null,object_region:null,leader_points:[],evidence_text:'',evidence_ids:[],reason:'当前视图未提供舌片厚度的尺寸标注。'}];
 const parsed=validateGeometryImport(doc(),r);assert.equal(parsed.parameters[0].status,'not_provided');const html=geometryPanel({...doc(),geometryResult:r});assert(!html.includes('data-geometry-id='));assert.match(html,/图纸未提供/);assert.match(html,/未识别、未提供及不适用/);
 r.parameters[0].value_raw='0';assert.throws(()=>validateGeometryImport(doc(),r),/不能同时给出数值/);
});
test('notes need an actual named property; area cannot become diameter and a unit declaration is not enough',()=>{
 const r=result(),p=r.parameters[0];p.evidence_mode='explicit_note';p.object_region=null;p.leader_points=[];assert.throws(()=>validateGeometryImport(doc(),r),/明确参数名称/);
 p.key='wire_insulation_diameter';p.instance_label='适配导线绝缘外径';p.nominal_raw=null;p.value_raw='2.62–6.64 mm²';p.unit_raw='mm²';p.limit='range';p.evidence_text='WIRE INSULATION DIA 2.62–6.64 mm²';r.observations[0].raw_text=p.evidence_text;assert.throws(()=>validateGeometryImport(doc(),r),/截面积/);
 p.key='conductor_cross_section';p.evidence_text='WIRE SIZE 2.62–6.64 mm²';r.observations[0].raw_text=p.evidence_text;assert.equal(validateGeometryImport(doc(),r).parameters[0].unit_raw,'mm²');
 p.unit_raw='mm';assert.throws(()=>validateGeometryImport(doc(),r),/单位/);
});
test('unmapped annotations preserve real text and bounds without pretending to classify them',()=>{
 const r=result();r.observations.push({id:'unmapped_o',raw_text:'R 1.25',region:box});r.unmapped_annotations=[{id:'unmapped_1',raw_text:'R 1.25',reason:'该半径标注的引线终点暂无法确定。',region:box,evidence_ids:['unmapped_o']}];
 const parsed=validateGeometryImport(doc(),r);assert.equal(parsed.unmapped_annotations.length,1);const html=geometryPanel({...doc(),geometryResult:r});assert.match(html,/已读出、尚未归类的标注 · 1 处/);assert.match(html,/R 1.25/);
 r.unmapped_annotations[0].raw_text='R 2.25';assert.throws(()=>validateGeometryImport(doc(),r),/引用不符/);
});
test('rejects fabricated evidence, translation-only English prose, unsupported limits and source-less units',()=>{
 for(const mutate of [p=>p.reason='This is a mounting hole.',p=>p.instance_label='left mounting hole',p=>p.status='approved',p=>p.nominal_raw='9.50',p=>p.limit='max',p=>p.evidence_text='孔直径 4.20 mm',p=>p.unit_raw='in',p=>p.evidence_ids=[]]){const r=result();mutate(r.parameters[0]);assert.throws(()=>validateGeometryImport(doc(),r));}
 const r=result();r.api_key='secret';r.parameters[0].label='English hallucination';r.parameters[0].confidence=1;
 const out=validateGeometryImport(doc(),r);assert.equal(out.parameters[0].label,'螺栓安装通孔内径');assert(!Object.hasOwn(out,'api_key'));assert(!Object.hasOwn(out.parameters[0],'confidence'));
});
test('all generated HTML escapes untrusted Chinese context, filters, and evidence',()=>{
 const r=result();r.parameters[0].instance_label='<img src=x onerror=alert(1)>左孔';r.parameters[0].reason='左孔的尺寸说明<script>alert(1)</script>';const html=geometryPanel({...doc(),geometryResult:r},'left',{query:'" autofocus onfocus="alert(1)'});
 assert(!html.includes('<script>'));assert(!html.includes('<img src=x'));assert.match(geometryPanel({...doc(),geometryResult:r},'left'),/&lt;script&gt;/);assert.match(html,/&quot; autofocus/);
});
test('a visibly conflicting endpoint description cannot relabel a hole-centre distance as overall length',()=>{
 const r=result();Object.assign(r.parameters[0],{key:'total_length',instance_label:'端面至孔中心距离',reason:'尺寸界线从接线筒后端至孔中心。'});assert.throws(()=>validateGeometryImport(doc(),r),/孔中心距离/);
});
test('local note enrichment preserves provenance and does not claim a fresh model inference',()=>{
 const r=result();Object.assign(r.parameters[0],{key:'material_thickness',instance_label:'材料厚度',evidence_mode:'explicit_note',object_region:null,leader_points:[],reason:'材料说明直接标明该零件的材料厚度。',evidence_text:'MATERIAL THICKNESS 4.20 mm'});r.observations[0].raw_text='MATERIAL THICKNESS 4.20 mm';r.processing_method='local_explicit_note_enrichment';r.added_parameter_ids=['left'];r.model='historic-model';r.elapsed_seconds=30;
 const parsed=validateGeometryImport(doc(),r);assert.equal(parsed.processing_method,'local_explicit_note_enrichment');assert.deepEqual(parsed.added_parameter_ids,['left']);assert.equal(parsed.model,'historic-model');
 const restored=validateGeometryImport(doc(),JSON.parse(JSON.stringify(parsed)));assert.deepEqual(restored.added_parameter_ids,['left']);
 const html=geometryPanel({...doc(),geometryResult:restored},'left');assert.match(html,/本次没有调用外部模型/);assert.match(html,/本地文字规则 · 明确标签/);assert(!html.includes('新模型已识别'));
 for(const ids of [['not_in_result'],['left','left']]){const bad=structuredClone(r);bad.added_parameter_ids=ids;assert.throws(()=>validateGeometryImport(doc(),bad),/本地补充来源引用/);}
 const leader=result();leader.processing_method='local_explicit_note_enrichment';leader.added_parameter_ids=['left'];assert.throws(()=>validateGeometryImport(doc(),leader),/本地补充来源引用|明确文字|文字说明/);
 const bad=structuredClone(r);bad.processing_method='fresh_cloud_inference';assert.throws(()=>validateGeometryImport(doc(),bad),/处理来源类型/);
});
