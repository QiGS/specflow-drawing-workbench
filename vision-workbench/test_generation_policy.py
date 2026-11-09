"""No live API: inspect actual serialized request bytes and injected responses."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from PIL import Image
from app import dispatch
from provider import Config, ProviderFailure, run
from test_provider import sample, response


class GenerationPolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.image = Path(self.tmp.name) / 'synthetic.png'
        Image.new('RGB', (120, 40), 'white').save(self.image)
        self.specs = [{'path': str(self.image)}]

    def call_and_capture(self, config):
        requests = []
        def fake(endpoint, headers, body, timeout):
            requests.append(json.loads(body))
            return response(sample())
        result, audit = run(config, self.specs, transport=fake)
        self.assertEqual(len(requests), 1)
        self.assertEqual(audit['automatic_retries'], 0)
        self.assertFalse(audit['genesis_parameter_passthrough_verified'])
        self.assertFalse(result['network_call_performed'])
        actual = {key: value for key, value in requests[0].items() if key != 'messages'}
        self.assertEqual(actual, audit['effective_request_parameters'])
        self.assertEqual(actual, result['effective_request_parameters'])
        self.assertNotIn('unit-test-env-secret', json.dumps(audit))
        return actual

    def test_qwen38_serialized_payload_disables_thinking_and_uses_total_limit(self):
        for model in ('qwen3.8-flash', 'qwen3.8-27b', 'qwen3.8-max'):
            with self.subTest(model=model):
                params = self.call_and_capture(Config(model=model, api_key='unit-test-env-secret', max_tokens=256))
                self.assertEqual(params, {'model': model, 'stream': False,
                                          'enable_thinking': False, 'max_completion_tokens': 256})
                self.assertNotIn('max_tokens', params)
                self.assertNotIn('thinking_budget', params)

    def test_other_models_keep_compatible_parameters_without_qwen_overrides(self):
        params = self.call_and_capture(Config(model='other-model', api_key='unit-test-env-secret', max_tokens=256))
        self.assertEqual(params, {'model': 'other-model', 'stream': False, 'max_tokens': 256})

    def test_enabled_thinking_is_server_owned_bounded_and_never_uses_reasoning_effort(self):
        with patch.dict(os.environ, {'DRAWING_VLM_API_KEY': 'unit-test-env-secret',
                                     'DRAWING_VLM_MODEL': 'qwen3.8-flash',
                                     'DRAWING_VLM_THINKING_MODE': 'enabled',
                                     'DRAWING_VLM_THINKING_BUDGET': '16'}, clear=True):
            params = self.call_and_capture(Config.from_env(max_tokens=64))
        self.assertTrue(params['enable_thinking'])
        self.assertEqual(params['thinking_budget'], 16)
        self.assertEqual(params['max_completion_tokens'], 64)
        self.assertNotIn('reasoning_effort', params)
        for key, value in [('enable_thinking', True), ('thinking_budget', 100),
                           ('max_completion_tokens', 100), ('model', 'other'),
                           ('endpoint', 'https://example.invalid'), ('api_key', 'not-accepted')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                dispatch({'images': [], key: value})

    def test_local_policy_rejects_incompatible_modes_and_budgets_before_transport(self):
        invalid = [{'thinking_mode': 'disabled', 'thinking_budget': 16},
                   {'thinking_mode': 'enabled'},
                   {'thinking_mode': 'enabled', 'thinking_budget': True},
                   {'thinking_mode': 'enabled', 'thinking_budget': 0},
                   {'thinking_mode': 'enabled', 'thinking_budget': 64},
                   {'thinking_mode': 'unknown'}, {'max_tokens': True},
                   {'model': 'other-model', 'thinking_mode': 'enabled', 'thinking_budget': 16}]
        for change in invalid:
            with self.subTest(change=change):
                config = Config(**({'model': 'qwen3.8-flash', 'api_key': 'unit-test-env-secret', 'max_tokens': 64} | change))
                def unexpected_transport(*args):
                    self.fail('Invalid configuration reached transport')
                with self.assertRaises(ValueError):
                    run(config, self.specs, transport=unexpected_transport)

    def test_reasoning_only_is_a_specific_failure_even_when_reasoning_is_valid_JSON(self):
        for content, finish in [(None, 'stop'), ('', 'length'), ([], 'stop'), ('  ', None)]:
            with self.subTest(content=content, finish=finish):
                calls = []
                def fake(*args):
                    calls.append(1)
                    return 200, json.dumps({'choices': [{'finish_reason': finish, 'message': {
                        'content': content, 'reasoning_content': json.dumps(sample())}}]}).encode()
                with self.assertRaises(ProviderFailure) as error:
                    run(Config(model='qwen3.8-flash', api_key='unit-test-env-secret'), self.specs, transport=fake)
                self.assertEqual(error.exception.code, 'reasoning_without_content')
                self.assertTrue(error.exception.audit['response_diagnostics']['has_reasoning'])
                self.assertFalse(error.exception.audit['response_diagnostics']['has_nonempty_text_content'])
                self.assertEqual(calls, [1])

    def test_empty_content_is_separate_and_reasoning_does_not_replace_real_content(self):
        config = Config(model='qwen3.8-flash', api_key='unit-test-env-secret')
        with self.assertRaises(ProviderFailure) as error:
            run(config, self.specs, transport=lambda *args: (200, b'{"choices":[{"finish_reason":"stop","message":{"content":""}}]}'))
        self.assertEqual(error.exception.code, 'empty_content')
        def both(*args):
            return 200, json.dumps({'choices': [{'finish_reason': 'stop', 'message': {
                'reasoning_content': '{"not_the_result":true}', 'content': json.dumps(sample())}}]}).encode()
        result, audit = run(config, self.specs, transport=both)
        self.assertEqual(result['payload']['schema_version'], '1.0')
        self.assertTrue(audit['response_diagnostics']['has_reasoning'])
        self.assertTrue(audit['response_diagnostics']['has_nonempty_text_content'])


if __name__ == '__main__':
    unittest.main()
