import json,unittest
from unittest.mock import patch
import test_workbench as existing
from geometry import VERSION,PARAMETERS

class GeometryHTTPTests(unittest.TestCase):
 setUp=existing.WorkbenchHTTPTests.setUp
 tearDown=existing.WorkbenchHTTPTests.tearDown
 req=existing.WorkbenchHTTPTests.req
 login=existing.WorkbenchHTTPTests.login
 fake_dispatch=existing.WorkbenchHTTPTests.fake_dispatch
 def upload_and_stage(self):
  self.login();data=existing.png_bytes()
  status,_,body=self.req('POST','/api/upload',data,{'Origin':self.origin,'Content-Type':'image/png','X-File-Name':'test.png'})
  self.assertEqual(status,200);doc=json.loads(body)['document']
  stage={'status':'valid_unreviewed','validation':{'schema_valid':True,'reference_links_valid':True},'sources':[{'page':1,'document_sha256':doc['source_sha256'],'image_id':'p'}],'payload':{'fields':[],'observations':[{'id':'o','image_id':'p','raw_text':'1.20 DIA','legibility':'clear'}],'image_texts':[]}}
  return doc,stage
 def post(self,path,value):return self.req('POST',path,json.dumps(value),{'Origin':self.origin,'Content-Type':'application/json'})
 def test_imported_stage_requires_original_sha_then_geometry_uses_server_owned_page(self):
  doc,stage=self.upload_and_stage()
  with patch('workbench.geometry.run_prepared',return_value=({'schema_version':'geometry-2.0','parameters':[]},{})) as direct_call:
   status,_,_=self.post('/api/geometry',{'document_id':doc['id'],'page':1});self.assertEqual(status,200)
   self.assertIsNone(direct_call.call_args.args[3]);self.assertEqual(direct_call.call_args.args[2],doc['source_sha256'])
  bad=json.loads(json.dumps(stage));bad['sources'][0]['document_sha256']='a'*64
  status,_,_=self.post('/api/stage-one',{'document_id':doc['id'],'page':1,'result':bad});self.assertEqual(status,400)
  status,_,_=self.post('/api/stage-one',{'document_id':doc['id'],'page':1,'result':stage});self.assertEqual(status,200)
  with patch('workbench.geometry.run_prepared',return_value=({'schema_version':VERSION,'parameters':[]},{})) as call:
   status,_,body=self.post('/api/geometry',{'document_id':doc['id'],'page':1})
   self.assertEqual(status,200);self.assertEqual(json.loads(body)['state'],'geometry_candidates')
   args=call.call_args.args;self.assertEqual(args[2],doc['source_sha256']);self.assertEqual(args[3],stage);self.assertEqual(args[4],1);self.assertTrue(args[1].startswith(b'\x89PNG'))
   status,_,_=self.post('/api/geometry',{'document_id':doc['id'],'page':1,'endpoint':'https://example.com'});self.assertEqual(status,400)
 def test_geometry_route_uses_explicit_server_configuration_and_exposes_safe_settings(self):
  doc,stage=self.upload_and_stage()
  settings={'DRAWING_GEOMETRY_TIMEOUT':'600','DRAWING_GEOMETRY_MAX_TOKENS':'24000','DRAWING_GEOMETRY_THINKING_MODE':'enabled','DRAWING_GEOMETRY_THINKING_BUDGET':'8000'}
  with patch.dict('os.environ',settings),patch('workbench.geometry.run_prepared',return_value=({'schema_version':'geometry-2.0','parameters':[]},{})) as call:
   status,_,_=self.post('/api/geometry',{'document_id':doc['id'],'page':1});self.assertEqual(status,200)
   config=call.call_args.args[0];self.assertEqual(config.timeout,600);self.assertEqual(config.max_tokens,24000);self.assertEqual(config.thinking_mode,'enabled');self.assertEqual(config.thinking_budget,8000)
   status,_,body=self.req('GET','/api/session');self.assertEqual(status,200)
   session=json.loads(body);self.assertEqual(session['geometry_configuration']['timeout_seconds'],600)
   self.assertNotIn('fake-provider-secret-never-network',body.decode());self.assertTrue(session['configured'])
 def test_geometry_reuses_session_origin_and_single_flight_controls(self):
  doc,stage=self.upload_and_stage();value=json.dumps({'document_id':doc['id'],'page':1})
  status,_,_=self.req('POST','/api/geometry',value,{'Content-Type':'application/json','Origin':'https://example.com'});self.assertEqual(status,403)
  self.server.state.slot.acquire()
  try:
   status,_,_=self.post('/api/geometry',json.loads(value));self.assertEqual(status,429)
  finally:self.server.state.slot.release()

if __name__=='__main__':unittest.main()
