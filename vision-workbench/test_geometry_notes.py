import copy
import unittest
from geometry_notes import enrich, full_region
from geometry_v2 import VERSION

SHA='e'*64
BOX={'x':.2,'y':.3,'width':.25,'height':.05}


def fixture(texts):
    source={'image_id':'page1','document_sha256':SHA,'page':1,'roi_normalized':{'x':0,'y':0,'width':1,'height':1},'rotation_clockwise':0}
    observations=[{'id':f'obs_{i}','kind':'visible_text','raw_text':text,'region':dict(BOX,coordinate_space='supplied_image_normalized_top_left',basis='model_estimate_unreviewed'),'legibility':'clear','image_id':'page1'} for i,text in enumerate(texts)]
    stage={'status':'valid_unreviewed','validation':{'schema_valid':True,'reference_links_valid':True},'sources':[source], 'payload':{'schema_version':'1.0','operation':'extract_page','raw_text':'\n'.join(texts),'observations':observations,'fields':[],'bom':[],'missing_information':[],'warnings':[],'image_texts':[{'image_id':'page1','raw_text':'\n'.join(texts),'legibility':'clear'}]}}
    prev={'schema_version':VERSION,'document_sha256':SHA,'page':1,'observations':[],'parameters':[],'unmapped_annotations':[],'model':'previous-vision-model'}
    return stage,prev

class ExplicitNoteTests(unittest.TestCase):
    def test_three_named_note_types_keep_exact_numbers_and_no_new_model(self):
        stage,prev=fixture(['TONGUE MATERIAL THK: 1.45 ±0.07 [.057 ±.003]','DIMENSIONS IN mm [INCHES]','CIRCULAR MIL AREA: 3.20-5.10mm² [9,000-11,000]','AMP WIRE RANGE 14-12 AWG','WIRE INSULATION DIA .180-.300'])
        original=copy.deepcopy((stage,prev));r,a=enrich(stage,prev)
        self.assertEqual(len(r['parameters']),3)
        values={p['instance_label']:(p['value_raw'],p['unit_raw']) for p in r['parameters']}
        self.assertEqual(values['舌片材料厚度'],('1.45 ±0.07 [.057 ±.003]','mm'))
        self.assertEqual(values['适用导体截面积范围'],('3.20-5.10mm²','mm²'))
        self.assertEqual(values['适用线规范围'],('14-12 AWG','AWG'))
        self.assertEqual(r['model'],'previous-vision-model');self.assertFalse(r['network_call_performed'])
        self.assertEqual(r['processing_method'],'local_explicit_note_enrichment')
        self.assertEqual(len(r['added_parameter_ids']),3);self.assertEqual(a['retained_parameter_count'],0)
        self.assertEqual((stage,prev),original)
        for p in r['parameters']:
            self.assertEqual(p['evidence_mode'],'explicit_note');self.assertIsNone(p['object_region']);self.assertEqual(p['leader_points'],[])
    def test_thickness_unit_requires_explicit_unit_or_bracketed_applicable_note(self):
        for texts,expected in [(['TONGUE THK: 0.75'],'unknown'),(['TONGUE THK: 0.75','DIMENSIONS IN mm [INCHES]'],'unknown'),(['TONGUE THK: 0.75 [.0295]','DIMENSIONS IN mm [INCHES]'],'mm'),(['TONGUE THK: 0.75 mm'],'mm')]:
            stage,prev=fixture(texts);r,_=enrich(stage,prev)
            self.assertEqual(r['parameters'][0]['unit_raw'],None if expected=='unknown' else expected)
    def test_no_implicit_number_or_area_to_diameter_conversion(self):
        stage,prev=fixture(['8.44 ±0.12','INSULATION .180-.300','CIRCULAR MIL AREA: 3.20-5.10mm²'])
        r,_=enrich(stage,prev);self.assertEqual(len(r['parameters']),1)
        self.assertEqual(r['parameters'][0]['key'],'conductor_cross_section')
        self.assertEqual(r['parameters'][0]['unit_raw'],'mm²')
    def test_repeated_run_is_idempotent_and_keeps_rule_provenance(self):
        stage,prev=fixture(['TONGUE MATERIAL THK: 0.75 mm','WIRE RANGE 18-16 AWG'])
        first,_=enrich(stage,prev);second,a=enrich(stage,first)
        self.assertEqual(first['parameters'],second['parameters']);self.assertEqual(first['added_parameter_ids'],second['added_parameter_ids'])
        self.assertEqual(a['added_parameter_ids'],[])
    def test_source_binding_and_conflicting_text_are_rejected(self):
        stage,prev=fixture(['TONGUE THK: 0.75 mm']);prev['document_sha256']='d'*64
        with self.assertRaisesRegex(ValueError,'same original'):enrich(stage,prev)
        stage,prev=fixture(['TONGUE THK: 0.75 mm']);prev['observations']=[{'id':'obs_0','raw_text':'TONGUE THK: 0.85 mm'}]
        with self.assertRaisesRegex(ValueError,'conflicting'):enrich(stage,prev)
    def test_stage_validation_is_checked_not_merely_declared(self):
        stage,prev=fixture(['TONGUE THK: 0.75 mm']);stage['payload']['observations'][0]['image_id']='nonexistent'
        with self.assertRaises(ValueError):enrich(stage,prev)
        stage,prev=fixture(['TONGUE THK: 0.75 mm']);stage['validation']['schema_valid']=False
        with self.assertRaisesRegex(ValueError,'validation record'):enrich(stage,prev)
    def test_missing_region_and_unclear_text_never_create_candidate(self):
        stage,prev=fixture(['TONGUE THK: 0.75 mm']);stage['payload']['observations'][0]['region']=None
        r,a=enrich(stage,prev);self.assertEqual(r['parameters'],[]);self.assertEqual(len(a['skipped']),1)
        stage,prev=fixture(['TONGUE THK: 0.75 mm']);stage['payload']['observations'][0]['legibility']='unreadable'
        r,a=enrich(stage,prev);self.assertEqual(r['parameters'],[])
    def test_crop_rotation_regions_map_to_full_original_without_reshaping_values(self):
        observation={'region':BOX}
        source={'roi_normalized':{'x':.2,'y':.1,'width':.5,'height':.6},'rotation_clockwise':90}
        actual=full_region(observation,source)
        self.assertAlmostEqual(actual['x'],.28);self.assertAlmostEqual(actual['y'],.575)
        self.assertAlmostEqual(actual['width'],.03);self.assertAlmostEqual(actual['height'],.125)
    def test_legacy_conversion_preserves_existing_values_regions_and_unknown_units(self):
        from test_geometry import GeometryTests
        payload,obs=GeometryTests().fixture()
        previous=dict(payload,document_sha256=SHA,page=1,observations=list(obs.values()),model='older-model')
        stage,_=fixture(['TONGUE THK: 0.75 mm'])
        r,_=enrich(stage,previous)
        self.assertEqual(len(r['parameters']),7)
        self.assertEqual(r['parameters'][0]['value_raw'],payload['parameters'][0]['value_raw'])
        self.assertEqual(r['parameters'][0]['object_region'],payload['parameters'][0]['object_region'])
        self.assertEqual(r['parameters'][0]['id'],'legacy_mounting_hole_diameter')
        self.assertEqual(r['parameters'][1]['status'],'ambiguous')

if __name__=='__main__':unittest.main()
