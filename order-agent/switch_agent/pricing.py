"""Standard API price estimates; no exchange-rate or invoice assumptions."""
from functools import lru_cache
import json
from pathlib import Path


@lru_cache(maxsize=1)
def catalog():
    return json.loads((Path(__file__).parents[1] / 'data/model-pricing.json').read_text())


def number(obj, key):
    value = getattr(obj,key,0)
    return value if isinstance(value,int) and value >= 0 else 0


def estimate(usage, model):
    config = catalog()['models'].get(model)
    if config is None: return None
    if 'audio' not in config:
        # A long session can contain many short requests: price each separately.
        entries = getattr(usage,'request_usage_entries',None) or [usage]
        cost=0.0
        for entry in entries:
            inputs, outputs = number(entry,'input_tokens'), number(entry,'output_tokens')
            details=getattr(entry,'input_tokens_details',None)
            cached=min(inputs,number(details,'cached_tokens'))
            writes=min(inputs-cached,number(details,'cache_write_tokens'))
            rates=config['text']
            long = inputs > config.get('long_context_threshold',float('inf'))
            factor=config.get('long_input_multiplier',1) if long else 1
            out_factor=config.get('long_output_multiplier',1) if long else 1
            cost += ((inputs-cached-writes)*rates['input'] + cached*rates['cached_input'] + writes*rates.get('cache_write',rates['input']))*factor + outputs*rates['output']*out_factor
        return cost/1_000_000
    details=getattr(usage,'input_token_details',None)
    output=getattr(usage,'output_token_details',None)
    if number(details,'image_tokens'): return None
    inputs, outputs=number(usage,'input_tokens'),number(usage,'output_tokens')
    input_audio=number(details,'audio_tokens')
    input_text=number(details,'text_tokens')
    # This service sends text only. Missing text counts can be derived if no
    # audio or image inputs were reported; output modality must be explicit.
    if input_text+input_audio != inputs:
        if input_audio: return None
        input_text=inputs
    output_text,output_audio=number(output,'text_tokens'),number(output,'audio_tokens')
    if output_text+output_audio != outputs: return None
    cached_details=getattr(details,'cached_tokens_details',None)
    cached_text=number(cached_details,'text_tokens')
    cached_audio=number(cached_details,'audio_tokens')
    cached=number(details,'cached_tokens')
    if cached_text+cached_audio != cached:
        if input_audio: return None
        cached_text=cached
    if cached_text > input_text or cached_audio > input_audio: return None
    cost=0.0
    for kind,inc,out,c in [('text',input_text,output_text,cached_text),('audio',input_audio,output_audio,cached_audio)]:
        rates=config[kind]
        cost+=(inc-c)*rates['input']+c*rates['cached_input']+out*rates['output']
    return cost/1_000_000
