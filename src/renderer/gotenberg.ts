import { AppError } from '../shared/errors.js';
import { toGotenbergForm, type PdfOptions } from '../shared/pdf-options.js';

export interface RenderRequest {
  jobId: string;
  html: string;
  options: PdfOptions;
  filename?: string | undefined;
}

export interface RenderResult {
  pdf: Buffer;
  bytes: number;
  /** Wall-clock time spent inside the Gotenberg call. */
  durationMs: number;
}

export interface GotenbergClientOptions {
  baseUrl: string;
  timeoutMs: number;
  maxPdfBytes: number;
}

/**
 * Thin client over Gotenberg's Chromium routes.
 *
 * Gotenberg is reachable only on the private Docker network, so there is no
 * auth here - the API in front of us is the security boundary.
 */
export class GotenbergClient {
  constructor(private readonly options: GotenbergClientOptions) {}

  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.options.baseUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async renderHtml(request: RenderRequest): Promise<RenderResult> {
    const form = new FormData();
    // Gotenberg identifies the entry point by filename, which must be index.html.
    form.append('files', new Blob([request.html], { type: 'text/html' }), 'index.html');

    const { fields, files } = toGotenbergForm(request.options);
    for (const file of files) {
      form.append('files', new Blob([file.content], { type: file.contentType }), file.filename);
    }
    for (const [name, value] of fields) {
      form.append(name, value);
    }

    const headers: Record<string, string> = { 'Gotenberg-Trace': request.jobId };
    if (request.filename) headers['Gotenberg-Output-Filename'] = request.filename;

    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}/forms/chromium/convert/html`, {
        method: 'POST',
        body: form,
        headers,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      throw toTransportError(error, this.options.timeoutMs);
    }

    if (!response.ok) {
      const detail = truncate(await safeText(response), 500);
      // 4xx from Gotenberg means the document or the options are wrong: retrying
      // the exact same payload cannot help.
      if (response.status >= 400 && response.status < 500) {
        throw new AppError(422, 'RENDER_REJECTED', `Gotenberg rejected the document: ${detail}`, {
          retryable: false,
          details: { gotenbergStatus: response.status },
        });
      }
      throw new AppError(502, 'RENDERER_ERROR', `Gotenberg failed to render: ${detail}`, {
        retryable: true,
        details: { gotenbergStatus: response.status },
      });
    }

    const pdf = await this.readCapped(response);
    return { pdf, bytes: pdf.byteLength, durationMs: Date.now() - startedAt };
  }

  /** Reads the PDF while enforcing the output size limit as it streams in. */
  private async readCapped(response: Response): Promise<Buffer> {
    const declared = Number(response.headers.get('content-length') ?? Number.NaN);
    if (Number.isFinite(declared) && declared > this.options.maxPdfBytes) {
      throw this.tooLarge(declared);
    }
    if (!response.body) {
      throw new AppError(502, 'RENDERER_ERROR', 'Gotenberg returned an empty response', {
        retryable: true,
      });
    }

    const chunks: Buffer[] = [];
    let total = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.options.maxPdfBytes) throw this.tooLarge(total);
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, total);
  }

  private tooLarge(bytes: number): AppError {
    return new AppError(
      413,
      'PDF_TOO_LARGE',
      `Generated PDF exceeds the ${this.options.maxPdfBytes} byte limit (at least ${bytes} bytes)`,
      { retryable: false },
    );
  }
}

function toTransportError(error: unknown, timeoutMs: number): AppError {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new AppError(504, 'RENDER_TIMEOUT', `Rendering exceeded ${timeoutMs}ms`, {
      retryable: true,
      cause: error,
    });
  }
  return new AppError(503, 'RENDERER_UNAVAILABLE', 'Could not reach Gotenberg', {
    retryable: true,
    cause: error,
  });
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return '<no response body>';
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}
