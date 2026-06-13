// Extract and display page 2 text from newest Williamson
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env.local');
const envContent = fs.readFileSync(envPath, 'utf-8');
envContent.split('\n').forEach(line => {
  const [key, value] = line.split('=');
  if (key && value) {
    process.env[key] = value;
  }
});

const { createClient } = require('@supabase/supabase-js');
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function debugPage2() {
  const newWilliamsonId = '98cb8f26-1153-4dcb-afcf-86921f94a28a';
  
  // Get newest extraction
  const { data: extractionRows } = await admin
    .from('document_extractions')
    .select('*')
    .eq('document_id', newWilliamsonId)
    .is('field_key', null)
    .order('created_at', { ascending: false })
    .limit(1);

  if (!extractionRows || !extractionRows[0]) {
    console.log('No extractions found');
    process.exit(1);
  }

  const extraction = extractionRows[0];
  console.log('Extraction ID:', extraction.id);
  console.log('Created:', extraction.created_at);
  console.log('Data keys:', Object.keys(extraction.data || {}).join(', '));

  const data = extraction.data || {};
  
  // Try content_layers_v1 first
  let page2Text = null;
  let source = null;

  if (data.content_layers_v1?.pdf?.text?.pages) {
    const pages = data.content_layers_v1.pdf.text.pages;
    const page2 = pages.find(p => p.page_number === 2);
    if (page2) {
      page2Text = (page2.text || '') + 
                  (page2.plain_text_blocks?.map(b => b.text || '').join('\n') || '');
      source = 'content_layers_v1.pdf.text.pages[1]';
    }
  }

  // Fallback to evidence_v1
  if (!page2Text && data.extraction?.evidence_v1?.page_text) {
    const pages = data.extraction.evidence_v1.page_text;
    const page2 = pages.find(p => p.page_number === 2);
    if (page2) {
      page2Text = page2.text || '';
      source = 'evidence_v1.page_text[1]';
    }
  }

  if (!page2Text) {
    console.log('\n✗ NO PAGE 2 TEXT FOUND');
    process.exit(1);
  }

  console.log('\n=== PAGE 2 TEXT ===');
  console.log(`Source: ${source}`);
  console.log(`Length: ${page2Text.length} chars\n`);
  console.log(page2Text);

  // Search for term clause
  console.log('\n=== TERM CLAUSE SEARCH ===\n');
  
  const queries = [
    { pattern: /90\s+days/i, name: '90 days' },
    { pattern: /ninety\s+days/i, name: 'ninety days' },
    { pattern: /fully\s+executed/i, name: 'fully executed' },
    { pattern: /\d+\s+days?\s+from/i, name: 'N days from' },
    { pattern: /from\s+the\s+execution/i, name: 'from the execution' },
    { pattern: /from\s+the\s+date/i, name: 'from the date' },
  ];

  let clauseFound = false;
  queries.forEach(({ pattern, name }) => {
    const match = page2Text.match(pattern);
    if (match) {
      console.log(`✓ Found: "${name}"`);
      console.log(`  Match: "${match[0]}"`);
      
      // Get surrounding context (100 chars before and after)
      const idx = page2Text.indexOf(match[0]);
      const start = Math.max(0, idx - 100);
      const end = Math.min(page2Text.length, idx + match[0].length + 100);
      const context = page2Text.substring(start, end);
      console.log(`  Context: ...${context}...`);
      clauseFound = true;
    } else {
      console.log(`✗ NOT found: "${name}"`);
    }
  });

  console.log(`\n=== RESULT ===`);
  console.log(`Clause present: ${clauseFound ? 'YES' : 'NO'}`);
}

debugPage2().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
