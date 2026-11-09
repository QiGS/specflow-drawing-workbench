import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from PIL import Image
from provider import Config, ProviderFailure, canonical_payload_sha, enrich_region_metadata, run
from test_provider import field, response, sample


class MetadataEnrichmentTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.image=Path(self.tmp.name)/'artificial.png'
        Image.new('RGB',(100,80),'white').save(self.image)
        self.config=Config(model='qwen3.8-flash',api_key='unit-test-env-secret')

    def test_missing_constants_are_recorded_without_mutating_raw_response_or_source_payload(self):
        payload=sample();region=payload['observations'][0]['region']
        del region['coordinate_space'];del region['basis']
        before=copy.deepcopy(payload);status,raw=response(payload)
        result,audit=run(self.config,[{'path':str(self.image)}],transport=lambda *args:(status,raw))
        self.assertEqual(payload,before)
        self.assertEqual(result['metadata_enrichment'],audit['metadata_enrichment'])
        self.assertEqual({row['path'] for row in result['metadata_enrichment']},
                         {'/observations/0/region/coordinate_space','/observations/0/region/basis'})
        self.assertTrue(all(row['source_category']=='server_metadata' for row in result['metadata_enrichment']))
        self.assertEqual(audit['raw_response_sha256'],hashlib.sha256(raw).hexdigest())
        self.assertEqual(audit['raw_response_text_redacted'],raw.decode())
        self.assertEqual(audit['parsed_model_payload_before_enrichment_sha256'],canonical_payload_sha(before))
        self.assertTrue(result['validation']['schema_valid'])

    def test_explicit_wrong_metadata_remains_unchanged_and_is_rejected(self):
        for key,value in [('coordinate_space','pixels'),('basis','human_verified'),('basis',None)]:
            with self.subTest(key=key,value=value):
                payload=sample();payload['observations'][0]['region'][key]=value
                enriched,changes=enrich_region_metadata(payload)
                self.assertEqual(enriched,payload);self.assertEqual(changes,[])
                with self.assertRaises(ProviderFailure) as error:
                    run(self.config,[{'path':str(self.image)}],transport=lambda *args:response(payload))
                self.assertEqual(error.exception.code,'invalid_model_output')

    def test_coordinates_and_all_engineering_fields_are_never_changed_or_filled(self):
        payload=sample();payload['fields']=[field()]
        region=payload['observations'][0]['region'];del region['basis'];del region['coordinate_space']
        before=copy.deepcopy(payload)
        enriched,changes=enrich_region_metadata(payload)
        stripped=copy.deepcopy(enriched)
        for row in changes:
            del stripped['observations'][0]['region'][row['path'].split('/')[-1]]
        self.assertEqual(stripped,before)
        self.assertEqual(enriched['fields'],before['fields'])
        self.assertEqual({k:enriched['observations'][0]['region'][k] for k in ('x','y','width','height')},region)
        del payload['observations'][0]['region']['x']
        with self.assertRaises(ProviderFailure):
            run(self.config,[{'path':str(self.image)}],transport=lambda *args:response(payload))


if __name__=='__main__':unittest.main()
