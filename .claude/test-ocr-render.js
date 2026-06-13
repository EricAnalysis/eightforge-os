// Test if PDF page rendering to canvas works
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

async function testRender() {
  // Fetch the PDF
  const { data: doc } = await admin
    .from('documents')
    .select('id, storage_path')
    .eq('id', '025d21e5-70e8-430d-aa0d-33425e03a5ec')
    .single();

  const { data: fileData } = await admin.storage
    .from('documents')
    .download(doc.storage_path);

  const bytes = await fileData.arrayBuffer();
  console.log('PDF size:', bytes.byteLength);

  try {
    // Test pdfjs import
    console.log('\nTesting pdfjs import...');
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    console.log('✓ pdfjs imported');

    // Test document loading
    console.log('Testing PDF document loading...');
    const data = new Uint8Array(bytes);
    const pdfDoc = await pdfjs.getDocument({ data }).promise;
    console.log('✓ PDF loaded, pages:', pdfDoc.numPages);

    // Test canvas import
    console.log('\nTesting canvas import...');
    const { createCanvas } = await import('@napi-rs/canvas');
    console.log('✓ Canvas imported');

    // Test rendering page 1
    console.log('\nTesting page 1 render...');
    const page = await pdfDoc.getPage(1);
    console.log('✓ Page loaded');

    const viewport = page.getViewport({ scale: 2 });
    console.log('✓ Viewport created:', viewport.width, 'x', viewport.height);

    const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
    console.log('✓ Canvas created');

    const ctx = canvas.getContext('2d');
    console.log('✓ Canvas context obtained');

    const renderContext = {
      canvas: canvas,
      canvasContext: ctx,
      viewport,
    };

    console.log('Starting page render...');
    const renderTask = page.render(renderContext);
    await renderTask.promise;
    console.log('✓ Page rendered');

    // Test toBuffer
    const pngBuffer = canvas.toBuffer('image/png');
    console.log('✓ Canvas converted to PNG buffer, size:', pngBuffer.length);

    // Test if buffer has data
    if (pngBuffer.length < 100) {
      console.warn('⚠️  Warning: PNG buffer is very small, may be blank image');
    }

    // Test Tesseract
    console.log('\nTesting Tesseract...');
    const { createWorker } = await import('tesseract.js');
    const langPath = path.join(__dirname, '..', 'node_modules', '@tesseract.js-data', 'eng', '4.0.0');
    console.log('Language path:', langPath);
    console.log('Exists:', fs.existsSync(langPath));

    const worker = await createWorker('eng', undefined, { langPath });
    console.log('✓ Worker created');

    const result = await worker.recognize(pngBuffer);
    console.log('✓ OCR recognition complete');
    console.log('Result text length:', result?.data?.text?.length ?? 0);
    console.log('Result text preview:', (result?.data?.text ?? '').substring(0, 200));

    await worker.terminate();
    console.log('✓ Worker terminated');

  } catch (error) {
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
  }
}

testRender();
