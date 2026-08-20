/**
 * The public PDF option contract.
 *
 * This file owns three things that must never drift apart:
 *   1. the TypeScript shape,
 *   2. the JSON schema the API validates against,
 *   3. the translation into Gotenberg form fields.
 */

export const PAPER_FORMATS = {
  // width x height, in inches - Gotenberg's native unit.
  A3: [11.7, 16.54],
  A4: [8.27, 11.7],
  A5: [5.83, 8.27],
  Letter: [8.5, 11],
  Legal: [8.5, 14],
  Tabloid: [11, 17],
  Ledger: [17, 11],
} as const;

export type PaperFormat = keyof typeof PAPER_FORMATS;

/** A number means inches; a string may carry an explicit unit (e.g. "210mm"). */
export type Dimension = number | string;

export interface PdfOptions {
  format?: PaperFormat;
  paperWidth?: Dimension;
  paperHeight?: Dimension;
  margin?: {
    top?: Dimension;
    right?: Dimension;
    bottom?: Dimension;
    left?: Dimension;
  };
  landscape?: boolean;
  printBackground?: boolean;
  omitBackground?: boolean;
  preferCssPageSize?: boolean;
  singlePage?: boolean;
  scale?: number;
  pageRanges?: string;
  emulatedMediaType?: 'print' | 'screen';
  waitDelayMs?: number;
  waitForExpression?: string;
  skipNetworkIdleEvent?: boolean;
  failOnConsoleExceptions?: boolean;
  failOnHttpStatusCodes?: number[];
  generateDocumentOutline?: boolean;
  generateTaggedPdf?: boolean;
  headerHtml?: string;
  footerHtml?: string;
  metadata?: Record<string, string | number | boolean>;
}

const DIMENSION_SCHEMA = {
  anyOf: [
    { type: 'number', minimum: 0, maximum: 200 },
    { type: 'string', pattern: '^[0-9]+(\\.[0-9]+)?(in|cm|mm|pt|pc|px)$' },
  ],
} as const;

export const PDF_OPTIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    format: { type: 'string', enum: Object.keys(PAPER_FORMATS) },
    paperWidth: DIMENSION_SCHEMA,
    paperHeight: DIMENSION_SCHEMA,
    margin: {
      type: 'object',
      additionalProperties: false,
      properties: {
        top: DIMENSION_SCHEMA,
        right: DIMENSION_SCHEMA,
        bottom: DIMENSION_SCHEMA,
        left: DIMENSION_SCHEMA,
      },
    },
    landscape: { type: 'boolean' },
    printBackground: { type: 'boolean' },
    omitBackground: { type: 'boolean' },
    preferCssPageSize: { type: 'boolean' },
    singlePage: { type: 'boolean' },
    scale: { type: 'number', minimum: 0.1, maximum: 2 },
    pageRanges: { type: 'string', maxLength: 100, pattern: '^[0-9,\\- ]*$' },
    emulatedMediaType: { type: 'string', enum: ['print', 'screen'] },
    waitDelayMs: { type: 'integer', minimum: 0, maximum: 15000 },
    waitForExpression: { type: 'string', maxLength: 2000 },
    skipNetworkIdleEvent: { type: 'boolean' },
    failOnConsoleExceptions: { type: 'boolean' },
    failOnHttpStatusCodes: {
      type: 'array',
      maxItems: 20,
      items: { type: 'integer', minimum: 100, maximum: 599 },
    },
    generateDocumentOutline: { type: 'boolean' },
    generateTaggedPdf: { type: 'boolean' },
    headerHtml: { type: 'string', maxLength: 100_000 },
    footerHtml: { type: 'string', maxLength: 100_000 },
    metadata: {
      type: 'object',
      maxProperties: 20,
      additionalProperties: {
        anyOf: [{ type: 'string', maxLength: 500 }, { type: 'number' }, { type: 'boolean' }],
      },
    },
  },
} as const;

/** Applied when the client says nothing: A4, backgrounds on, print media. */
export const DEFAULT_OPTIONS: PdfOptions = {
  format: 'A4',
  printBackground: true,
  emulatedMediaType: 'print',
};

export function withDefaults(options: PdfOptions | undefined): PdfOptions {
  return { ...DEFAULT_OPTIONS, ...(options ?? {}) };
}

function dimension(value: Dimension): string {
  return typeof value === 'number' ? String(value) : value;
}

export interface GotenbergForm {
  /** Plain multipart fields. */
  fields: Array<[string, string]>;
  /** Extra multipart files, keyed by the filename Gotenberg expects. */
  files: Array<{ filename: string; content: string; contentType: string }>;
}

/**
 * Translates our options into Gotenberg's Chromium `convert/html` form.
 * Only fields the client actually set are sent, so Gotenberg's own defaults
 * stay in force for everything else.
 */
export function toGotenbergForm(options: PdfOptions): GotenbergForm {
  const fields: Array<[string, string]> = [];
  const files: GotenbergForm['files'] = [];
  const push = (name: string, value: string | number | boolean): void => {
    fields.push([name, String(value)]);
  };

  const preset = options.format ? PAPER_FORMATS[options.format] : undefined;
  const width = options.paperWidth ?? preset?.[0];
  const height = options.paperHeight ?? preset?.[1];
  if (width !== undefined) push('paperWidth', dimension(width));
  if (height !== undefined) push('paperHeight', dimension(height));

  if (options.margin) {
    const { top, right, bottom, left } = options.margin;
    if (top !== undefined) push('marginTop', dimension(top));
    if (right !== undefined) push('marginRight', dimension(right));
    if (bottom !== undefined) push('marginBottom', dimension(bottom));
    if (left !== undefined) push('marginLeft', dimension(left));
  }

  if (options.landscape !== undefined) push('landscape', options.landscape);
  if (options.printBackground !== undefined) push('printBackground', options.printBackground);
  if (options.omitBackground !== undefined) push('omitBackground', options.omitBackground);
  if (options.preferCssPageSize !== undefined) push('preferCssPageSize', options.preferCssPageSize);
  if (options.singlePage !== undefined) push('singlePage', options.singlePage);
  if (options.scale !== undefined) push('scale', options.scale);
  if (options.pageRanges) push('nativePageRanges', options.pageRanges);
  if (options.emulatedMediaType) push('emulatedMediaType', options.emulatedMediaType);
  if (options.waitDelayMs !== undefined) push('waitDelay', `${options.waitDelayMs}ms`);
  if (options.waitForExpression) push('waitForExpression', options.waitForExpression);
  if (options.skipNetworkIdleEvent !== undefined) {
    push('skipNetworkIdleEvent', options.skipNetworkIdleEvent);
  }
  if (options.failOnConsoleExceptions !== undefined) {
    push('failOnConsoleExceptions', options.failOnConsoleExceptions);
  }
  if (options.failOnHttpStatusCodes?.length) {
    push('failOnHttpStatusCodes', JSON.stringify(options.failOnHttpStatusCodes));
  }
  if (options.generateDocumentOutline !== undefined) {
    push('generateDocumentOutline', options.generateDocumentOutline);
  }
  if (options.generateTaggedPdf !== undefined) push('generateTaggedPdf', options.generateTaggedPdf);
  if (options.metadata && Object.keys(options.metadata).length > 0) {
    push('metadata', JSON.stringify(options.metadata));
  }

  // Gotenberg picks these up by filename, not by form field name.
  if (options.headerHtml) {
    files.push({ filename: 'header.html', content: options.headerHtml, contentType: 'text/html' });
  }
  if (options.footerHtml) {
    files.push({ filename: 'footer.html', content: options.footerHtml, contentType: 'text/html' });
  }

  return { fields, files };
}
