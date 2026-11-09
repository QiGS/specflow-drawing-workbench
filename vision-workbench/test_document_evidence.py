"""Document-level evidence failures: no evidence fabrication or silent value removal."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from PIL import Image
from contract import ContractError, SCHEMA_PATH, strict_json, validate_payload, validate_schema
from provider import Config, FINAL_OUTPUT_CHECKLIST, PROMPT_VERSION, run
from test_provider import field, response, sample


class DocumentEvidenceTests(unittest.TestCase):
    def test_object_without_association_is_semantic_failure_not_schema_mismatch(self):
        payload=sample();item=field();item.update(object='Product',association_evidence_ids=[])
        payload['fields']=[item]
        validate_schema(payload,strict_json(SCHEMA_PATH.read_text()))
        before=copy.deepcopy(payload)
        with self.assertRaisesRegex(ContractError,'explicit evidence references'):
            validate_payload(payload,[{'image_id':'image_001'}],'extract_page')
        self.assertEqual(payload,before)

    def test_bom_quantity_needs_its_cited_row_not_only_pagewide_text(self):
        payload=sample();payload['raw_text']='12 LOOSE PIECE P-TEST'
        payload['image_texts'][0]['raw_text']=payload['raw_text']
        payload['observations'][0]['raw_text']='P-TEST'
        payload['bom']=[{'id':'b1','item_raw':None,'part_number_raw':'P-TEST','name_raw':None,
                         'quantity_raw':'12','unit_raw':None,'material_raw':None,
                         'evidence_ids':['o1'],'review_status':'pending'}]
        with self.assertRaisesRegex(ContractError,'Numeric string'):
            validate_payload(payload,[{'image_id':'image_001'}],'extract_page')
        # This is a separately authored synthetic positive fixture, not an
        # application fallback that generates or repairs a model observation.
        supported=copy.deepcopy(payload)
        supported['observations'][0]['raw_text']='12 LOOSE PIECE P-TEST'
        self.assertTrue(validate_payload(supported,[{'image_id':'image_001'}],'extract_page')['schema_valid'])

    def test_request_ends_with_evidence_invariants_and_has_new_prompt_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            image=Path(tmp)/'blank.png';Image.new('RGB',(100,80),'white').save(image)
            requests=[]
            def fake(endpoint,headers,body,timeout):
                requests.append(json.loads(body));return response(sample())
            _,audit=run(Config(model='qwen3.8-max',api_key='unit-test-env-secret'),[{'path':str(image)}],transport=fake)
        instruction=requests[0]['messages'][0]['content']
        self.assertTrue(instruction.endswith(FINAL_OUTPUT_CHECKLIST))
        self.assertIn('association_evidence_ids=[] REQUIRES object=null, view=null, state=null',instruction)
        self.assertIn('not only an isolated part-number observation',instruction)
        self.assertEqual(PROMPT_VERSION,'drawing-evidence-v1.5')
        self.assertEqual(audit['prompt_version'],PROMPT_VERSION)


if __name__=='__main__':unittest.main()
