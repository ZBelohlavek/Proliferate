/** Types for the shared Archidekt proxy logic in _archidekt.js. */
export function archidektRequest(params: URLSearchParams): Promise<{ status: number; body: string }>;
