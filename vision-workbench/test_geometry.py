import copy,json,tempfile,unittest
from pathlib import Path
from PIL import Image
from geometry import PARAMETERS,VERSION,validate,stage_observations,run
from provider import Config,ProviderFailure,sha

class GeometryTests(unittest.TestCase):
 def fixture(self):
  obs={'d':{'id':'d','raw_text':'8.33 ±0.13 DIA','origin':'stage_one'},'u':{'id':'u','raw_text':'DIMENSIONS IN mm','origin':'stage_one'}}
  p={'schema_version':VERSION,'observations':[],'parameters':[]}
  for key in PARAMETERS:
   p['parameters'].append(dict(key=key,status='unknown',value_raw=None,nominal_raw=None,unit_raw=None,tolerance_raw=None,limit=None,annotation_region=None,object_region=None,leader_points=[],reason='No independent visible leader evidence provided',evidence_text='',evidence_ids=[]))
  p['parameters'][0].update(status='candidate',value_raw='8.33 ±0.13 DIA',nominal_raw='8.33',unit_raw='mm',tolerance_raw='±0.13',annotation_region={'x':.1,'y':.1,'width':.2,'height':.1},object_region={'x':.2,'y':.2,'width':.1,'height':.1},leader_points=[{'x':.2,'y':.2},{'x':.3,'y':.3}],reason='Visible diameter leader points at circular hole boundary',evidence_text='8.33 ±0.13 DIA\nDIMENSIONS IN mm',evidence_ids=['d','u'])
  return p,obs
 def test_valid_candidates_stay_unreviewed_and_do_not_modify_stage_one(self):
  p,obs=self.fixture();before=copy.deepcopy(obs);r=validate(p,obs,'a'*64,1)
  self.assertEqual(r['parameters'][0]['label'],'安装孔径');self.assertTrue(r['human_review_required']);self.assertEqual(obs,before)
 def test_numeric_invention_citations_units_and_geometry_rejected(self):
  for change in [dict(value_raw='88.33 ±0.13 DIA',nominal_raw='88.33'),dict(evidence_ids=[]),dict(evidence_ids=['invented']),dict(unit_raw='inch'),dict(tolerance_raw='±0.14'),dict(leader_points=[]),dict(status='approved')]:
   p,obs=self.fixture();p['parameters'][0].update(change)
   with self.assertRaises(ValueError):validate(p,obs,'a'*64,1)
 def test_unknown_cannot_hide_values(self):
  p,obs=self.fixture();p['parameters'][1]['value_raw']='42'
  with self.assertRaises(ValueError):validate(p,obs,'a'*64,1)
 def test_source_sha_and_page_required(self):
  stage={'status':'valid_unreviewed','sources':[{'document_sha256':'a'*64,'page':1,'image_id':'p'}],'payload':{'observations':[{'id':'d','image_id':'p','raw_text':'8.33','legibility':'clear'}]}}
  self.assertIn('d',stage_observations(stage,'a'*64,1))
  for sha_value,page in [('b'*64,1),('a'*64,2)]:
   with self.assertRaises(ValueError):stage_observations(stage,sha_value,page)
 def test_new_range_transcription_is_candidate_not_verified_ground_truth(self):
  p,obs=self.fixture();p['observations']=[{'id':'new_od','raw_text':'.170-.250 INSULATION DIA','region':{'x':.2,'y':.2,'width':.2,'height':.1}}]
  p['parameters'][-1]=dict(p['parameters'][0],key='wire_insulation_diameter',value_raw='.170-.250 INSULATION DIA',nominal_raw=None,unit_raw=None,tolerance_raw=None,limit='range',evidence_text='.170-.250 INSULATION DIA',evidence_ids=['new_od'])
  r=validate(p,obs,'a'*64,1);self.assertEqual(r['parameters'][-1]['nominal_raw'],None);self.assertEqual(r['observations'][-1]['origin'],'stage_two_model_transcription')
 def test_conductor_area_is_not_insulation_diameter(self):
  p,obs=self.fixture();obs['d']['raw_text']='2.62-6.64mm²'
  p['parameters'][-1]=dict(p['parameters'][0],key='wire_insulation_diameter',value_raw='2.62-6.64mm²',nominal_raw=None,unit_raw='mm²',tolerance_raw=None,limit='range',evidence_text='2.62-6.64mm²',evidence_ids=['d'])
  with self.assertRaises(ValueError):validate(p,obs,'a'*64,1)
 def test_explicit_textual_wire_diameter_needs_no_drawn_leader_and_keeps_unknown_unit(self):
  p,obs=self.fixture();obs['wire']={'id':'wire','raw_text':'WIRE INSULATION DIA .150-.250','origin':'stage_one'}
  p['parameters'][-1]=dict(p['parameters'][0],key='wire_insulation_diameter',value_raw='.150-.250',nominal_raw=None,unit_raw=None,tolerance_raw=None,limit='range',object_region=None,leader_points=[],evidence_text='WIRE INSULATION DIA .150-.250',evidence_ids=['wire'])
  r=validate(p,obs,'a'*64,1);self.assertIsNone(r['parameters'][-1]['unit_raw'])
  p['parameters'][-1]['unit_raw']='in'
  with self.assertRaises(ValueError):validate(p,obs,'a'*64,1)
 def test_reason_must_be_final_evidence_not_unbounded_deliberation(self):
  p,obs=self.fixture();p['parameters'][0]['reason']='speculation '*100
  with self.assertRaises(ValueError):validate(p,obs,'a'*64,1)
 def test_request_policy_and_response(self):
  p,obs=self.fixture()
  with tempfile.TemporaryDirectory() as td:
   path=Path(td)/'test.png';Image.new('RGB',(80,60),'white').save(path);h=sha(path.read_bytes())
   stage={'status':'valid_unreviewed','sources':[{'document_sha256':h,'page':1,'image_id':'p'}],'payload':{'observations':[dict(v,image_id='p',legibility='clear') for v in obs.values()]}}
   def transport(url,headers,body,timeout):
    b=json.loads(body);self.assertIn('max_completion_tokens',b);self.assertFalse(b['enable_thinking']);self.assertNotIn('max_tokens',b)
    self.assertIn('stage TWO',b['messages'][0]['content'])
    return 200,json.dumps({'model':'test','choices':[{'finish_reason':'stop','message':{'content':json.dumps(p)}}]}).encode()
   r,a=run(Config(model='qwen3.8-max',api_key='testsecret'),path,stage,transport=transport)
   self.assertEqual(r['document_sha256'],h);self.assertNotIn('testsecret',json.dumps(a))

if __name__=='__main__':unittest.main()
