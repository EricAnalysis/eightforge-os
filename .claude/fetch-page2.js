const fs = require('fs');
const path = require('path');

// Load env
const envPath = path.join(__dirname, '..', '.env.local');
const envContent = fs.readFileSync(envPath, 'utf-8');
const env = {};
envContent.split('\n').forEach(line => {
  const [key, value] = line.split('=');
  if (key?.trim() && value?.trim()) {
    env[key.trim()] = value.trim();
  }
});

const { createClient } = require('@supabase/supabase-js');

async function fetch() {
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  
  const { data, error } = await admin
    .from('document_extractions')
    .select('data')
    .eq('id', '625fb21c-2755-4c58-b92d-a74beaf2c5fa')
    .single();

  if (error) {
    fs.writeFileSync('/tmp/page2-error.txt', `Error: ${error.message}`);
    process.exit(1);
  }

  const extractionData = data?.data || {};
  
  let page2Text = null;
  
  if (extractionData.content_layers_v1?.pdf?.text?.pages) {
    const page2 = extractionData.content_layers_v1.pdf.text.pages.find(p => p.page_number === 2);
    if (page2) {
      page2Text = (page2.text || '') + (page2.plain_text_blocks?.map(b => b.text || '').join('\n') || '');
    }
  }

  if (!page2Text && extractionData.extraction?.evidence_v1?.page_text) {
    const page2 = extractionData.extraction.evidence_v1.page_text.find(p => p.page_number === 2);
    if (page2) {
      page2Text = page2.text || '';
    }
  }

  fs.writeFileSync('/tmp/page2.txt', page2Text || 'NOT FOUND');
  console.log('Page 2 written to /tmp/page2.txt');
}

fetch().catch(err => {
  fs.writeFileSync('/tmp/page2-error.txt', err.message);
  process.exit(1);
});
