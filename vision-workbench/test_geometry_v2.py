import copy
import json
import unittest
from geometry import validate as dispatch_validate
from geometry_v2 import CATALOG, VERSION, validate

SHA='c'*64
BOX={'x':.1,'y':.2,'width':.2,'height':.1}

def candidate(**kwargs):
    p=dict(id='hole_front',key='mounting_hole_diameter',instance_label='前端螺栓安装孔',status='candidate',
      value_raw='8.33 ±0.13 DIA',nominal_raw='8.33',unit_raw='mm',tolerance_raw='±0.13',limit=None,
      annotation_region=BOX,object_region=BOX,leader_points=[{'x':.2,'y':.3},{'x':.4,'y':.3}],
      reason='直径标注的引线指向前端安装孔内圆。',evidence_text='8.33 ±0.13 DIA\nDIMENSIONS IN mm',evidence_ids=['dim','unit'])
    p.update(kwargs)
    return p

def fixture():
    obs={'dim':{'id':'dim','raw_text':'8.33 ±0.13 DIA','origin':'stage_one'},'unit':{'id':'unit','raw_text':'DIMENSIONS IN mm','origin':'stage_one'}}
    payload={'schema_version':VERSION,'observations':[],'parameters':[candidate()],'unmapped_annotations':[],'part_description':'带绝缘套的环形接线端子。'}
    return payload,obs

class SemanticGeometryTests(unittest.TestCase):
    def test_catalog_covers_all_user_ids_and_stable_legacy_keys(self):
        self.assertEqual([p['id'] for p in CATALOG],list(range(1,116)))
        self.assertEqual(len({p['key'] for p in CATALOG}),115)
        for index,key in {1:'tongue_width',2:'tongue_thickness',3:'mounting_hole_diameter',4:'noncontact_length',9:'wire_insulation_diameter',10:'conductor_cross_section',11:'insulation_length',38:'total_length'}.items():
            self.assertEqual(CATALOG[index-1]['key'],key)
        for p in CATALOG:
            self.assertTrue(p['label']);self.assertTrue(p['description']);self.assertTrue(p['group'])
    def test_sparse_catalog_does_not_claim_all115_are_recognized(self):
        p,obs=fixture();before=copy.deepcopy(obs)
        result=dispatch_validate(p,obs,SHA,1)
        self.assertEqual(len(result['parameters']),1)
        self.assertEqual(result['parameters'][0]['label'],'螺栓安装通孔内径')
        self.assertEqual(result['parameters'][0]['catalog_id'],3)
        self.assertEqual(result['parameters'][0]['evidence_mode'],'leader')
        self.assertTrue(result['human_review_required']);self.assertEqual(obs,before)
        p['parameters']=[];self.assertEqual(validate(p,obs,SHA,1)['parameters'],[])
    def test_same_category_distinct_objects_survive_and_duplicate_ids_rejected(self):
        p,obs=fixture();p['parameters'].append(candidate(id='hole_rear',instance_label='后端螺栓安装孔',component='后端端子',view='后视图'))
        self.assertEqual(len(validate(p,obs,SHA,1)['parameters']),2)
        p['parameters'][1]['id']='hole_front'
        with self.assertRaisesRegex(ValueError,'duplicated'):validate(p,obs,SHA,1)
    def test_missing_states_cannot_hide_numeric_values(self):
        for status in ('not_provided','not_applicable','ambiguous'):
            p,obs=fixture();p['parameters']=[candidate(status=status,value_raw=None,nominal_raw=None,unit_raw=None,tolerance_raw=None,annotation_region=None,object_region=None,leader_points=[],evidence_text='',evidence_ids=[],reason='该部位缺少可以独立确认的标注。')]
            self.assertEqual(validate(p,obs,SHA,1)['parameters'][0]['status'],status)
            p['parameters'][0]['value_raw']='0'
            with self.assertRaisesRegex(ValueError,'inferred'):validate(p,obs,SHA,1)
    def test_chinese_semantics_english_verbatim_source(self):
        p,obs=fixture();r=validate(p,obs,SHA,1)
        self.assertEqual(r['parameters'][0]['evidence_text'],'8.33 ±0.13 DIA\nDIMENSIONS IN mm')
        for name,value in [('reason','Visible leader points at inner circle'),('instance_label','mounting hole'),('view','Top view')]:
            p,obs=fixture();p['parameters'][0][name]=value
            with self.assertRaisesRegex(ValueError,'Chinese'):validate(p,obs,SHA,1)
    def test_explicit_tongue_thickness_and_area_notes_without_fake_object(self):
        p,obs=fixture();obs['note']={'id':'note','raw_text':'TONGUE MATERIAL THK: 1.02 ±0.05 mm'}
        p['parameters']=[candidate(id='thickness',key='tongue_thickness',instance_label='舌片材料厚度',value_raw='1.02 ±0.05',nominal_raw='1.02',unit_raw='mm',tolerance_raw='±0.05',evidence_mode='explicit_note',object_region=None,leader_points=[],reason='技术说明明确标出舌片材料厚度及其公差。',evidence_text=obs['note']['raw_text'],evidence_ids=['note'])]
        self.assertIsNone(validate(p,obs,SHA,1)['parameters'][0]['object_region'])
        obs['area']={'id':'area','raw_text':'CIRCULAR MIL AREA 2.62-6.64mm²'}
        p['parameters']=[candidate(id='area',key='conductor_cross_section',instance_label='适用导体截面积范围',value_raw='2.62-6.64mm²',nominal_raw=None,unit_raw='mm²',tolerance_raw=None,limit='range',evidence_mode='explicit_note',object_region=None,leader_points=[],reason='导体截面积说明给出毫米平方范围。',evidence_text=obs['area']['raw_text'],evidence_ids=['area'])]
        self.assertEqual(validate(p,obs,SHA,1)['parameters'][0]['unit_raw'],'mm²')
        p['parameters'][0]['key']='wire_insulation_diameter'
        with self.assertRaisesRegex(ValueError,'Area/gauge'):validate(p,obs,SHA,1)
    def test_mm_not_sourced_from_mm_squared_and_no_guessed_inches(self):
        p,obs=fixture();obs['dim']['raw_text']='8.33 ±0.13 mm²';p['parameters'][0].update(evidence_text=obs['dim']['raw_text'],evidence_ids=['dim'])
        with self.assertRaisesRegex(ValueError,'Unit'):validate(p,obs,SHA,1)
        p,obs=fixture();obs['wire']={'id':'wire','raw_text':'WIRE INSULATION DIA .150-.250'}
        p['parameters']=[candidate(key='wire_insulation_diameter',value_raw='.150-.250',nominal_raw=None,unit_raw=None,tolerance_raw=None,limit='range',evidence_mode='explicit_note',object_region=None,leader_points=[],evidence_text=obs['wire']['raw_text'],evidence_ids=['wire'])]
        self.assertIsNone(validate(p,obs,SHA,1)['parameters'][0]['unit_raw'])
        p['parameters'][0]['unit_raw']='in'
        with self.assertRaisesRegex(ValueError,'Unit'):validate(p,obs,SHA,1)
    def test_textual_mode_requires_actual_semantic_label(self):
        p,obs=fixture();p['parameters'][0].update(evidence_mode='explicit_note',object_region=None,leader_points=[])
        with self.assertRaisesRegex(ValueError,'does not name'):validate(p,obs,SHA,1)
    def test_fresh_transcriptions_unmapped_dimensions_preserve_source(self):
        p,obs=fixture();p['observations']=[{'id':'extra','raw_text':'17.50 ±0.20','region':BOX}]
        p['unmapped_annotations']=[dict(id='unmapped1',raw_text='17.50 ±0.20',reason='尺寸可读，但界线的适用对象尚不明确。',region=BOX,evidence_ids=['extra'])]
        r=validate(p,obs,SHA,1)
        self.assertEqual(r['observations'][-1]['origin'],'stage_two_model_transcription')
        self.assertEqual(r['unmapped_annotations'][0]['raw_text'],'17.50 ±0.20')
        p['unmapped_annotations'][0]['raw_text']='18.50 ±0.20'
        with self.assertRaisesRegex(ValueError,'quote'):validate(p,obs,SHA,1)
    def test_rejects_inventions_invalid_coordinates_limits_and_approvals(self):
        changes=[{'value_raw':'88.33 ±0.13 DIA','nominal_raw':'88.33'},{'tolerance_raw':'±0.14'},{'unit_raw':'inch'}, {'status':'approved'}, {'limit':'max'}, {'object_region':dict(BOX,x=1)}, {'leader_points':[{'x':True,'y':.2}]}, {'evidence_ids':['no_such_id']}, {'key':'not_in_catalog'}]
        for change in changes:
            p,obs=fixture();p['parameters'][0].update(change)
            with self.subTest(change=change),self.assertRaises(ValueError):validate(p,obs,SHA,1)
    def test_thread_and_compound_values_do_not_force_false_nominal(self):
        p,obs=fixture();obs['thread']={'id':'thread','raw_text':'THREAD M6x1-6H'}
        p['parameters']=[candidate(id='thread',key='thread_designation',instance_label='紧固螺纹规格',value_raw='M6x1-6H',nominal_raw=None,unit_raw=None,tolerance_raw=None,evidence_mode='explicit_note',object_region=None,leader_points=[],evidence_text='THREAD M6x1-6H',evidence_ids=['thread'],reason='螺纹说明给出完整规格与精度代号。')]
        self.assertEqual(validate(p,obs,SHA,1)['parameters'][0]['nominal_raw'],None)
    def test_original_sha_page_and_no_transcription_overwrites(self):
        p,obs=fixture()
        for sha,page in [('wrong',1),(SHA,True),(SHA,0)]:
            with self.assertRaises(ValueError):validate(p,obs,sha,page)
        p['observations']=[{'id':'dim','raw_text':'9.5','region':BOX}]
        with self.assertRaisesRegex(ValueError,'overwrite'):validate(p,obs,SHA,1)

class GeometryImageInputTests(unittest.TestCase):
    def test_zoom_tiles_are_exact_source_crops_with_fullpage_coordinates(self):
        import io
        from PIL import Image
        from geometry import geometry_images
        from provider import Config
        image=Image.new('RGB',(101,81),'white')
        image.putpixel((50,40),(10,20,30))
        out=io.BytesIO();image.save(out,format='PNG')
        config=Config(model='qwen3.8-max',api_key='test')
        pairs=geometry_images(out.getvalue(),config)
        self.assertEqual(len(pairs),5)
        self.assertEqual(pairs[0][0]['image_id'],'full_page')
        for source,data in pairs[1:]:
            r=source['source_region'];x=round(r['x']*101);y=round(r['y']*81)
            with Image.open(io.BytesIO(data)) as tile:
                self.assertEqual(tile.size,tuple(source['size']))
                self.assertEqual(tile.getpixel((50-x,40-y)),(10,20,30))
        self.assertEqual(len(geometry_images(out.getvalue(),Config(model='qwen3.8-max',api_key='test',max_images=1))),1)
        with self.assertRaisesRegex(ValueError,'payload'):
            geometry_images(out.getvalue(),Config(model='qwen3.8-max',api_key='test',max_image_payload_bytes=1))
    def test_direct_original_call_needs_no_fake_stage_and_records_actual_images(self):
        import io
        from PIL import Image
        from geometry import run_prepared
        from provider import Config
        image=Image.new('RGB',(100,80),'white');out=io.BytesIO();image.save(out,format='PNG')
        def transport(url,headers,body,timeout):
            request=json.loads(body);content=request['messages'][1]['content'];context=json.loads(content[0]['text'])
            self.assertFalse(context['stage_one_used']);self.assertEqual(context['stage_one_observations'],[])
            self.assertEqual(len(context['parameter_catalog']),115)
            self.assertEqual(sum(part['type']=='image_url' for part in content),5)
            response={'schema_version':VERSION,'observations':[],'parameters':[],'unmapped_annotations':[]}
            return 200,json.dumps({'choices':[{'finish_reason':'stop','message':{'content':json.dumps(response)}}]}).encode()
        result,audit=run_prepared(Config(model='qwen3.8-max',api_key='test'),out.getvalue(),SHA,transport=transport)
        self.assertFalse(audit['stage_one_used']);self.assertEqual(len(audit['image_sources']),5)
        self.assertEqual(result['document_sha256'],SHA)

if __name__=='__main__':unittest.main()
