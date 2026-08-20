import { z } from "zod";
import { env } from "../config/env.js";

export const pdfOptionsSchema = z
  .object({
    paperWidth: z.number().positive().optional(),
    paperHeight: z.number().positive().optional(),
    marginTop: z.number().nonnegative().optional(),
    marginBottom: z.number().nonnegative().optional(),
    marginLeft: z.number().nonnegative().optional(),
    marginRight: z.number().nonnegative().optional(),
    landscape: z.boolean().optional(),
    printBackground: z.boolean().optional(),
    preferCssPageSize: z.boolean().optional(),
    scale: z.number().positive().optional(),
    nativePageRanges: z.string().optional(),
  })
  .strict();

export type PdfRenderOptions = z.infer<typeof pdfOptionsSchema>;

export class GotenbergError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GotenbergError";
  }
}

export class GotenbergTimeoutError extends GotenbergError {
  constructor(message: string) {
    super(message);
    this.name = "GotenbergTimeoutError";
  }
}

export async function renderHtmlToPdf(
  html: string,
  options: PdfRenderOptions = {},
  opts: { timeoutMs?: number } = {},
): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? env.RENDER_TIMEOUT_MS;

  const form = new FormData();
  form.append("files", new Blob([html], { type: "text/html" }), "index.html");

  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    form.append(key, String(value));
  }

  let response: Response;
  try {
    response = await fetch(`${env.GOTENBERG_URL}/forms/chromium/convert/html`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new GotenbergTimeoutError(`Gotenberg render timed out after ${timeoutMs}ms`);
    }
    throw new GotenbergError(`Failed to reach Gotenberg: ${(err as Error).message}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new GotenbergError(
      `Gotenberg returned ${response.status}: ${body.slice(0, 500)}`,
      response.status,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
