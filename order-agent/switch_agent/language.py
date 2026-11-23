"""Display language preferences never change catalog IDs or order rules."""
from functools import lru_cache
import json
import re
from pathlib import Path

LANGUAGES = {'ko':'한국어', 'en':'English', 'zh':'简体中文', 'ja':'日本語'}

@lru_cache(maxsize=1)
def translations():
    return json.loads((Path(__file__).parents[1] / 'data/ui-translations.json').read_text())

def translate(language, text):
    if language == 'ko': return text
    exact = translations().get(text, {}).get(language)
    if exact: return exact
    for template, choices in translations().items():
        names = re.findall(r"\{(\w+)\}", template)
        if not names: continue
        pattern = re.escape(template)
        for name in names: pattern = pattern.replace(re.escape("{" + name + "}"), "(.+?)", 1)
        match = re.fullmatch(pattern, text)
        if match and language in choices:
            return choices[language].format(**dict(zip(names, match.groups())))
    return text

def formatted(language, source, **values):
    return translate(language, source).format(**values)
