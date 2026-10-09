import { sha256Hex } from '@/lib/extraction/domain/hash';
import { buildRulingLineInput, type RulingLineInput } from '@/lib/extraction/pdf/rulingLineEvidence';
import type { OcrGeometryPage } from '@/lib/extraction/pdf/ocrGeometryLayout';
/** Use the already-rendered, exact OCR input. No re-render, re-OCR or identity migration. */
export async function buildRulingLineInputsFromRenders(input: {
    sourceBytes: ArrayBuffer;
    renders: readonly {
        page_number: number;
        png_buffer: Buffer;
        render_sha256: string;
        width: number;
        height: number;
    }[];
    ocrPages: readonly OcrGeometryPage[];
}): Promise<RulingLineInput[]> {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const sourceSha256 = sha256Hex(input.sourceBytes);
    const result: RulingLineInput[] = [];
    for (const render of input.renders) {
        const page = input.ocrPages.find((page) => page.page_number === render.page_number);
        if (!page?.words.length || page.width !== render.width || page.height !== render.height
            || page.representation_key !== `tesseract:eng:psm11:pdfjs-scale2:${render.render_sha256}`
            || sha256Hex(render.png_buffer) !== render.render_sha256)
            continue;
        const image = await loadImage(render.png_buffer);
        if (image.width !== render.width || image.height !== render.height)
            continue;
        const canvas = createCanvas(image.width, image.height), context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        const built = buildRulingLineInput({ sourceSha256, renderSha256: render.render_sha256,
            physicalPageNumber: render.page_number, width: image.width, height: image.height,
            tokenGeometry: page.words,
            rgba: context.getImageData(0, 0, image.width, image.height).data });
        // Ownership needs a grid; a page without one is never changed by this layer.
        // Dropping it here keeps a long scanned document from holding a full-page
        // ink mask for every unruled page.
        if (built.evidence.grids.length > 0)
            result.push(built);
    }
    return result;
}
