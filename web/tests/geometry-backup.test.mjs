import test from 'node:test';
import assert from 'node:assert/strict';
import {restoreBackup} from '../backup.mjs';
const sha='a'.repeat(64);
const doc=()=>({name:'test.pdf',contentId:sha,pages:[{page:1,text:''}],fields:[],bom:[],history:[],warnings:[],geometryResult:{schema_version:'geometry-1.0',document_sha256:sha,page:1,observations:[],parameters:[{key:'total_length',status:'candidate',value_raw:'7.20 MAX mm',nominal_raw:'7.20',unit_raw:'mm',limit:'max',tolerance_raw:null,annotation_region:{x:.1,y:.2,width:.2,height:.1},object_region:null,reason:'尺寸界线横跨两端，尚需核对对象。',evidence_text:'7.20 MAX mm'}]}});
test('geometry backup keeps pending semantic candidates and rejects foreign document source',()=>{
 const d=doc(),[restored]=restoreBackup({version:1,documents:[d]});assert.equal(restored.geometryResult.parameters[0].nominal_raw,'7.20');assert.equal(restored.geometryResult.parameters[0].status,'candidate');
 d.geometryResult.document_sha256='b'.repeat(64);assert.throws(()=>restoreBackup({version:1,documents:[d]}),/SHA/);
});
