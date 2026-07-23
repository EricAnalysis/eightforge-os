import { hashCanonical } from '@/lib/extraction/domain/hash';

export interface VersionedComponent {
  readonly name: string;
  readonly version: string;
  readonly configuration_hash: string;
}

export interface ParserManifest {
  readonly artifact_schema_version: string;
  readonly renderer: VersionedComponent;
  readonly native_pdf_extractor: VersionedComponent;
  readonly ocr: VersionedComponent;
  readonly partition: VersionedComponent | null;
  readonly layout: VersionedComponent;
  readonly region_arbitration: VersionedComponent;
  readonly table_parser: VersionedComponent;
  readonly vision: VersionedComponent | null;
  readonly typed_ai: VersionedComponent | null;
  readonly primitive_normalizers: readonly VersionedComponent[];
  readonly verification_policy: VersionedComponent;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function assertComponent(component: VersionedComponent, label: string): void {
  if (!component.name.trim() || !component.version.trim()) {
    throw new Error(`Parser manifest component ${label} requires name and version.`);
  }
  if (!SHA256_PATTERN.test(component.configuration_hash)) {
    throw new Error(`Parser manifest component ${label} requires a SHA-256 configuration hash.`);
  }
}

export function hashParserManifest(manifest: ParserManifest): string {
  if (!manifest.artifact_schema_version.trim()) {
    throw new Error('Parser manifest requires artifact_schema_version.');
  }
  const components: Array<[string, VersionedComponent | null]> = [
    ['renderer', manifest.renderer],
    ['native_pdf_extractor', manifest.native_pdf_extractor],
    ['ocr', manifest.ocr],
    ['partition', manifest.partition],
    ['layout', manifest.layout],
    ['region_arbitration', manifest.region_arbitration],
    ['table_parser', manifest.table_parser],
    ['vision', manifest.vision],
    ['typed_ai', manifest.typed_ai],
    ['verification_policy', manifest.verification_policy],
  ];
  for (const [label, component] of components) {
    if (component) assertComponent(component, label);
  }
  if (manifest.primitive_normalizers.length === 0) {
    throw new Error('Parser manifest requires at least one primitive normalizer.');
  }
  manifest.primitive_normalizers.forEach((component, index) => {
    assertComponent(component, `primitive_normalizers[${index}]`);
  });
  return hashCanonical(manifest);
}

function component(name: string, version: string, configuration: unknown): VersionedComponent {
  return {
    name,
    version,
    configuration_hash: hashCanonical(configuration),
  };
}

/**
 * This manifest identifies the legacy pipeline only for shadow publication.
 * It is permanently ineligible for freshness enforcement or live cutover.
 */
export function buildLegacyShadowParserManifest(params: {
  readonly analysisMode: string;
  readonly unstructuredEnabled: boolean;
  readonly visionEnabled: boolean;
  readonly typedAiEnabled: boolean;
  readonly implementationBuild: string;
  readonly unstructured?: {
    readonly apiUrl: string;
    readonly strategy: string;
    readonly splitConcurrency: string;
    readonly timeoutMs: number;
  };
  readonly visionModel?: string;
  readonly typedAiModel?: string;
  readonly instructorEnabled?: boolean;
  readonly instructorMaxRetries?: number;
}): ParserManifest {
  const implementationBuild = params.implementationBuild.trim();
  if (!implementationBuild) {
    throw new Error('Parser manifest requires a deterministic implementation build digest.');
  }
  return {
    artifact_schema_version: 'extraction-artifact-v1',
    renderer: component('pdfjs-renderer', '5.5.207', {
      implementation_build: implementationBuild,
      scale: 2,
      image_format: 'png',
    }),
    native_pdf_extractor: component('pdfjs-native-text', '5.5.207', {
      implementation_build: implementationBuild,
      line_y_tolerance: 2,
      max_evidence_pages: 200,
      token_sort: 'y_desc_x_asc',
    }),
    ocr: component('tesseract', '7.0.0', {
      implementation_build: implementationBuild,
      language: 'eng',
      language_asset: '@tesseract.js-data/eng@1.0.0/4.0.0',
      psm: 11,
      render_scale: 2,
      legacy_routing_preserved: true,
    }),
    partition: params.unstructuredEnabled
      ? component('unstructured-hi-res', 'legacy-api', {
          implementation_build: implementationBuild,
          api_url: params.unstructured?.apiUrl
            ?? 'https://api.unstructuredapp.io/general/v0/general',
          strategy: params.unstructured?.strategy ?? 'hi_res',
          split_pdf_page: true,
          split_pdf_allow_failed: true,
          split_pdf_concurrency: params.unstructured?.splitConcurrency ?? '8',
          starting_page_number: 1,
          pdf_infer_table_structure: true,
          timeout_ms: params.unstructured?.timeoutMs ?? 45_000,
        })
      : null,
    layout: component('legacy-pdf-layout', 'content_layers_v1', {
      implementation_build: implementationBuild,
      current_behavior_preserved: true,
    }),
    region_arbitration: component('legacy-whole-page-arbitration', 'v1', {
      implementation_build: implementationBuild,
      policy: 'native_page_wins_when_any_native_line_exists',
      current_behavior_preserved: true,
    }),
    table_parser: component('legacy-pdf-table-parser', 'v1', {
      implementation_build: implementationBuild,
      output_schema: 'PdfTable/PdfTableRow/PdfTableCell-v1',
      current_behavior_preserved: true,
    }),
    vision: params.visionEnabled
      ? component('legacy-vision-rate-table-supplement', 'v1', {
          implementation_build: implementationBuild,
          model: params.visionModel ?? 'gpt-4o',
          temperature: 0,
          image_detail: 'high',
          prompt_version: 'RATE_TABLE_PROMPT-v1',
          response_schema: [
            'description:string',
            'unit_of_measure:string',
            'origin_destination:string|null',
            'rate:string',
          ],
          fixed_headers_version: 'legacy-four-column-v1',
          fixed_confidence: 0.85,
          current_behavior_preserved: true,
        })
      : null,
    typed_ai: params.typedAiEnabled
      ? component('legacy-instructor-assist', 'v1', {
          implementation_build: implementationBuild,
          model: params.typedAiModel ?? 'gpt-4o-mini',
          instructor_enabled: params.instructorEnabled ?? true,
          max_retries: params.instructorMaxRetries ?? 2,
          analysis_mode: params.analysisMode,
          prompt_builder_version: 'instructor-extraction-assist-prompt-v1',
          system_prompt_version: 'schema-valid-only-v1',
          schema_version: 'extractionAssistEnvelopeSchema-v1',
          text_preview_limit: 8_000,
          section_header_form_limit: 12,
          extraction_confidence_trigger: 0.62,
          current_field_run_limit: 4,
          current_behavior_preserved: true,
        })
      : null,
    primitive_normalizers: [
      component('legacy-extraction-normalizers', 'v1', {
        implementation_build: implementationBuild,
        content_layer_schema: 'content_layers_v1',
        evidence_schema: 'evidence_v1',
        typed_extraction_schema: 'TypedExtraction-v1',
        current_behavior_preserved: true,
      }),
    ],
    verification_policy: component('step0-shadow-gap-policy', 'v1', {
      implementation_build: implementationBuild,
      publish_verified_fields: false,
      reason: 'legacy payload lacks complete page geometry',
    }),
  };
}
