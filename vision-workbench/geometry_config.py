"""Explicit server-owned geometry request settings; no mutation of user environment."""
from __future__ import annotations
import os
from provider import Config

DEFAULTS={'timeout':180.0,'max_tokens':10000,'max_edge':4096,'max_images':8,'thinking_mode':'disabled','thinking_budget':None}
TYPES={'timeout':float,'max_tokens':int,'max_edge':int,'max_images':int,'thinking_mode':str,'thinking_budget':int}


def from_env(model=None,**fallbacks):
    """Geometry env > existing generic env > explicit CLI fallbacks > old defaults.

    Dedicated settings affect only semantic geometry. They never enable thinking,
    increase limits or change the provider unless explicitly configured.
    """
    unknown=set(fallbacks)-set(DEFAULTS)
    if unknown:raise ValueError('Unsupported server geometry settings')
    values={}
    for key,default in DEFAULTS.items():
        chosen=fallbacks.get(key)
        if chosen is None:chosen=default
        for name in ('DRAWING_GEOMETRY_'+key.upper(),'DRAWING_VLM_'+key.upper()):
            if name in os.environ:
                try:chosen=TYPES[key](os.environ[name])
                except (TypeError,ValueError):raise ValueError(name+' has an invalid configuration type') from None
                break
        values[key]=chosen
    chosen_model=os.environ['DRAWING_VLM_MODEL'] if 'DRAWING_VLM_MODEL' in os.environ else model
    config=Config.from_env(chosen_model,json_mode=True,**values)
    config.validate()
    return config


def add_cli_arguments(parser,prefix=''):
    """CLI settings are fallbacks; existing server environment remains authoritative."""
    for key in DEFAULTS:
        options={'dest':prefix.replace('-','_')+key,'default':None,'type':TYPES[key],
                 'help':'Server-only fallback; DRAWING_GEOMETRY_* / existing DRAWING_VLM_* environment takes precedence'}
        if key=='thinking_mode':options['choices']=('disabled','enabled')
        parser.add_argument('--'+prefix+key.replace('_','-'),**options)


def cli_options(namespace,prefix=''):
    return {key:getattr(namespace,prefix.replace('-','_')+key) for key in DEFAULTS}


def public_settings(config):
    return {'timeout_seconds':config.timeout,'output_token_limit':config.max_tokens,
            'thinking_mode':config.thinking_mode,'thinking_budget':config.thinking_budget,
            'max_images':config.max_images,'max_edge':config.max_edge,
            'configured_only_not_connectivity_verified':True}
