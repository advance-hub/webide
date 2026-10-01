"""Read bounded Maven XML metadata without resolving external entities or running Maven."""
import json
import os
import pathlib
import sys
import xml.etree.ElementTree as ET


def document(file):
    if file.stat().st_size > 1024 * 1024:
        raise ValueError('Maven XML 超过 1 MiB')
    data = file.read_bytes()
    if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
        raise ValueError('Maven XML 不支持实体声明')
    root = ET.fromstring(data)
    for element in root.iter():
        element.tag = element.tag.rsplit('}', 1)[-1]
    return root


project = pathlib.Path(sys.argv[1]).resolve()
pom = pathlib.Path(sys.argv[2]).resolve()
settings = pathlib.Path(sys.argv[3])
result = {'modules': [], 'profiles': [], 'mirrors': [], 'repositories': [], 'secrets': []}
seen = set()


def inspect(file):
    file = file.resolve()
    file.relative_to(project)
    if file in seen:
        return
    if len(seen) >= 200:
        raise ValueError('Maven 模块超过 200 个，请选择子项目 POM')
    seen.add(file)
    root = document(file)
    for profile in root.findall('./profiles/profile/id'):
        if profile.text and profile.text not in result['profiles']:
            result['profiles'].append(profile.text)
    for module in root.findall('./modules/module'):
        if not module.text:
            continue
        child = (file.parent / module.text.strip()).resolve()
        if child.suffix != '.xml':
            child = child / 'pom.xml'
        child.relative_to(project)
        if child.is_file():
            result['modules'].append(os.path.relpath(child.parent, pom.parent))
            inspect(child)


if pom.is_file():
    inspect(pom)
if settings.is_file():
    root = document(settings)
    for profile in root.findall('./profiles/profile/id'):
        if profile.text and profile.text not in result['profiles']:
            result['profiles'].append(profile.text)
    for mirror in root.findall('./mirrors/mirror'):
        result['mirrors'].append({'id': mirror.findtext('id', ''), 'mirrorOf': mirror.findtext('mirrorOf', '')})
    for repo in root.findall('./profiles/profile/repositories/repository/id'):
        if repo.text:
            result['repositories'].append(repo.text)
    for item in root.iter():
        if item.tag in ('password', 'passphrase', 'username') and item.text:
            result['secrets'].append(item.text)
print(json.dumps(result))
