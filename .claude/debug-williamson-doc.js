// Check document processing status and extraction mode
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

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const admin = createClient(supabaseUrl, serviceRoleKey);

async function debugDoc() {
  const williamsonId = '025d21e5-70e8-430d-aa0d-33425e03a5ec';

  // Get document details
  const { data: doc, error: docError } = await admin
    .from('documents')
    .select('*')
    .eq('id', williamsonId)
    .single();

  if (docError) {
    console.error('Error fetching document:', docError);
    process.exit(1);
  }

  console.log('=== Document Details ===\n');
  console.log('ID:', doc.id);
  console.log('Title:', doc.title);
  console.log('Document Type:', doc.document_type);
  console.log('Status:', doc.status);
  console.log('Processing Status:', doc.processing_status);
  console.log('Processed At:', doc.processed_at);
  console.log('Storage Path:', doc.storage_path);
  console.log('Intelligence Trace:', doc.intelligence_trace);

  console.log('\n=== Latest Extraction Details ===\n');

  // Get the newest extraction
  const { data: extractionRows } = await admin
    .from('document_extractions')
    .select('*')
    .eq('document_id', williamsonId)
    .is('field_key', null)
    .order('created_at', { ascending: false })
    .limit(1);

  const newest = extractionRows[0];

  if (newest) {
    console.log('Extraction ID:', newest.id);
    console.log('Created:', newest.created_at);
    console.log('Source:', newest.data?.source);
    console.log('Status:', newest.data?.status);

    // Check what's in the extraction data
    const exData = newest.data?.extraction || {};
    console.log('\nExtraction object keys:', Object.keys(exData).join(', '));

    // Check for evidence_v1
    if (exData.evidence_v1) {
      const ev1 = exData.evidence_v1;
      console.log('\nevidence_v1 keys:', Object.keys(ev1).join(', '));
      console.log('  page_text:', Array.isArray(ev1.page_text) ? `${ev1.page_text.length} items` : 'not array');
      console.log('  structured_fields:', !!ev1.structured_fields);
      console.log('  section_signals:', !!ev1.section_signals);
    }

    // Check for text_preview
    if (exData.text_preview) {
      console.log('\ntext_preview length:', exData.text_preview.length);
      console.log('First 200 chars:\n', exData.text_preview.substring(0, 200));
    }

    // Check document_type to understand which extraction path should be used
    console.log('\n=== Extraction Path Analysis ===\n');
    console.log('Document type:', doc.document_type);

    // From documentExtraction.ts line 1219:
    // const isContractLike = (docType) => docType && docType.toLowerCase().includes('contract');
    const isContractLike = doc.document_type && doc.document_type.toLowerCase().includes('contract');
    console.log('Is contract-like:', isContractLike);
    console.log('Should use extractContractPageTextViaOcr:', isContractLike ? 'YES' : 'NO');

    // Check if OCR extraction captured pages
    if (exData.evidence_v1?.page_text) {
      const pages = exData.evidence_v1.page_text;
      console.log('\nOCR pages captured:');
      pages.forEach(page => {
        const text = page.text || '';
        console.log(`  Page ${page.page_number}: ${text.length} chars`);
      });
    } else {
      console.log('\n✗ No OCR pages in evidence_v1.page_text');
    }
  }
}

debugDoc().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
