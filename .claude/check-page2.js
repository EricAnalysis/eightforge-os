// Quick page 2 check - minimal dependencies
const fs = require('fs');
const path = require('path');

// Load env
const envPath = path.join(__dirname, '..', '.env.local');
const envLines = fs.readFileSync(envPath, 'utf-8').split('\n');
const env = {};
envLines.forEach(line => {
  const [k, v] = line.split('=');
  if (k && v) env[k] = v;
});

// Direct Supabase call
const https = require('https');

function makeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: env.NEXT_PUBLIC_SUPABASE_URL.replace('https://', ''),
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': env.SUPABASE_SERVICE_ROLE_KEY
      },
      timeout: 10000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function check() {
  console.log('Fetching extraction...');
  const extractionId = '625fb21c-2755-4c58-b92d-a74beaf2c5fa';
  
  const result = await makeRequest('GET', `/rest/v1/document_extractions?id=eq.${extractionId}&select=data`);
  
  if (!Array.isArray(result) || result.length === 0) {
    console.log('No extraction found');
    process.exit(1);
  }

  const extraction = result[0];
  const data = extraction.data || {};
  
  // Get page 2
  let page2Text = null;
  
  if (data.content_layers_v1?.pdf?.text?.pages) {
    const page2 = data.content_layers_v1.pdf.text.pages.find(p => p.page_number === 2);
    if (page2) {
      page2Text = (page2.text || '') + (page2.plain_text_blocks?.map(b => b.text || '').join('\n') || '');
    }
  }

  if (!page2Text && data.extraction?.evidence_v1?.page_text) {
    const page2 = data.extraction.evidence_v1.page_text.find(p => p.page_number === 2);
    if (page2) {
      page2Text = page2.text || '';
    }
  }

  console.log('\n=== PAGE 2 TEXT ===\n');
  console.log(page2Text || 'NOT FOUND');
  
  // Quick search
  console.log('\n=== TERM CLAUSE SEARCH ===');
  if (page2Text) {
    const has90 = /90\s+days/i.test(page2Text);
    const hasNinety = /ninety\s+days/i.test(page2Text);
    const hasExecuted = /fully\s+executed/i.test(page2Text);
    const hasDaysFrom = /\d+\s+days?\s+from/i.test(page2Text);
    
    console.log('90 days:', has90 ? 'YES' : 'NO');
    console.log('ninety days:', hasNinety ? 'YES' : 'NO');
    console.log('fully executed:', hasExecuted ? 'YES' : 'NO');
    console.log('N days from:', hasDaysFrom ? 'YES' : 'NO');
  }
}

check().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
