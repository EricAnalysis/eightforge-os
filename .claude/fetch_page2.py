#!/usr/bin/env python3
import json
import os
import urllib.request
import ssl

# Load .env.local
env = {}
with open('../.env.local', 'r') as f:
    for line in f:
        if '=' in line:
            k, v = line.strip().split('=', 1)
            env[k.strip()] = v.strip()

url = env['NEXT_PUBLIC_SUPABASE_URL'].rstrip('/') + '/rest/v1/document_extractions'
params = '?id=eq.625fb21c-2755-4c58-b92d-a74beaf2c5fa&select=data'
full_url = url + params

headers = {
    'Authorization': f"Bearer {env['SUPABASE_SERVICE_ROLE_KEY']}",
    'apikey': env['SUPABASE_SERVICE_ROLE_KEY'],
    'Content-Type': 'application/json'
}

try:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    
    req = urllib.request.Request(full_url, headers=headers)
    with urllib.request.urlopen(req, timeout=10, context=ctx) as response:
        data = json.loads(response.read().decode())
        
    if not data or len(data) == 0:
        print("No extraction found")
        exit(1)
    
    extraction_data = data[0].get('data', {})
    
    # Get page 2
    page2_text = None
    
    if extraction_data.get('content_layers_v1', {}).get('pdf', {}).get('text', {}).get('pages'):
        pages = extraction_data['content_layers_v1']['pdf']['text']['pages']
        for page in pages:
            if page.get('page_number') == 2:
                page2_text = page.get('text', '')
                break
    
    if not page2_text and extraction_data.get('extraction', {}).get('evidence_v1', {}).get('page_text'):
        pages = extraction_data['extraction']['evidence_v1']['page_text']
        for page in pages:
            if page.get('page_number') == 2:
                page2_text = page.get('text', '')
                break
    
    if page2_text:
        print("=== PAGE 2 TEXT ===\n")
        print(page2_text)
        print("\n=== SEARCH RESULTS ===")
        
        import re
        tests = [
            ('90 days', r'90\s+days'),
            ('ninety days', r'ninety\s+days'),
            ('fully executed', r'fully\s+executed'),
            ('from the date', r'from\s+the\s+date'),
            ('of execution', r'of\s+execution'),
        ]
        
        text_lower = page2_text.lower()
        for name, pattern in tests:
            match = re.search(pattern, text_lower, re.IGNORECASE)
            if match:
                print(f"✓ {name}: FOUND at position {match.start()}")
                start = max(0, match.start() - 50)
                end = min(len(page2_text), match.end() + 50)
                print(f"  Context: ...{page2_text[start:end]}...")
            else:
                print(f"✗ {name}: NOT FOUND")
    else:
        print("Page 2 text not found in extraction")
        
except Exception as e:
    print(f"Error: {e}")
    import traceback
    traceback.print_exc()
