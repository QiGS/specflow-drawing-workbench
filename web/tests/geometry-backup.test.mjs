import test from 'node:test';
import assert from 'node:assert/strict';
import {restoreBackup} from '../backup.mjs';
const sha='a'.repeat(64);
const doc=()=>({name:'test.pdf',contentId:sha,pages:[{page:1,text:''}],fields:[],bom:[],history:[],warnings:[],geometryResult:{schema_version:'geometry-1.0',document_sha256:sha,page:1,observations:[],parameters:[{key:'total_length',status:'candidate',value_raw:'7.20 MAX mm',nominal_raw:'7.20',unit_raw:'mm',limit:'max',tolerance_raw:null,annotation_region:{x:.1,y:.2,width:.2,height:.1},object_region:null,reason:'尺寸界线横跨两端，尚需核对对象。',evidence_text:'7.20 MAX mm'}]}});
test('geometry backup keeps pending semantic candidates and rejects foreign document source',()=>{
 const d=doc(),[restored]=restoreBackup({version:1,documents:[d]});assert.equal(restored.geometryResult.parameters[0].nominal_raw,'7.20');assert.equal(restored.geometryResult.parameters[0].status,'candidate');
 d.geometryResult.document_sha256='b'.repeat(64);assert.throws(()=>restoreBackup({version:1,documents:[d]}),/SHA/);
});
test('geometry v2 backup retains repeated parameter instances and unmapped evidence',()=>{
 const d=doc(),p=d.geometryResult.parameters[0];
 d.geometryResult.schema_version='geometry-2.0';
 Object.assign(p,{id:'body_length',instance_label:'主体总长度',component:'连接端子',view:'俯视图',evidence_mode:'leader',object_region:{x:.2,y:.2,width:.3,height:.2},leader_points:[{x:.1,y:.3},{x:.5,y:.3}],evidence_ids:['length_text']});
 d.geometryResult.observations=[{id:'length_text',raw_text:'7.20 MAX mm',region:p.annotation_region},{id:'unmapped_text',raw_text:'R 0.30',region:p.annotation_region}];
 d.geometryResult.unmapped_annotations=[{id:'unmapped_r',raw_text:'R 0.30',reason:'半径标注的终点部位无法可靠确认。',region:p.annotation_region,evidence_ids:['unmapped_text']}];
 const [restored]=restoreBackup({version:1,documents:[d]});
 assert.equal(restored.geometryResult.schema_version,'geometry-2.0');assert.equal(restored.geometryResult.parameters[0].id,'body_length');assert.equal(restored.geometryResult.unmapped_annotations[0].raw_text,'R 0.30');
});
