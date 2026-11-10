import argparse
import io
import json
import os
import unittest
from unittest.mock import patch
from PIL import Image
import geometry_config
from geometry import run_prepared
from provider import Config,ProviderFailure

BASE={'DRAWING_VLM_MODEL':'qwen3.8-max','DRAWING_VLM_API_KEY':'fake-private-value'}

class GeometryConfigurationTests(unittest.TestCase):
    def test_existing_environment_precedes_cli_fallback_without_mutation(self):
        environment=dict(BASE,DRAWING_VLM_TIMEOUT='240',DRAWING_VLM_MAX_TOKENS='20000',DRAWING_VLM_THINKING_MODE='enabled',DRAWING_VLM_THINKING_BUDGET='8000')
        with patch.dict(os.environ,environment,clear=True):
            before=dict(os.environ)
            config=geometry_config.from_env(timeout=600,max_tokens=30000,thinking_mode='disabled')
            self.assertEqual(config.timeout,240);self.assertEqual(config.max_tokens,20000)
            self.assertEqual(config.thinking_mode,'enabled');self.assertEqual(config.thinking_budget,8000)
            self.assertEqual(dict(os.environ),before)
    def test_geometry_specific_environment_does_not_change_generic_stage_one_values(self):
        environment=dict(BASE,DRAWING_VLM_TIMEOUT='90',DRAWING_VLM_MAX_TOKENS='10000',DRAWING_VLM_THINKING_MODE='disabled',DRAWING_GEOMETRY_TIMEOUT='600',DRAWING_GEOMETRY_MAX_TOKENS='24000',DRAWING_GEOMETRY_THINKING_MODE='enabled',DRAWING_GEOMETRY_THINKING_BUDGET='8000')
        with patch.dict(os.environ,environment,clear=True):
            config=geometry_config.from_env();self.assertEqual(config.timeout,600);self.assertEqual(config.max_tokens,24000)
            self.assertEqual(config.thinking_mode,'enabled');self.assertEqual(os.environ['DRAWING_VLM_THINKING_MODE'],'disabled')
            self.assertEqual(os.environ['DRAWING_VLM_TIMEOUT'],'90')
    def test_unconfigured_defaults_preserve_previous_limits_and_disabled_thinking(self):
        with patch.dict(os.environ,BASE,clear=True):
            c=geometry_config.from_env();self.assertEqual(c.timeout,180);self.assertEqual(c.max_tokens,10000)
            self.assertEqual(c.thinking_mode,'disabled');self.assertIsNone(c.thinking_budget)
    def test_explicit_cli_fallbacks_and_provider_policy_are_validated(self):
        parser=argparse.ArgumentParser();geometry_config.add_cli_arguments(parser,prefix='geometry-')
        args=parser.parse_args(['--geometry-timeout','600','--geometry-max-tokens','24000','--geometry-thinking-mode','enabled','--geometry-thinking-budget','8000'])
        with patch.dict(os.environ,BASE,clear=True):
            c=geometry_config.from_env(**geometry_config.cli_options(args,prefix='geometry-'))
            self.assertEqual(c.timeout,600);self.assertEqual(c.thinking_budget,8000)
        with patch.dict(os.environ,dict(BASE,DRAWING_VLM_MODEL='other-provider-model'),clear=True):
            with self.assertRaisesRegex(ValueError,'supported only'):geometry_config.from_env(thinking_mode='enabled',thinking_budget=1000)
    def test_invalid_values_fail_without_disclosing_environment_contents(self):
        with patch.dict(os.environ,dict(BASE,DRAWING_GEOMETRY_TIMEOUT='secret-should-not-appear'),clear=True):
            with self.assertRaises(ValueError) as caught:geometry_config.from_env()
            self.assertNotIn('secret-should-not-appear',str(caught.exception))
        with patch.dict(os.environ,dict(BASE,DRAWING_GEOMETRY_TIMEOUT='601'),clear=True):
            with self.assertRaises(ValueError):geometry_config.from_env()
    def test_transport_timeout_keeps_elapsed_error_and_source_audit_redacted(self):
        image=Image.new('RGB',(100,80),'white');stream=io.BytesIO();image.save(stream,format='PNG')
        def transport(url,headers,body,timeout):
            self.assertEqual(timeout,600)
            raise TimeoutError('read timeout '+BASE['DRAWING_VLM_API_KEY'])
        with patch('geometry.time.monotonic',side_effect=[100.0,405.125]):
            with self.assertRaises(ProviderFailure) as caught:
                run_prepared(Config(model='qwen3.8-max',api_key=BASE['DRAWING_VLM_API_KEY'],timeout=600),stream.getvalue(),'a'*64,transport=transport)
        a=caught.exception.audit
        self.assertEqual(a['elapsed_seconds'],305.125);self.assertIsNone(a['http_status'])
        self.assertEqual(a['transport_error_type'],'TimeoutError');self.assertEqual(a['provider']['timeout_seconds'],600)
        self.assertEqual(a['document_sha256'],'a'*64);self.assertEqual(len(a['image_sources']),5)
        self.assertNotIn(BASE['DRAWING_VLM_API_KEY'],json.dumps(a))
        self.assertIn('[REDACTED]',a['transport_error_message'])
    def test_public_configuration_has_no_secret_or_provider_address(self):
        with patch.dict(os.environ,BASE,clear=True):
            settings=geometry_config.public_settings(geometry_config.from_env())
        self.assertNotIn(BASE['DRAWING_VLM_API_KEY'],json.dumps(settings));self.assertNotIn('base_url',settings)
        self.assertTrue(settings['configured_only_not_connectivity_verified'])

if __name__=='__main__':unittest.main()
