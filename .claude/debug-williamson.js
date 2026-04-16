// Debug script to check Williamson extraction state
const fs = require('fs');
const path = require('path');

// Load .env.local manually
const envPath = path.join(__dirname, '..', '.env.local');
const envContent = fs.readFileSync(envPath, 'utf-8');
envContent.split('\n').forEach(line => {
  const [key, value] = line.split('=');
  if (key && value) {
    process.env[key] = value;
  }
});

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing Supabase credentials');
  console.error('URL:', supabaseUrl);
  console.error('Key:', serviceRoleKey ? 'set' : 'missing');
  process.exit(1);
}

const admin = createClient(supabaseUrl, serviceRoleKey);

async function debugWilliamson() {
  const williamsonId = '025d21e5-70e8-430d-aa0d-33425e03a5ec';

  console.log('Querying extractions for Williamson document:', williamsonId);

  // Get latest extractions
  const { data: extractionRows, error: extractionError } = await admin
    .from('document_extractions')
    .select('id, created_at, data')
    .eq('document_id', williamsonId)
    .is('field_key', null)
    .order('created_at', { ascending: false })
    .limit(10);

  if (extractionError) {
    console.error('Error fetching extractions:', extractionError);
    process.exit(1);
  }

  console.log(`\n=== Found ${extractionRows.length} extraction rows ===\n`);

  // Check each row
  extractionRows.forEach((row, idx) => {
    console.log(`[${idx}] ID: ${row.id}`);
    console.log(`    Created: ${row.created_at}`);

    if (!row.data) {
      console.log(`    Data: EMPTY`);
      return;
    }

    const data = row.data;
    console.log(`    Data keys: ${Object.keys(data).join(', ')}`);

    // Check for content_layers_v1
    if (data.content_layers_v1) {
      const layers = data.content_layers_v1;
      console.log(`    ✓ Has content_layers_v1`);

      if (layers.pdf && layers.pdf.text && layers.pdf.text.pages) {
        const pages = layers.pdf.text.pages;
        console.log(`      Pages count: ${pages.length}`);

        const pageNumbers = pages.map((p, i) => {
          const pageNum = p.page_number || (i + 1);
          const hasText = p.text || p.plain_text_blocks?.some(b => b.text);
          return `${pageNum}${hasText ? '✓' : '✗'}`;
        }).join(', ');
        console.log(`      Pages: [${pageNumbers}]`);

        // Check for page 2
        const page2 = pages.find(p => p.page_number === 2);
        if (page2) {
          console.log(`      Page 2 found!`);
          const page2Text = (page2.text || '') +
            (page2.plain_text_blocks?.map(b => b.text || '').join(' ') || '');
          if (page2Text.includes('90 days')) {
            console.log(`        ✓ Contains "90 days" clause`);
          } else {
            console.log(`        ✗ Does NOT contain "90 days" clause`);
          }
        } else {
          console.log(`      ✗ Page 2 NOT found`);
        }
      } else {
        console.log(`      ✗ No content_layers_v1.pdf.text.pages`);
      }
    } else {
      console.log(`    ✗ No content_layers_v1`);
    }

    // Check for legacy evidence
    if (data.extraction && data.extraction.evidence_v1) {
      const evidence = data.extraction.evidence_v1;
      if (evidence.page_text && Array.isArray(evidence.page_text)) {
        const pageCount = evidence.page_text.length;
        const hasPage2 = evidence.page_text.some(p => p.page_number === 2);
        console.log(`    ✓ Has evidence_v1.page_text (${pageCount} pages, page 2: ${hasPage2 ? 'yes' : 'no'})`);
      }
    }

    // Check extraction.text_preview
    if (data.extraction && data.extraction.text_preview) {
      const preview = data.extraction.text_preview.substring(0, 100);
      console.log(`    ✓ Has extraction.text_preview (${data.extraction.text_preview.length} chars)`);
    }

    console.log();
  });
}

debugWilliamson().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
