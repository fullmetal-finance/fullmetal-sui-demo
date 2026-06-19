/* EnokiClientError carries the real reason in `.errors[0]` / `.cause`, while its
   `.message` is only the generic "Request to Enoki API failed (status: N)". Pull
   out the specific detail + code so the client sees WHY (e.g. a move-call target
   not on the sponsorship allowlist) instead of a bare status. */
export function enokiErrorDetail(e: unknown): {
  error: string;
  code?: string;
  enokiStatus?: number;
} {
  if (e && typeof e === "object") {
    const x = e as {
      message?: string;
      code?: string;
      status?: number;
      errors?: { message?: string; code?: string }[];
      cause?: { message?: string };
    };
    const detail = x.errors?.[0]?.message ?? x.cause?.message ?? x.message;
    return {
      error: detail ?? String(e),
      code: x.errors?.[0]?.code ?? x.code,
      enokiStatus: x.status,
    };
  }
  return { error: String(e) };
}
