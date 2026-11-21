"""Provider-reported tokens only. Audio and dialogue are separate counters."""
KEYS = ('input_tokens', 'output_tokens', 'total_tokens', 'cached_input_tokens', 'requests', 'estimated_cost_usd', 'unpriced_requests')


def empty():
    return {**dict.fromkeys(KEYS, 0), 'unreported_requests': 0}


def counts(usage, model=None):
    if usage is None:
        return {**empty(), 'unreported_requests': 1}
    def number(value): return value if isinstance(value, int) and value >= 0 else 0
    details = getattr(usage, 'input_tokens_details', None) or getattr(usage, 'input_token_details', None)
    from .pricing import estimate
    cost = estimate(usage,model) if model else None
    return {'estimated_cost_usd':cost if cost is not None else 0.0, 'unpriced_requests':0 if cost is not None else 1, 'input_tokens': number(getattr(usage,'input_tokens',0)),
            'output_tokens': number(getattr(usage,'output_tokens',0)),
            'total_tokens': number(getattr(usage,'total_tokens',0)),
            'cached_input_tokens': number(getattr(details,'cached_tokens',0)),
            'requests': number(getattr(usage,'requests',1)), 'unreported_requests': 0}


def add(target, incoming):
    for key in (*KEYS, 'unreported_requests'):
        target[key] = target.get(key,0) + incoming.get(key,0)
    return target
