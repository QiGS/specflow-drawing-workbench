import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from PIL import Image
from contract import ContractError, SCHEMA_PATH, strict_json, validate_payload, validate_schema
from provider import Config, ProviderFailure, build_request_schema, run
from test_provider import field, response, sample


class FactScopeTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.image=Path(self.tmp.name)/'artificial.png';Image.new('RGB',(100,80),'white').save(self.image)
        self.config=Config(model='qwen3.8-max',api_key='unit-test-env-secret')

    def test_neutral_fact_request_preserves_visible_values_and_unconfirmed_associations(self):
        payload=sample();item=field()
        item['tolerance']={'raw':'±0.1','kind':'symmetric','amplitude_raw':'0.1',
                           'upper_raw':None,'lower_raw':None,'evidence_ids':['o1']}
        payload['fields']=[item];before=copy.deepcopy(payload);sent=[]
        def fake(endpoint,headers,body,timeout):sent.append(json.loads(body));return response(payload)
        result,audit=run(self.config,[{'path':str(self.image)}],transport=fake)
        self.assertEqual(result['status'],'valid_unreviewed')
        self.assertEqual(result['payload']['fields'],before['fields'])
        self.assertTrue(result['validation']['request_schema_valid'])
        self.assertEqual(result['extraction_scope'],'visible_annotation_facts')
        self.assertFalse(result['geometry_association_performed'])
        instruction=sent[0]['messages'][0]['content']
        requested=json.loads(instruction.split('Required JSON Schema:\n',1)[1].split('\nFinal output invariants:',1)[0])
        self.assertEqual(requested,build_request_schema('extract_page'))
        self.assertIn('quantities per assembly',requested['properties']['bom']['description'])
        self.assertIn('Packaging quantities beside reel/bag/box/loose-piece descriptions are packaging amounts',instruction)
        self.assertIn('Numbered triangles and similar callouts refer to technical notes',instruction)
        self.assertEqual(audit['request_schema_sha256'],result['request_schema_sha256'])

    def test_task_schema_rejects_inferred_name_or_any_dimension_association_without_rewriting(self):
        for changes in ({'name':'Length to Center'},{'object':'Product'},
                        {'view':'Front View'},{'state':'Open'},
                        {'association_evidence_ids':['o1']}):
            with self.subTest(changes=changes):
                payload=sample();bad=field();bad.update(changes);payload['fields']=[bad]
                before=copy.deepcopy(payload)
                with self.assertRaises(ProviderFailure) as error:
                    run(self.config,[{'path':str(self.image)}],transport=lambda *args:response(payload))
                self.assertEqual(error.exception.code,'no_valid_items')
                rejected=error.exception.audit['rejected_fields'][0]
                self.assertEqual(rejected['error_code'],'task_scope_violation')
                self.assertEqual(rejected['item'],bad)
                self.assertEqual(payload,before)

    def test_storage_schema_stays_capable_of_separate_evidence_backed_association(self):
        original=SCHEMA_PATH.read_bytes();storage=strict_json(original)
        payload=sample();item=field();item.update(name='Diameter',object='hole',association_evidence_ids=['visual'])
        visual=copy.deepcopy(payload['observations'][0])
        visual.update(id='visual',kind='visual_structure',raw_text='The visible leader connects the callout to the hole.')
        payload['observations'].append(visual);payload['fields']=[item]
        self.assertTrue(validate_payload(payload,[{'image_id':'image_001'}],'extract_page')['schema_valid'])
        with self.assertRaises(ContractError):validate_schema(payload,build_request_schema('extract_page'))
        self.assertEqual(SCHEMA_PATH.read_bytes(),original)
        self.assertEqual(build_request_schema('transcribe_line'),storage)


if __name__=='__main__':unittest.main()
