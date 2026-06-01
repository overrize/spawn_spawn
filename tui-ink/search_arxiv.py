#!/usr/bin/env python3
import sys, json, urllib.request, urllib.parse, xml.etree.ElementTree as ET

API_URL = 'http://export.arxiv.org/api/query?search_query={query}&start=0&max_results=10'

def fetch(query):
    url = API_URL.format(query=urllib.parse.quote(query))
    with urllib.request.urlopen(url) as f:
        data = f.read().decode('utf-8')
    ns = {'a': 'http://www.w3.org/2005/Atom'}
    root = ET.fromstring(data)
    entries = []
    for entry in root.findall('a:entry', ns):
        title = entry.find('a:title', ns).text.strip().replace('\n', ' ')
        summary = entry.find('a:summary', ns).text.strip().replace('\n', ' ')
        id_link = entry.find('a:id', ns).text.strip()
        arxiv_id = id_link.split('/')[-1]
        entries.append({
            'title': title,
            'summary': summary,
            'link': f'https://arxiv.org/abs/{arxiv_id}'
        })
    return entries

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--queries', nargs='+', required=True)
    args = parser.parse_args()
    all_entries = []
    for q in args.queries:
        try:
            entries = fetch(q)
            print(f'Query "{q}" returned {len(entries)} results', file=sys.stderr)
            all_entries.extend(entries)
        except Exception as e:
            print(f'Error querying "{q}": {e}', file=sys.stderr)
    with open(args.output, 'w') as f:
        json.dump(all_entries, f, indent=2)
    print(f'Written {len(all_entries)} entries to {args.output}', file=sys.stderr)
