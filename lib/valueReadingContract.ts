/**
 * The Forgewing value-reading provider contract (B4.3-B4.5): execution
 * constants, the structured output schema, and the provider port. Pure, with
 * no imports, so both sides can share one definition: the engine
 * (lib/server/valueReadingEngine.ts), which decides whether a provider may be
 * called, and the provider adapter in the Forgewing runtime, which may not
 * reach any server, persistence or authority module.
 */

export const VALUE_READING_EXECUTION = Object.freeze({
  timeoutMs: 8000,
  maxOutputTokens: 300,
  promptTemplateId: 'forgewing-priced-value-reading',
  promptTemplateVersion: 'v1',
  outputSchemaVersion: 'value_reading_output_v2',
  cropRenderer: 'value_reading_region_crop_v1',
  /** Render scale over canonical_v1 points (pdf.js viewport scale 1): 216 dpi. */
  cropScale: 3,
  /** Margin around the line's own boxes, in canonical points, so no glyph is clipped. */
  cropPaddingPoints: 6,
  /** A single priced line never needs more; a larger crop fails closed rather than send a page. */
  cropMaxWidthPx: 2600,
  cropMaxHeightPx: 1000,
  /** Context around the target line, never the whole page. */
  maxNeighbouringLines: 6,
});

export type ValueReadingTextExcerpts = Readonly<{
  targetLineText: string;
  neighbouringLineTexts: readonly string[];
}>;

export type ValueReadingRegionImage = Readonly<{ mediaType: 'image/png' | 'image/jpeg'; bytes: Uint8Array }>;

export type ValueReadingProviderRequest = Readonly<{
  requestDigestSha256: string;
  /** SHA-256 of `image.bytes`. A provider adapter must refuse an image that does not match. */
  renderDigestSha256: string;
  model: string | null;
  timeoutMs: number;
  maxOutputTokens: number;
  promptTemplateId: string;
  promptTemplateVersion: string;
  outputSchemaVersion: string;
  image: ValueReadingRegionImage;
  /** Present only when text excerpts are requested and approved. */
  textExcerpts: ValueReadingTextExcerpts | null;
}>;

/** The provider port. Returns the raw structured output text. */
export type ValueReadingProvider = Readonly<{
  providerModel: string | null;
  read(request: ValueReadingProviderRequest, signal: AbortSignal): Promise<string>;
}>;

/**
 * The provider's structured-output schema (value_reading_output_v2). One flat
 * object, every field required: a root-level union is not a documented
 * structured-output shape, so an unreadable reading carries null value fields
 * instead. Every object sets additionalProperties false, as the API requires.
 */
export const VALUE_READING_OUTPUT_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['reading', 'description', 'unit_type', 'rate_amount', 'category', 'rationale'],
  properties: {
    reading: { type: 'string', enum: ['value', 'unreadable'] },
    description: { type: ['string', 'null'] },
    unit_type: { type: ['string', 'null'] },
    rate_amount: { type: ['number', 'null'] },
    category: { type: ['string', 'null'] },
    rationale: { type: 'string' },
  },
} as const);
