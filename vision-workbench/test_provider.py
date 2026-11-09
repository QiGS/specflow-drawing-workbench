import base64,copy,io,json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from PIL import Image
from contract import ContractError,strict_json,validate_payload
from provider import Config,ProviderFailure,prepared_image,run,redact
from app import dispatch


def sample(ids=('image_001',),operation='extract_page'):
    return {'schema_version':'1.0','operation':operation,'raw_text':'4.00 ±0.1',
            'image_texts':[{'image_id':i,'raw_text':'4.00 ±0.1','legibility':'clear'} for i in ids],
            'observations':[{'id':'o1','image_id':ids[0],'kind':'visible_text','raw_text':'4.00 ±0.1',
                             'region':{'x':.1,'y':.2,'width':.3,'height':.4,'coordinate_space':'supplied_image_normalized_top_left','basis':'model_estimate_unreviewed'},'legibility':'clear'}],
            'fields':[],'bom':[],'missing_information':[],'warnings':[]}

def field():
    return {'id':'f1','name':'尺寸标注1','category':'dimension','value_raw':'4.00 ±0.1','nominal_raw':'4.00','unit_raw':None,
            'tolerance':None,'limit_raw':None,'object':None,'view':None,'state':None,'evidence_ids':['o1'],
            'association_evidence_ids':[],'certainty':'uncertain','review_status':'pending'}

def response(payload,finish='stop'):
    return 200,json.dumps({'id':'unit-test-response','model':'mock-model','usage':{'total_tokens':3},
                           'choices':[{'finish_reason':finish,'message':{'content':json.dumps(payload)}}]}).encode()

class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
        self.image=self.root/'page.png';Image.new('RGB',(200,100),'white').save(self.image)
        self.config=Config(model='mock-model',api_key='unit-test-env-secret')
    def test_multimage_ROI_payload_and_source_mapping_preserve_raw_text(self):
        specs=[{'path':str(self.image),'roi_px':[40,20,100,50],'image_id':'a','page':2},
               {'path':str(self.image),'image_id':'b','rotation_cw':90}]
        output=sample(('a','b'));output['fields']=[field()]
        calls=[]
        def fake(url,headers,body,timeout):
            calls.append(json.loads(body));self.assertTrue(url.endswith('/v1/chat/completions'))
            self.assertEqual(headers['Authorization'],'Bearer unit-test-env-secret')
            self.assertNotIn('expected',body.decode());self.assertEqual(len([x for x in calls[0]['messages'][1]['content'] if x['type']=='image_url']),2)
            return response(output)
        result,audit=run(self.config,specs,transport=fake)
        self.assertEqual(result['payload']['fields'][0]['nominal_raw'],'4.00')
        self.assertAlmostEqual(result['mapped_evidence'][0]['region_rotated_full_page']['x'],.25)
        self.assertEqual(result['sources'][1]['rotated_full_size'],[100,200])
        self.assertEqual(len(result['validation']['missing_fields']),5)
        self.assertFalse(result['engineering_value_approved'])
        self.assertNotIn('unit-test-env-secret',json.dumps(audit));self.assertNotIn('data:image',json.dumps(audit))
    def test_strict_JSON_and_schema_reject_repair_approval_and_nonfinite(self):
        for bad in ['```json\n{}\n```','{"x":1,"x":2}','{"x":NaN}','{"x":1e999}']:
            with self.subTest(bad=bad),self.assertRaises(ContractError):strict_json(bad)
        sources=[{'image_id':'image_001'}]
        for mutate in [lambda p:p.update(extra='unexpected'),lambda p:p['fields'][0].update(review_status='approved'),
                       lambda p:p['fields'][0].update(nominal_raw=4.0),lambda p:p['fields'][0].update(evidence_ids=['missing']),
                       lambda p:p['fields'][0].update(object='hole'),lambda p:p['observations'][0]['region'].update(x=.9)]:
            p=sample();p['fields']=[field()];mutate(p)
            with self.assertRaises(ContractError):validate_payload(p,sources,'extract_page')
    def test_missing_and_unknown_images_are_rejected(self):
        p=sample();p['image_texts']=[]
        with self.assertRaises(ContractError):validate_payload(p,[{'image_id':'image_001'}],'extract_page')
        p=sample();p['observations'][0]['image_id']='unknown'
        with self.assertRaises(ContractError):validate_payload(p,[{'image_id':'image_001'}],'extract_page')
    def test_timeout_HTTP_error_truncation_and_secrets_are_auditable(self):
        def bad_http(*args):return 401,b'{"error":"unit-test-env-secret", "authorization":"Bearer unit-test-env-secret"}'
        with self.assertRaises(ProviderFailure) as error:run(self.config,[{'path':str(self.image)}],transport=bad_http)
        self.assertEqual(error.exception.code,'http_error');self.assertNotIn('unit-test-env-secret',json.dumps(error.exception.audit))
        with self.assertRaises(ProviderFailure) as error:run(self.config,[{'path':str(self.image)}],transport=lambda *a:response(sample(),'length'))
        self.assertEqual(error.exception.code,'invalid_model_output')
        def timeout(*a):raise TimeoutError('unit-test-env-secret unavailable')
        with self.assertRaises(ProviderFailure) as error:run(self.config,[{'path':str(self.image)}],transport=timeout)
        self.assertNotIn('unit-test-env-secret',str(error.exception))
    def test_pixel_ROI_checks_and_labels_never_become_input(self):
        for roi in [[-1,0,20,20],[0,0,201,20],[0,0,0,20],[0,0,20.5,10]]:
            with self.assertRaises(ValueError):prepared_image({'path':str(self.image),'roi_px':roi},0)
        with self.assertRaises(ValueError):prepared_image({'path':str(self.image),'text':'secret gold label'},0)
        with self.assertRaises(ValueError):run(self.config,[{'path':str(self.image),'image_id':'same'}]*2,transport=lambda *a:None)
    def test_config_and_HTTP_boundary_are_server_owned(self):
        with patch.dict(os.environ,{'DRAWING_VLM_API_KEY':'unit-test-env-secret','DRAWING_VLM_MODEL':'mock-model'},clear=True):
            c=Config.from_env();self.assertNotIn('unit-test-env-secret',repr(c));c.validate()
        for base in ['http://example.invalid/v1','https://name:password@example.invalid/v1','https://example.invalid/v1?key=secret']:
            with self.assertRaises(ValueError):Config(model='m',api_key='secret',base_url=base).validate()
        with self.assertRaises(ValueError):dispatch({'images':[{'path':'/private/file'}]})
        with self.assertRaises(ValueError):dispatch({'images':[],'api_key':'never-accepted'})
    def test_transcription_mode_does_not_silently_extract_fields(self):
        p=sample(operation='transcribe_line');p['fields']=[field()]
        with self.assertRaises(ContractError):validate_payload(p,[{'image_id':'image_001'}],'transcribe_line')
        p['fields']=[];p['raw_text']='';p['image_texts'][0]['raw_text']='';p['image_texts'][0]['legibility']='unreadable'
        self.assertFalse(validate_payload(p,[{'image_id':'image_001'}],'transcribe_line')['accuracy_verified'])
    def test_numeric_self_consistency_unreadable_and_huge_numbers(self):
        for mutate in [lambda p:p['fields'][0].update(nominal_raw='99.99'),
                       lambda p:p['observations'][0]['region'].update(x=10**400),
                       lambda p:p['observations'][0].update(legibility='unreadable')]:
            p=sample();p['fields']=[field()];p['fields'][0]['certainty']='clear';mutate(p)
            with self.assertRaises(ContractError):validate_payload(p,[{'image_id':'image_001'}],'extract_page')
        with self.assertRaises(ContractError):strict_json('{"x":'+('1'*300)+'}')
    def test_echoed_request_does_not_leak_image_data_or_credentials_to_audit(self):
        def echo(url,headers,body,timeout):
            return 400,json.dumps({'echoed_request':json.loads(body),'authorization':headers['Authorization']}).encode()
        with self.assertRaises(ProviderFailure) as error:
            run(self.config,[{'path':str(self.image)}],transport=echo)
        audit=json.dumps(error.exception.audit)
        self.assertNotIn('data:image',audit);self.assertNotIn('unit-test-env-secret',audit)
        self.assertIn('REDACTED_IMAGE_DATA',audit)
    def test_failure_audit_has_safe_standalone_reason_without_cycles_or_input_mutation(self):
        original={'nested':{'message':'unit-test-env-secret'},'source':'test'}
        failure=ProviderFailure('diagnostic_failure','Rejected unit-test-env-secret',original,secret='unit-test-env-secret')
        stored=json.loads(json.dumps(failure.audit))
        self.assertEqual(stored['failure'],{'code':'diagnostic_failure','message':'Rejected [REDACTED]'})
        self.assertNotIn('unit-test-env-secret',json.dumps(stored))
        self.assertEqual(original['nested']['message'],'unit-test-env-secret')
        self.assertNotIn('failure',original)
        def timeout(*args):raise TimeoutError('unit-test-env-secret unavailable')
        with self.assertRaises(ProviderFailure) as error:
            run(self.config,[{'path':str(self.image)}],transport=timeout)
        safe=json.loads(json.dumps(error.exception.audit))
        self.assertEqual(safe['failure']['code'],'transport_error')
        self.assertEqual(safe['failure']['message'],'[REDACTED] unavailable')
        self.assertNotIn('unit-test-env-secret',json.dumps(safe))

if __name__=='__main__':unittest.main()
